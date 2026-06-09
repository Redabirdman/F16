/**
 * Knowledge Curator integration tests (M7.T3).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY.
 *
 * Embeddings are stubbed via `__setEmbeddingClientForTests` so we don't hit
 * OpenRouter and reruns are deterministic. The actual ingestion path runs
 * against a real pgvector instance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { sql, eq, and } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, knowledgeChunks } from '../../src/db/schema/index.js';
import { EmbeddingClient, __setEmbeddingClientForTests } from '../../src/llm/embeddings.js';
import { sendMessage } from '../../src/messaging/dispatcher.js';
import { startKnowledgeCurator } from '../../src/knowledge/curator.js';
import {
  registerKnowledgeSource,
  __resetKnowledgeSourcesForTests,
} from '../../src/knowledge/source-registry.js';
import { deleteBySource } from '../../src/db/repositories/knowledge.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const liveBoth = Boolean(pgUrl && redisUrl);
const d = describe.skipIf(!liveBoth);

let savedPiiKey: string | undefined;
let savedRedisUrl: string | undefined;
let savedPrefix: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  savedRedisUrl = process.env.REDIS_URL;
  savedPrefix = process.env.BULLMQ_PREFIX;
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
  if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
  else process.env.BULLMQ_PREFIX = savedPrefix;
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = Number(process.env.TEST_WAITFOR_MS) || 15_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate not true within ${timeoutMs}ms`);
}

/** Minimal deterministic stub — we only care that an embedding came back. */
class StubEmbeddingClient extends EmbeddingClient {
  public batchCalls = 0;
  constructor() {
    super({
      apiKey: 'stub',
      fetchImpl: (async () => ({}) as Response) as typeof fetch,
    });
  }
  override async embedBatch(texts: string[]): Promise<number[][]> {
    this.batchCalls += 1;
    return texts.map(() => {
      const v = new Array<number>(1536).fill(0);
      // Set one non-zero index so the inserted vector isn't degenerate.
      v[0] = 1;
      return v;
    });
  }
}

const FIXTURE_MD = [
  '# Curator Fixture',
  '',
  '## 1. SECTION ONE',
  '',
  'Le contenu de la première section pour le test du curator.',
  '',
  '## 2. SECTION TWO',
  '',
  'Une deuxième section avec son propre paragraphe distinct.',
].join('\n');

let tmpDir: string;
let fixturePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'f16-curator-'));
  fixturePath = join(tmpDir, 'fixture.md');
  writeFileSync(fixturePath, FIXTURE_MD, 'utf8');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

d('knowledge-curator (live pg + redis, stub embeddings)', () => {
  let db: Database;
  let stub: StubEmbeddingClient;
  let prefix: string;
  let handle: Awaited<ReturnType<typeof startKnowledgeCurator>> | undefined;
  const FIX_SRC = 'curator_fixture';
  const DUMMY_SRC = 'curator_dummy';

  beforeEach(async () => {
    prefix = `f16-test-curator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();
    __resetKnowledgeSourcesForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await deleteBySource(db, FIX_SRC);
    await deleteBySource(db, DUMMY_SRC);

    stub = new StubEmbeddingClient();
    __setEmbeddingClientForTests(stub);
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop().catch(() => {});
      handle = undefined;
    }
    __setEmbeddingClientForTests(null);
    __resetKnowledgeSourcesForTests();
    try {
      const cleaner = new Redis(redisUrl!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      const keys = await cleaner.keys(`${prefix}:*`);
      if (keys.length > 0) await cleaner.del(...keys);
      await cleaner.quit();
    } catch {
      /* ignore */
    }
    await shutdownQueues().catch(() => {});
    await deleteBySource(db, FIX_SRC).catch(() => {});
    await deleteBySource(db, DUMMY_SRC).catch(() => {});
    __resetForTests();
  });

  // -------------------------------------------------------------------------
  // 1. Manual reindex via dispatcher: emit REINDEX_REQUESTED → REINDEXED.
  // -------------------------------------------------------------------------
  it('test 1: manual reindex consumes the request and ingests + emits REINDEXED', async () => {
    registerKnowledgeSource({
      name: FIX_SRC,
      adapter: 'markdown-file',
      path: fixturePath,
      scheduled: false, // explicit-only — keep scheduler out of this test
    });

    // Use a long scheduler interval so a stray tick can't fire before assertions.
    handle = startKnowledgeCurator({ db, schedulerIntervalMs: 60_000 });
    await handle.worker.waitUntilReady();

    const reqId = await sendMessage(
      { db },
      {
        fromRole: 'admin',
        toRole: 'knowledge-curator',
        intent: 'KNOWLEDGE.REINDEX_REQUESTED',
        payload: { source: FIX_SRC },
        correlationId: 'manual-1',
      },
    );

    // Wait for the REINDEX_REQUESTED row to be marked consumed WITH a result
    // payload populated. consumedAt and result are written in two SQL
    // statements inside the dispatcher; reading too early can catch consumedAt
    // set but result still null.
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, reqId));
      return Boolean(row && row.consumedAt && row.result);
    });

    const [reqRow] = await db.select().from(agentMessages).where(eq(agentMessages.id, reqId));
    expect(reqRow!.consumedBy).toBe('knowledge-curator');
    expect(reqRow!.error).toBeNull();
    const result = reqRow!.result as Record<string, unknown>;
    expect(result['source']).toBe(FIX_SRC);
    expect(Number(result['chunksProcessed'])).toBeGreaterThanOrEqual(1);

    // KNOWLEDGE.REINDEXED row exists.
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.intent, 'KNOWLEDGE.REINDEXED'));
      return rows.length >= 1;
    });
    const reindexedRows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.intent, 'KNOWLEDGE.REINDEXED'));
    expect(reindexedRows).toHaveLength(1);
    const reindexedPayload = reindexedRows[0]!.payload as Record<string, unknown>;
    expect(reindexedPayload['source']).toBe(FIX_SRC);
    expect(Number(reindexedPayload['chunkCount'])).toBeGreaterThanOrEqual(1);
    expect(typeof reindexedPayload['durationMs']).toBe('number');

    // Chunks landed in pg.
    const chunks = await db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.source, FIX_SRC));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 2. Unknown source → ok with skipped:unknown-source, no REINDEXED emit.
  // -------------------------------------------------------------------------
  it('test 2: unknown source resolves cleanly without emitting REINDEXED', async () => {
    handle = startKnowledgeCurator({ db, schedulerIntervalMs: 60_000 });
    await handle.worker.waitUntilReady();

    const reqId = await sendMessage(
      { db },
      {
        fromRole: 'admin',
        toRole: 'knowledge-curator',
        intent: 'KNOWLEDGE.REINDEX_REQUESTED',
        payload: { source: 'doesNotExist' },
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, reqId));
      return Boolean(row && row.consumedAt);
    });

    const [reqRow] = await db.select().from(agentMessages).where(eq(agentMessages.id, reqId));
    expect(reqRow!.error).toBeNull();
    const result = reqRow!.result as Record<string, unknown>;
    expect(result['skipped']).toBe('unknown-source');
    expect(result['source']).toBe('doesNotExist');

    // Allow a small grace window in case a REINDEXED was wrongly emitted.
    await new Promise((r) => setTimeout(r, 100));
    const reindexedRows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.intent, 'KNOWLEDGE.REINDEXED'));
    expect(reindexedRows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Scheduler tick fires REINDEX_REQUESTED for due sources.
  // -------------------------------------------------------------------------
  it('test 3: scheduler emits REINDEX_REQUESTED on tick for due sources', async () => {
    registerKnowledgeSource({
      name: DUMMY_SRC,
      adapter: 'markdown-file',
      path: fixturePath,
      intervalHours: 0.0001, // ~0.36s, easily due
      scheduled: true,
    });

    handle = startKnowledgeCurator({ db, schedulerIntervalMs: 50 });
    await handle.worker.waitUntilReady();

    // The first tick runs immediately at startup; assert at least one emit row
    // for our source within ~200ms.
    await waitFor(
      async () => {
        const rows = await db
          .select()
          .from(agentMessages)
          .where(
            and(
              eq(agentMessages.intent, 'KNOWLEDGE.REINDEX_REQUESTED'),
              eq(agentMessages.fromRole, 'knowledge-curator'),
            ),
          );
        return rows.some((r) => {
          const p = r.payload as Record<string, unknown>;
          return p['source'] === DUMMY_SRC;
        });
      },
      2000,
      20,
    );
  });

  // -------------------------------------------------------------------------
  // 4. Scheduler does NOT fire repeatedly for sources still inside their
  //    interval. With intervalHours=24, only the initial-tick emit counts.
  // -------------------------------------------------------------------------
  it('test 4: scheduler skips not-yet-due sources after the initial tick', async () => {
    registerKnowledgeSource({
      name: DUMMY_SRC,
      adapter: 'markdown-file',
      path: fixturePath,
      intervalHours: 24,
      scheduled: true,
    });

    handle = startKnowledgeCurator({ db, schedulerIntervalMs: 20 });
    await handle.worker.waitUntilReady();

    // Wait long enough for many ticks to have fired (100ms / 20ms = ~5 ticks).
    await new Promise((r) => setTimeout(r, 120));

    const scheduledRows = await db
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.intent, 'KNOWLEDGE.REINDEX_REQUESTED'),
          eq(agentMessages.fromRole, 'knowledge-curator'),
        ),
      );
    const ourRows = scheduledRows.filter((r) => {
      const p = r.payload as Record<string, unknown>;
      return p['source'] === DUMMY_SRC;
    });
    // Exactly one — the initial-tick emit. Subsequent ticks see the
    // intervalHours=24 gap and skip.
    expect(ourRows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 8. Curator emits KNOWLEDGE.DRIFT_DETECTED when the source evolves.
  // -------------------------------------------------------------------------
  it('test 8: curator emits KNOWLEDGE.DRIFT_DETECTED on second reindex with new chunk', async () => {
    // Reuse FIXTURE_MD as the initial corpus, then append a new H2 section to
    // force `added.length == 1` (kind='new_product') on the second pass.
    writeFileSync(fixturePath, FIXTURE_MD, 'utf8');

    registerKnowledgeSource({
      name: FIX_SRC,
      adapter: 'markdown-file',
      path: fixturePath,
      scheduled: false,
    });

    handle = startKnowledgeCurator({ db, schedulerIntervalMs: 60_000 });
    await handle.worker.waitUntilReady();

    // First reindex — seeds the corpus, no drift expected.
    const firstId = await sendMessage(
      { db },
      {
        fromRole: 'admin',
        toRole: 'knowledge-curator',
        intent: 'KNOWLEDGE.REINDEX_REQUESTED',
        payload: { source: FIX_SRC },
        correlationId: 'drift-seed',
      },
    );
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, firstId));
      return Boolean(row && row.consumedAt && row.result);
    });

    // No DRIFT_DETECTED yet — the seed is `new_product` (all chunks added),
    // which would emit. To isolate the "evolution" assertion, count rows now.
    const driftRowsAfterSeed = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.intent, 'KNOWLEDGE.DRIFT_DETECTED'));
    // The very first ingest treats every chunk as "added" → seed run produces
    // exactly one DRIFT_DETECTED row of kind=new_product.
    expect(driftRowsAfterSeed).toHaveLength(1);
    const seedPayload = driftRowsAfterSeed[0]!.payload as Record<string, unknown>;
    expect(seedPayload['kind']).toBe('new_product');

    // Mutate the fixture — add an H2 section.
    const mutated = `${FIXTURE_MD}\n\n## 3. NEW SECTION\n\nDu contenu fraîchement ajouté pour le test de drift.\n`;
    writeFileSync(fixturePath, mutated, 'utf8');

    const secondId = await sendMessage(
      { db },
      {
        fromRole: 'admin',
        toRole: 'knowledge-curator',
        intent: 'KNOWLEDGE.REINDEX_REQUESTED',
        payload: { source: FIX_SRC },
        correlationId: 'drift-evolve',
      },
    );
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, secondId));
      return Boolean(row && row.consumedAt && row.result);
    });

    // A second DRIFT_DETECTED row should now exist with kind=new_product and
    // exactly one added path.
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.intent, 'KNOWLEDGE.DRIFT_DETECTED'));
      return rows.length >= 2;
    });

    const driftRows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.intent, 'KNOWLEDGE.DRIFT_DETECTED'));
    expect(driftRows.length).toBe(2);

    // Find the one with correlationId='drift-evolve'.
    const evolveRow = driftRows.find((r) => r.correlationId === 'drift-evolve');
    expect(evolveRow).toBeDefined();
    const payload = evolveRow!.payload as Record<string, unknown>;
    expect(payload['source']).toBe(FIX_SRC);
    expect(payload['kind']).toBe('new_product');
    const details = payload['details'] as Record<string, unknown>;
    const added = details['added'] as string[];
    expect(added).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 5. stop() clears the scheduler interval AND closes the worker.
  // -------------------------------------------------------------------------
  it('test 5: stop() cleans up the scheduler and the worker', async () => {
    registerKnowledgeSource({
      name: DUMMY_SRC,
      adapter: 'markdown-file',
      path: fixturePath,
      intervalHours: 0.0001,
      scheduled: true,
    });

    handle = startKnowledgeCurator({ db, schedulerIntervalMs: 20 });
    await handle.worker.waitUntilReady();

    // Let one tick land.
    await new Promise((r) => setTimeout(r, 50));

    await handle.stop();

    // Count scheduled emits right after stop.
    const before = (
      await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.intent, 'KNOWLEDGE.REINDEX_REQUESTED'))
    ).length;

    // Wait beyond several would-be tick intervals. If stop() didn't clear the
    // scheduler, new rows would appear here.
    await new Promise((r) => setTimeout(r, 150));

    const after = (
      await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.intent, 'KNOWLEDGE.REINDEX_REQUESTED'))
    ).length;

    expect(after).toBe(before);

    // worker.closing is true once close() resolved.
    expect(handle.worker.closing).toBeDefined();

    // Mark handle as already-stopped so afterEach doesn't double-close.
    handle = undefined;
  });
});
