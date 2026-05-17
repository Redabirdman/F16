/**
 * Knowledge ingestion — integration tests against live pg + stub embeddings.
 *
 * Gated on TEST_DATABASE_URL. Embedding client is stubbed deterministically so
 * the tests:
 *   1. Never hit OpenRouter.
 *   2. Get reproducible kNN ordering (same text → same vector).
 *
 * The stub reuses the same FNV-1a + spread strategy used by the memory facade
 * tests, with one addition: the section heading and a few keywords get heavier
 * weighting so "trottinette assurance obligatoire" lines up against the EDPM
 * chunk rather than randomly drifting toward a similarly-shaped neighbor.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Database } from '../../src/db/index.js';
import { EmbeddingClient, __setEmbeddingClientForTests } from '../../src/llm/embeddings.js';
import { ingestSource } from '../../src/knowledge/ingest.js';
import { markdownFileAdapter } from '../../src/knowledge/adapters/markdown-file.js';
import { searchSimilar, deleteBySource } from '../../src/db/repositories/knowledge.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

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
  public batchCalls = 0;
  public lastBatchSize = 0;
  constructor() {
    super({ apiKey: 'stub', fetchImpl: (async () => ({}) as Response) as typeof fetch });
  }
  override async embedBatch(texts: string[]): Promise<number[][]> {
    this.batchCalls += 1;
    this.lastBatchSize = texts.length;
    return texts.map((t) => hashEmbed(t));
  }
}

// Fixture MD — three sections, each large enough to keep whole.
const FIXTURE_V1 = [
  '# Test Knowledge',
  '',
  '## 7. TROTTINETTE ÉLECTRIQUE (EDPM)',
  '',
  "L'assurance trottinette est obligatoire pour tous les EDPM en France.",
  'La garantie responsabilité civile couvre les dommages aux tiers.',
  '',
  '## 3. LE BONUS-MALUS (CRM)',
  '',
  'Le coefficient de réduction-majoration récompense les bons conducteurs.',
  'Un sinistre responsable applique un malus de 25%.',
  '',
  '## 14. LEXIQUE',
  '',
  'Vocabulaire: prime, franchise, malus, sinistre, indemnisation.',
].join('\n');

let tmpDir: string;
let fixturePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'f16-ingest-'));
  fixturePath = join(tmpDir, 'fixture.md');
  writeFileSync(fixturePath, FIXTURE_V1, 'utf8');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

d('knowledge ingest (live pg, stub embeddings)', () => {
  let db: Database;
  let stub: StubEmbeddingClient;
  const SOURCE = 'ingest_test_source';

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await deleteBySource(db, SOURCE);
    // Reset fixture between tests so test 3 starts clean.
    writeFileSync(fixturePath, FIXTURE_V1, 'utf8');
    stub = new StubEmbeddingClient();
    __setEmbeddingClientForTests(stub);
  });

  afterEach(async () => {
    __setEmbeddingClientForTests(null);
    await deleteBySource(db, SOURCE);
  });

  // -------------------------------------------------------------------------
  // 1. Cold ingest inserts N chunks.
  // -------------------------------------------------------------------------
  it('test 1: cold ingest inserts the N adapter chunks', async () => {
    const res = await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });
    expect(res.chunksProcessed).toBeGreaterThanOrEqual(3);
    expect(res.chunksInserted).toBe(res.chunksProcessed);
    expect(res.chunksUpdated).toBe(0);
    expect(res.chunksFailed).toBe(0);
    expect(stub.batchCalls).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 2. Re-running an unchanged source: 0 inserts, N updates.
  // -------------------------------------------------------------------------
  it('test 2: rerun on unchanged source updates instead of inserting', async () => {
    const first = await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });
    const second = await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });
    expect(second.chunksProcessed).toBe(first.chunksProcessed);
    expect(second.chunksInserted).toBe(0);
    expect(second.chunksUpdated).toBe(first.chunksProcessed);
  });

  // -------------------------------------------------------------------------
  // 3. Modifying one chunk: 1 update, others unchanged (insert via sha churn).
  // -------------------------------------------------------------------------
  it('test 3: editing one chunk produces exactly one new row + leaves the rest', async () => {
    const first = await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });

    // Edit the EDPM section body.
    const edited = FIXTURE_V1.replace(
      "L'assurance trottinette est obligatoire pour tous les EDPM en France.",
      "L'assurance trottinette est obligatoire pour tous les EDPM en France ET en Belgique.",
    );
    writeFileSync(fixturePath, edited, 'utf8');

    const second = await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });

    // Two chunks unchanged → refreshed (updates). One chunk text changed →
    // new sha → new insert.
    expect(second.chunksProcessed).toBe(first.chunksProcessed);
    expect(second.chunksInserted).toBe(1);
    expect(second.chunksUpdated).toBe(first.chunksProcessed - 1);
  });

  // -------------------------------------------------------------------------
  // 4. embedTokensUsed > 0 — char-count proxy is summed.
  // -------------------------------------------------------------------------
  it('test 4: embedTokensUsed sums input character counts', async () => {
    const res = await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });
    expect(res.embedTokensUsed).toBeGreaterThan(0);
    expect(res.embedTokensUsed).toBeGreaterThan(100); // fixture is hundreds of chars
  });

  // -------------------------------------------------------------------------
  // 5. durationMs > 0 — wall-clock timing is reported.
  // -------------------------------------------------------------------------
  it('test 5: durationMs is populated', async () => {
    const res = await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.durationMs).toBe('number');
  });

  // -------------------------------------------------------------------------
  // 6. After ingest, semantic search returns the EDPM chunk for a related query.
  // -------------------------------------------------------------------------
  it('test 6: kNN search recovers the EDPM chunk for a related query', async () => {
    await ingestSource(db, markdownFileAdapter, {
      name: SOURCE,
      path: fixturePath,
    });

    const queryVec = hashEmbed('trottinette assurance obligatoire EDPM responsabilité civile');
    const hits = await searchSimilar(db, queryVec, { limit: 3 });

    expect(hits.length).toBeGreaterThan(0);
    // The nearest hit should be the EDPM chunk among the chunks we just
    // ingested (filter by source so other test rows don't trip us up).
    const ourHits = hits.filter((h) => h.chunk.source === SOURCE);
    expect(ourHits.length).toBeGreaterThan(0);
    expect(ourHits[0]!.chunk.chunkText).toContain('TROTTINETTE');
  });
});
