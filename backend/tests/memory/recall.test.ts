/**
 * Memory facade — integration tests against live pg + stub embeddings.
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY (insertCustomer needs the
 * encryption key). The embeddings client is replaced with a deterministic
 * stub so:
 *   1. The tests never hit OpenRouter.
 *   2. kNN ordering is reproducible — same text always produces the same
 *      1536-dim vector.
 *
 * Stub strategy: hash text into a stable 1536-dim vector. Texts with shared
 * tokens produce similar vectors (close in cosine space); unrelated texts
 * produce orthogonal-ish vectors. Good enough for ordering assertions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import {
  recordCustomerFact,
  recordFactsBatch,
  recallCustomerFacts,
  listRecentFacts,
} from '../../src/memory/index.js';
import { EmbeddingClient, __setEmbeddingClientForTests } from '../../src/llm/embeddings.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

/**
 * Deterministic embedding stub.
 *
 * For each text, we tokenize on non-word chars and accumulate a 1536-dim
 * vector where each token contributes a fixed pseudo-random direction
 * (seeded by the token's char codes). Identical texts → identical vectors.
 * Texts sharing tokens → cosine-similar vectors. Unrelated texts →
 * near-orthogonal vectors. Then we L2-normalize so cosine distance is in
 * the expected 0..2 range.
 */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    // FNV-1a hash for a stable per-token seed.
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    // Spread the token across the vector — sprinkle 16 dims per token so
    // multi-token strings produce a meaningful sum rather than 16 hot dims.
    for (let k = 0; k < 16; k++) {
      const idx = ((h + k * 2654435761) >>> 0) % 1536;
      const sign = ((h >>> (k % 16)) & 1) === 0 ? 1 : -1;
      v[idx] = (v[idx] ?? 0) + sign * (0.5 + ((h >>> (k % 8)) & 0xff) / 512);
    }
  }
  // L2 normalize so cosine distance behaves predictably.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

class StubEmbeddingClient extends EmbeddingClient {
  public embedCalls = 0;
  public batchCalls = 0;
  public failNext = false;
  constructor() {
    // Pass a dummy apiKey so the base ctor doesn't complain about env.
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
    this.batchCalls += 1;
    return texts.map((t) => hashEmbed(t));
  }
}

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

d('memory facade (live pg, stub embeddings)', () => {
  let db: Database;
  let stub: StubEmbeddingClient;
  let customerId: string;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    stub = new StubEmbeddingClient();
    __setEmbeddingClientForTests(stub);
    const c = await insertCustomer(db, { fullName: 'Test Customer', phone: '+33611111111' });
    customerId = c.id;
  });

  afterEach(() => {
    __setEmbeddingClientForTests(null);
  });

  // -------------------------------------------------------------------------
  // 1. recordCustomerFact inserts a row using the stub's embedding.
  // -------------------------------------------------------------------------
  it('test 1: recordCustomerFact persists the fact and listRecentFacts returns it', async () => {
    const fact = await recordCustomerFact(db, {
      customerId,
      factType: 'preference',
      content: 'préfère WhatsApp',
      confidence: 0.8,
      recordedBy: 'test#1',
    });
    expect(fact.id).toMatch(/^[0-9a-f-]+$/);
    expect(fact.factType).toBe('preference');
    expect(fact.content).toBe('préfère WhatsApp');
    expect(fact.confidence).toBe(0.8);
    expect(fact.recordedBy).toBe('test#1');

    const recent = await listRecentFacts(db, customerId);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(fact.id);
    expect(recent[0]!.content).toBe('préfère WhatsApp');
  });

  // -------------------------------------------------------------------------
  // 2. recordFactsBatch — single embeddings call for N facts.
  // -------------------------------------------------------------------------
  it('test 2: recordFactsBatch inserts N facts with one embeddings call', async () => {
    const inserted = await recordFactsBatch(db, customerId, [
      { factType: 'preference', content: 'préfère WhatsApp' },
      { factType: 'objection', content: 'trop cher' },
      { factType: 'event', content: 'renouvellement septembre' },
    ]);
    expect(inserted).toHaveLength(3);
    expect(stub.batchCalls).toBe(1);
    expect(stub.embedCalls).toBe(0);

    const recent = await listRecentFacts(db, customerId);
    expect(recent).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 3. recallCustomerFacts orders by semantic similarity (stub-deterministic).
  // -------------------------------------------------------------------------
  it('test 3: recallCustomerFacts returns the most-similar fact first', async () => {
    await recordFactsBatch(db, customerId, [
      { factType: 'preference', content: 'préfère WhatsApp comme canal' },
      { factType: 'objection', content: 'tarif voiture trop élevé' },
      { factType: 'event', content: 'sinistre auto en 2024' },
    ]);
    const hits = await recallCustomerFacts(db, customerId, 'WhatsApp canal préféré', {
      limit: 2,
    });
    expect(hits.length).toBeGreaterThan(0);
    // The fact with the most token overlap with the query is the WhatsApp one.
    expect(hits[0]!.content).toContain('WhatsApp');
    // Distance is a non-negative number.
    expect(typeof hits[0]!.distance).toBe('number');
    expect(hits[0]!.distance).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // 4. minConfidence filter.
  // -------------------------------------------------------------------------
  it('test 4: recallCustomerFacts respects minConfidence', async () => {
    await recordCustomerFact(db, {
      customerId,
      factType: 'observation',
      content: 'low confidence fact',
      confidence: 0.2,
    });
    await recordCustomerFact(db, {
      customerId,
      factType: 'observation',
      content: 'medium confidence fact',
      confidence: 0.5,
    });
    await recordCustomerFact(db, {
      customerId,
      factType: 'observation',
      content: 'high confidence fact',
      confidence: 0.9,
    });
    const hits = await recallCustomerFacts(db, customerId, 'anything', {
      limit: 10,
      minConfidence: 0.4,
    });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.confidence >= 0.4)).toBe(true);
    expect(hits.map((h) => h.content).sort()).toEqual([
      'high confidence fact',
      'medium confidence fact',
    ]);
  });

  // -------------------------------------------------------------------------
  // 5. customerId scoping — facts of OTHER customers don't leak in.
  // -------------------------------------------------------------------------
  it('test 5: recallCustomerFacts filters by customerId', async () => {
    const otherCustomer = await insertCustomer(db, {
      fullName: 'Other',
      phone: '+33622222222',
    });
    await recordCustomerFact(db, {
      customerId: otherCustomer.id,
      factType: 'preference',
      content: 'this should NOT appear',
    });
    await recordCustomerFact(db, {
      customerId,
      factType: 'preference',
      content: 'this SHOULD appear',
    });
    const hits = await recallCustomerFacts(db, customerId, 'preference', { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toBe('this SHOULD appear');
  });

  // -------------------------------------------------------------------------
  // 6. Empty query — still works.
  // -------------------------------------------------------------------------
  it('test 6: recallCustomerFacts with empty query still returns something', async () => {
    await recordCustomerFact(db, {
      customerId,
      factType: 'observation',
      content: 'only fact',
    });
    const hits = await recallCustomerFacts(db, customerId, '', { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toBe('only fact');
  });

  // -------------------------------------------------------------------------
  // 7. Embedding failure on record — error bubbles, no row inserted.
  // -------------------------------------------------------------------------
  it('test 7: embedding failure on record throws — no row inserted', async () => {
    stub.failNext = true;
    await expect(
      recordCustomerFact(db, {
        customerId,
        factType: 'observation',
        content: 'should not land',
      }),
    ).rejects.toThrow(/stub embed failure/);
    const recent = await listRecentFacts(db, customerId);
    expect(recent).toHaveLength(0);
  });
});
