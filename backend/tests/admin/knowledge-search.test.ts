/**
 * Admin knowledge semantic search (M14.T8) — DB-backed integration test.
 *
 * Seeds two chunks with known 1536-d embeddings + a stub embedder (no network),
 * and verifies the kNN endpoint ranks the nearest chunk first + the input guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { knowledgeChunks } from '../../src/db/schema/index.js';
import { upsertChunk } from '../../src/db/repositories/knowledge.js';
import { buildAdminKnowledgeRouter } from '../../src/admin/knowledge-search.js';

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

/** A 1536-d one-hot vector (the corpus embedding dimension). */
function oneHot(i: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[i] = 1;
  return v;
}

d('GET /v1/admin/knowledge/search', () => {
  let db: Database;
  // Stub embedder: every query embeds to the same one-hot as the "trottinette" chunk.
  const stub = { embed: async (): Promise<number[]> => oneHot(0) };
  const app = () => buildAdminKnowledgeRouter({ db, embeddingClient: stub });

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE knowledge_chunks RESTART IDENTITY CASCADE`);
  });

  it('rejects a too-short query with 400', async () => {
    const res = await app().request('/v1/admin/knowledge/search?q=a');
    expect(res.status).toBe(400);
  });

  it('ranks the nearest chunk first and returns a 0-1 similarity', async () => {
    // Near chunk shares the query's embedding (distance 0); far chunk is orthogonal.
    await upsertChunk(db, {
      source: 'maxance_product_catalog',
      sourcePath: 'trottinette.md',
      chunkText: 'Assurance trottinette électrique : tarif et garanties.',
      chunkSha256: 'near-1',
      embedding: oneHot(0),
    });
    await upsertChunk(db, {
      source: 'assuryal_kb',
      sourcePath: 'auto.md',
      chunkText: 'Assurance auto sans rapport.',
      chunkSha256: 'far-1',
      embedding: oneHot(1),
    });

    const res = await app().request('/v1/admin/knowledge/search?q=tarif%20trottinette&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: string;
      results: Array<{ source: string; chunkText: string; distance: number; similarity: number }>;
    };
    expect(body.query).toBe('tarif trottinette');
    expect(body.results.length).toBe(2);
    // Nearest first.
    expect(body.results[0]!.source).toBe('maxance_product_catalog');
    expect(body.results[0]!.distance).toBeCloseTo(0, 5);
    expect(body.results[0]!.similarity).toBe(1);
    // The orthogonal chunk ranks lower with a lower similarity.
    expect(body.results[1]!.source).toBe('assuryal_kb');
    expect(body.results[1]!.similarity).toBeLessThan(body.results[0]!.similarity);
  });

  it('caps the limit and returns an empty list on an empty corpus', async () => {
    // (corpus truncated in beforeEach)
    const res = await app().request('/v1/admin/knowledge/search?q=trottinette&limit=999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
    // Sanity: knowledge_chunks really is empty.
    const rows = await db.select().from(knowledgeChunks);
    expect(rows).toHaveLength(0);
  });
});
