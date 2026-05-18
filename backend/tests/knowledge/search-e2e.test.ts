/**
 * knowledge.search × real embedding pipeline — integration tests (M7.T5).
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY. The embeddings client is
 * replaced with a deterministic hash-based stub (same recipe as the M6.T6
 * memory recall tests) so:
 *
 *   1. Ingestion produces predictable chunk vectors.
 *   2. The tool's query-embed is also deterministic from the query text.
 *   3. Top-N kNN ordering is therefore reproducible from the test side.
 *
 * What this file does that `tests/tools/builtins.test.ts` doesn't:
 *   - Drives the FULL ingest-then-search loop end-to-end with a real markdown
 *     adapter, so it proves the M3.T6 tool wiring + the M7.T5 embedding swap
 *     compose correctly.
 *   - Asserts semantic ordering (token-overlap aware), not just monotonic
 *     distance ordering against a constant baseline.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { invokeTool, type ToolContext } from '../../src/tools/registry.js';
import '../../src/tools/index.js';
import { knowledgeSearchToolName } from '../../src/tools/builtins/index.js';
import { EmbeddingClient, __setEmbeddingClientForTests } from '../../src/llm/embeddings.js';
import { ingestSource } from '../../src/knowledge/ingest.js';
import type { IngestionAdapter } from '../../src/knowledge/adapters/types.js';
import type { IngestionSource, IngestableChunk } from '../../src/knowledge/types.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

/**
 * Deterministic hash-based embedding stub — identical to the recipe in
 * `tests/memory/recall.test.ts`. Token-overlap-aware, L2-normalised, so
 * shared-word queries land close to their target chunk.
 */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    for (let k = 0; k < 16; k++) {
      const idx = ((h + k * 2654435761) >>> 0) % 1536;
      const sign = ((h >>> (k % 16)) & 1) === 0 ? 1 : -1;
      v[idx] = (v[idx] ?? 0) + sign * (0.5 + ((h >>> (k % 8)) & 0xff) / 512);
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

class StubEmbeddingClient extends EmbeddingClient {
  public embedCalls = 0;
  public failNext = false;
  constructor() {
    super({ apiKey: 'stub', fetchImpl: (async () => ({}) as Response) as typeof fetch });
  }
  override async embed(text: string): Promise<number[]> {
    this.embedCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('stub embed failure');
    }
    return hashEmbed(text);
  }
  override async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t));
  }
}

/**
 * In-memory fixture adapter so the test owns the chunk text without touching
 * the filesystem. Three deliberately distinct chunks — they share zero
 * meaningful tokens, so the stub's token-overlap hashing produces a clear
 * winner per query.
 */
function fixtureAdapter(chunks: IngestableChunk[]): IngestionAdapter {
  return {
    id: 'fixture',
    async *ingest(_source: IngestionSource): AsyncIterable<IngestableChunk> {
      for (const c of chunks) yield c;
    },
  };
}

const FIXTURE_CHUNKS: IngestableChunk[] = [
  {
    text: 'Trottinette électrique EDPM : vitesse maximale légale 25 km/h sur la voie publique. Assurance responsabilité civile obligatoire depuis 2019.',
    sourcePath: 'trottinette-edpm',
    meta: { sectionTitle: 'Trottinette EDPM' },
  },
  {
    text: 'Voiture malus : surprime applicable après sinistres responsables, plafond légal du coefficient à 3,5 fois le tarif de base.',
    sourcePath: 'voiture-malus',
    meta: { sectionTitle: 'Voiture malus' },
  },
  {
    text: 'Lexique AGIRA : association pour la gestion des informations sur le risque automobile, fichier consulté lors de toute souscription auto en France.',
    sourcePath: 'lexique-agira',
    meta: { sectionTitle: 'Lexique AGIRA' },
  },
];

const FIXTURE_SOURCE: IngestionSource = {
  name: 'm7t5-fixture',
};

d('knowledge.search × real embedding pipeline (live pg, stub embeddings)', () => {
  let db: Database;
  let stub: StubEmbeddingClient;
  const ctx = (): ToolContext => ({
    db,
    agentRole: 'sales-agent',
    agentInstance: 'lead-test',
  });

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE knowledge_chunks RESTART IDENTITY CASCADE`);
    stub = new StubEmbeddingClient();
    __setEmbeddingClientForTests(stub);
  });

  afterEach(() => {
    __setEmbeddingClientForTests(null);
  });

  async function seedFixture(): Promise<void> {
    const result = await ingestSource(db, fixtureAdapter(FIXTURE_CHUNKS), FIXTURE_SOURCE);
    expect(result.chunksProcessed).toBe(3);
    expect(result.chunksFailed).toBe(0);
  }

  // ---------------------------------------------------------------------------
  // 1. Top-N by distance: query overlaps clearly with one chunk.
  // ---------------------------------------------------------------------------
  it('test 1: query "trottinette" returns the trottinette chunk first', async () => {
    await seedFixture();
    const hits = (await invokeTool(ctx(), knowledgeSearchToolName, {
      query: 'trottinette électrique vitesse maximale',
      limit: 3,
    })) as Array<{ chunk: string; source: string; sourcePath: string | null; distance: number }>;

    expect(hits.length).toBe(3);
    // Monotonic non-decreasing distance.
    expect(hits[0]!.distance).toBeLessThanOrEqual(hits[1]!.distance);
    expect(hits[1]!.distance).toBeLessThanOrEqual(hits[2]!.distance);
    // Top hit is the trottinette chunk.
    expect(hits[0]!.chunk).toMatch(/Trottinette/i);
    expect(hits[0]!.sourcePath).toBe('trottinette-edpm');
    // The tool actually called the embedding client (vs the pre-M7.T5 stub).
    expect(stub.embedCalls).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 2. `limit` is respected.
  // ---------------------------------------------------------------------------
  it('test 2: limit:1 returns exactly one chunk', async () => {
    await seedFixture();
    const hits = (await invokeTool(ctx(), knowledgeSearchToolName, {
      query: 'AGIRA',
      limit: 1,
    })) as Array<unknown>;
    expect(hits).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Structure check: each hit has chunk + source + sourcePath + distance.
  // ---------------------------------------------------------------------------
  it('test 3: hit shape carries chunk text + source + sourcePath + distance', async () => {
    await seedFixture();
    const hits = (await invokeTool(ctx(), knowledgeSearchToolName, {
      query: 'malus voiture surprime',
      limit: 2,
    })) as Array<{ chunk: string; source: string; sourcePath: string | null; distance: number }>;

    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(typeof h.chunk).toBe('string');
      expect(h.chunk.length).toBeGreaterThan(0);
      expect(h.source).toBe('m7t5-fixture');
      // sourcePath came through the ingest adapter, so it must be non-null
      // for these fixtures.
      expect(typeof h.sourcePath).toBe('string');
      expect(typeof h.distance).toBe('number');
      expect(h.distance).toBeGreaterThanOrEqual(0);
    }
    // Top hit is the malus chunk.
    expect(hits[0]!.chunk).toMatch(/malus/i);
  });

  // ---------------------------------------------------------------------------
  // 4. Empty corpus: returns empty results, doesn't throw.
  // ---------------------------------------------------------------------------
  it('test 4: empty knowledge_chunks table returns an empty results array', async () => {
    // No seed.
    const hits = (await invokeTool(ctx(), knowledgeSearchToolName, {
      query: 'anything at all',
      limit: 5,
    })) as Array<unknown>;
    expect(hits).toEqual([]);
    // The embedding still happened — the tool can't know up-front the table is empty.
    expect(stub.embedCalls).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 5. Input validation: query length < 2 is rejected by zod.
  // ---------------------------------------------------------------------------
  it('test 5: too-short query (length < 2) is rejected by the input schema', async () => {
    await expect(invokeTool(ctx(), knowledgeSearchToolName, { query: 'a' })).rejects.toThrow();
    // Schema rejects BEFORE the handler runs, so no embedding call happened.
    expect(stub.embedCalls).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 6. Embedding client error propagates as a tool error.
  // ---------------------------------------------------------------------------
  it('test 6: embedding client failure surfaces as a tool error', async () => {
    await seedFixture();
    stub.failNext = true;
    await expect(
      invokeTool(ctx(), knowledgeSearchToolName, { query: 'trottinette' }),
    ).rejects.toThrow(/stub embed failure/);
  });

  // ---------------------------------------------------------------------------
  // 7. Default limit fallback — omitting `limit` returns up to 5 results.
  // ---------------------------------------------------------------------------
  it('test 7: omitting limit defaults to 5 (caps the fixture at 3)', async () => {
    await seedFixture();
    const hits = (await invokeTool(ctx(), knowledgeSearchToolName, {
      query: 'assurance',
    })) as Array<unknown>;
    // Fixture has 3 chunks, default limit is 5 — so we get all 3.
    expect(hits).toHaveLength(3);
  });
});
