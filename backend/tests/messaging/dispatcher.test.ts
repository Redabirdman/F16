/**
 * Agent message dispatcher integration tests (M3.T3).
 *
 * Gated on TEST_DATABASE_URL AND TEST_REDIS_URL — both are required since the
 * dispatcher unifies durable rows (pg) and lightweight delivery (BullMQ).
 *
 * Spin up:
 *   docker run -d --name f16-pg-m3t3 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker run -d --name f16-redis-m3t3 -p 6381:6379 redis:7-alpine --appendonly yes
 *   docker exec -i f16-pg-m3t3 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 \
 *     TEST_REDIS_URL=redis://127.0.0.1:6381 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages } from '../../src/db/schema/index.js';
import {
  sendMessage,
  consume,
  requeue,
  INTENT_TO_QUEUE,
  physicalQueueName,
  drainLegacySharedQueues,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
} from '../../src/messaging/dispatcher.js';
import { listIntents } from '../../src/intents/index.js';
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

/** Wait for a predicate to become true, polling at `intervalMs`. */
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

/** Build a valid LEAD.NEW payload with a fresh UUID. */
function leadNewPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leadId: randomUUID(),
    source: 'website',
    productLine: 'scooter',
    ...extra,
  };
}

/** Build a valid QUOTE.REQUESTED payload with fresh UUIDs. */
function quoteRequestedPayload(): Record<string, unknown> {
  return {
    quoteId: randomUUID(),
    customerId: randomUUID(),
    leadId: randomUUID(),
    product: 'scooter',
    productVariant: 'X1',
    formData: { plate: 'AA-123-BB' },
  };
}

d('dispatcher (live)', () => {
  let db: Database;
  let prefix: string;
  const workers: Worker[] = [];

  beforeEach(async () => {
    // Unique prefix per test so parallel/CI runs can't see each other's jobs.
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    // Close any workers spun up in the test. close() drains in-flight jobs.
    for (const w of workers.splice(0)) {
      await w.close().catch(() => {});
    }
    // Best-effort wipe of test-prefix keys, then drop the cached singleton.
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
    __resetForTests();
  });

  // -------------------------------------------------------------------------
  // routing integrity
  // -------------------------------------------------------------------------

  it('test 1 (routing): every registered intent has a queue mapping', () => {
    const unrouted = listIntents().filter((n) => !INTENT_TO_QUEUE[n]);
    expect(unrouted).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // happy path
  // -------------------------------------------------------------------------

  it('test 2 (happy path): sendMessage -> worker consumes -> markResult', async () => {
    const seen: AgentMessageEnvelope[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });

    const w = consume({
      db,
      queue: 'lead',
      role: 'lead-scorer',
      handler: async (env) => {
        seen.push(env);
        resolveDone();
        return { ok: true, result: { acknowledged: true } };
      },
    });
    workers.push(w);
    await w.waitUntilReady();

    const payload = leadNewPayload();
    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload,
        correlationId: 'lead-xyz',
      },
    );

    await done;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(id);
    expect(seen[0]!.intent).toBe('LEAD.NEW');
    expect(seen[0]!.toRole).toBe('lead-scorer');
    expect(seen[0]!.correlationId).toBe('lead-xyz');
    expect(seen[0]!.payload).toEqual(payload);

    // Wait for the post-handler markResult to land.
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(row && row.consumedAt && row.result);
    });
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.consumedAt).not.toBeNull();
    expect(row!.consumedBy).toBe('lead-scorer');
    expect(row!.result).toEqual({ acknowledged: true });
    expect(row!.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // validation failures
  // -------------------------------------------------------------------------

  it('test 3 (payload validation): invalid LEAD.NEW throws + no side effects', async () => {
    await expect(
      sendMessage(
        { db },
        {
          fromRole: 'webhook',
          toRole: 'lead-scorer',
          intent: 'LEAD.NEW',
          payload: { leadId: 'not-a-uuid', source: 'website', productLine: 'scooter' },
        },
      ),
    ).rejects.toThrow(/LEAD\.NEW/);

    // No row inserted.
    const rows = await db.select().from(agentMessages);
    expect(rows).toHaveLength(0);
  });

  it('test 4 (unknown intent): sendMessage throws on unregistered intent', async () => {
    await expect(
      sendMessage(
        { db },
        {
          fromRole: 'webhook',
          toRole: 'lead-scorer',
          intent: 'NOT.AN.INTENT',
          payload: {},
        },
      ),
    ).rejects.toThrow(/Unknown intent/);

    const rows = await db.select().from(agentMessages);
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // failure paths
  // -------------------------------------------------------------------------

  it('test 5 (handler error): {ok:false} writes markError, no result', async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });

    const w = consume({
      db,
      queue: 'lead',
      role: 'lead-scorer',
      handler: async () => {
        const r: MessageHandlerResult = { ok: false, error: 'maxance unreachable' };
        resolveDone();
        return r;
      },
    });
    workers.push(w);
    await w.waitUntilReady();

    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );

    await done;
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(row && row.error);
    });
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.error).toBe('maxance unreachable');
    expect(row!.result).toBeNull();
    expect(row!.consumedAt).not.toBeNull();
  });

  it('test 6 (handler throws): markError captures message + BullMQ marks job failed', async () => {
    let resolveSeen!: () => void;
    const seen = new Promise<void>((res) => {
      resolveSeen = res;
    });

    const w = consume({
      db,
      queue: 'lead',
      role: 'lead-scorer',
      handler: async () => {
        resolveSeen();
        throw new Error('boom from handler');
      },
    });
    workers.push(w);
    // Listen for failed events on the worker.
    let failedCount = 0;
    w.on('failed', () => {
      failedCount += 1;
    });
    await w.waitUntilReady();

    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );

    await seen;
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(row && row.error);
    });
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.error).toMatch(/boom from handler/);
    expect(row!.result).toBeNull();

    // BullMQ should have observed at least one failure.
    await waitFor(() => failedCount > 0, 2000);
    expect(failedCount).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // priority ordering
  // -------------------------------------------------------------------------

  it('test 7 (priority): worker processes highest priority (lowest number) first', async () => {
    const order: number[] = [];
    let resolveAll!: () => void;
    const all = new Promise<void>((res) => {
      resolveAll = res;
    });

    // Pause the (role-scoped) queue first so all three are enqueued before
    // any processing.
    const { getQueue } = await import('../../src/queue/index.js');
    const q = getQueue(physicalQueueName('lead', 'priority-worker'));
    await q.pause();

    const w = consume({
      db,
      queue: 'lead',
      role: 'priority-worker',
      handler: async (env) => {
        order.push(env.priority);
        if (order.length === 3) resolveAll();
        return { ok: true };
      },
      concurrency: 1,
    });
    workers.push(w);
    await w.waitUntilReady();

    // Enqueue three messages — middle priority first, then highest, then lowest.
    await sendMessage(
      { db },
      {
        fromRole: 'src',
        toRole: 'priority-worker',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
        priority: 5,
      },
    );
    await sendMessage(
      { db },
      {
        fromRole: 'src',
        toRole: 'priority-worker',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
        priority: 0,
      },
    );
    await sendMessage(
      { db },
      {
        fromRole: 'src',
        toRole: 'priority-worker',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
        priority: 9,
      },
    );

    await q.resume();
    await all;
    expect(order).toEqual([0, 5, 9]);
  });

  // -------------------------------------------------------------------------
  // requeue
  // -------------------------------------------------------------------------

  it('test 8 (requeue): a second job is delivered to the worker after requeue', async () => {
    // Send without a consumer running — row exists, job sits in the queue.
    const id = await sendMessage(
      { db },
      {
        fromRole: 'src',
        toRole: 'requeue-worker',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );

    // requeue adds another BullMQ job pointing at the same row.
    await requeue({ db }, id);

    let count = 0;
    let resolveSecond!: () => void;
    const secondSeen = new Promise<void>((res) => {
      resolveSecond = res;
    });

    const w = consume({
      db,
      queue: 'lead',
      role: 'requeue-worker',
      handler: async () => {
        count += 1;
        if (count === 2) resolveSecond();
        return { ok: true };
      },
    });
    workers.push(w);
    await w.waitUntilReady();

    // First delivery claims + marks consumed. Second delivery (from requeue)
    // arrives, but claimSpecific returns null since the row is already
    // consumed. We're verifying the JOB count, not the handler firing twice
    // on the same row — the second handler invocation will be a no-op claim.
    // To assert "second job arrives in queue" we wait for the worker to see
    // both jobs (even if the second short-circuits before reaching the
    // handler we'd not see count=2). The worker processor IS the handler
    // path, but the no-claim branch happens BEFORE handler runs. So we
    // measure via BullMQ completed events instead.
    let completed = 0;
    w.on('completed', () => {
      completed += 1;
      if (completed === 2) resolveSecond();
    });

    await secondSeen;
    expect(completed).toBeGreaterThanOrEqual(2);

    // Row state: consumed once with markResult set.
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.consumedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // role-scoped queues (regression: 2026-07-03 wrong-role drop of a live
  // QUOTE.REQUESTED — messageId a9e94c62 — when the same wrong worker kept
  // winning the shared-queue re-pickup race until MAX_REROUTES dropped it)
  // -------------------------------------------------------------------------

  it('test 8b (role isolation): two role-workers on one logical queue — the wrong role can never grab the job', async () => {
    // Old topology: sales-agent + maxance-operator both consumed the physical
    // 'quote' queue; a QUOTE.REQUESTED addressed to maxance-operator could be
    // picked by the sales-agent worker repeatedly and dropped. New topology:
    // physical queues are role-scoped, so the wrong-role worker never even
    // sees the job. We start the wrong worker FIRST with higher concurrency
    // (the aggressive racer that used to win) and attach the right worker
    // only after proving the message stayed untouched.
    const wrongSeen: string[] = [];
    let wrongCompleted = 0;
    const wWrong = consume({
      db,
      queue: 'quote',
      role: 'sales-agent',
      concurrency: 4,
      handler: async (env) => {
        wrongSeen.push(env.id);
        return { ok: true };
      },
    });
    workers.push(wWrong);
    wWrong.on('completed', () => {
      wrongCompleted += 1;
    });
    await wWrong.waitUntilReady();

    const id = await sendMessage(
      { db },
      {
        fromRole: 'sales-agent',
        toRole: 'maxance-operator',
        intent: 'QUOTE.REQUESTED',
        payload: quoteRequestedPayload(),
      },
    );

    // Give the aggressive wrong-role worker time to (not) grab it: the row
    // must remain unclaimed and unerrored — parked, NOT dropped.
    await new Promise((r) => setTimeout(r, 400));
    let [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.consumedAt).toBeNull();
    expect(row!.error).toBeNull();
    expect(wrongSeen).toEqual([]);
    expect(wrongCompleted).toBe(0);

    // Late-attaching correct consumer gets the parked message (self-healing —
    // this is also the KNOWLEDGE.REINDEX_REQUESTED-at-boot shape).
    const rightSeen: AgentMessageEnvelope[] = [];
    let resolveRight!: () => void;
    const rightDone = new Promise<void>((res) => {
      resolveRight = res;
    });
    const wRight = consume({
      db,
      queue: 'quote',
      role: 'maxance-operator',
      handler: async (env) => {
        rightSeen.push(env);
        resolveRight();
        return { ok: true };
      },
    });
    workers.push(wRight);
    await wRight.waitUntilReady();

    await rightDone;
    expect(rightSeen).toHaveLength(1);
    expect(rightSeen[0]!.id).toBe(id);
    expect(rightSeen[0]!.intent).toBe('QUOTE.REQUESTED');

    await waitFor(async () => {
      const [r] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(r && r.consumedAt);
    });
    [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.consumedBy).toBe('maxance-operator');
    expect(row!.error).toBeNull();
    // The wrong worker never processed anything, even after delivery.
    expect(wrongSeen).toEqual([]);
    expect(wrongCompleted).toBe(0);
  });

  it('test 8c (role isolation, both live): interleaved messages to two roles on one logical queue each land exactly once on their own role', async () => {
    // Direct regression shape for the 2026-07-03 incident: both consumers
    // live, traffic addressed to both roles interleaved — every message must
    // reach its own role exactly once, zero drops.
    const N = 5;
    const salesSeen: string[] = [];
    const maxanceSeen: string[] = [];
    let resolveAll!: () => void;
    const allDone = new Promise<void>((res) => {
      resolveAll = res;
    });
    const checkDone = (): void => {
      if (salesSeen.length === N && maxanceSeen.length === N) resolveAll();
    };

    const wSales = consume({
      db,
      queue: 'quote',
      role: 'sales-agent',
      concurrency: 2,
      handler: async (env) => {
        salesSeen.push(env.id);
        checkDone();
        return { ok: true };
      },
    });
    const wMaxance = consume({
      db,
      queue: 'quote',
      role: 'maxance-operator',
      concurrency: 2,
      handler: async (env) => {
        maxanceSeen.push(env.id);
        checkDone();
        return { ok: true };
      },
    });
    workers.push(wSales, wMaxance);
    await Promise.all([wSales.waitUntilReady(), wMaxance.waitUntilReady()]);

    const toMaxance: string[] = [];
    const toSales: string[] = [];
    for (let i = 0; i < N; i += 1) {
      toMaxance.push(
        await sendMessage(
          { db },
          {
            fromRole: 'sales-agent',
            toRole: 'maxance-operator',
            intent: 'QUOTE.REQUESTED',
            payload: quoteRequestedPayload(),
          },
        ),
      );
      toSales.push(
        await sendMessage(
          { db },
          {
            fromRole: 'maxance-operator',
            toRole: 'sales-agent',
            intent: 'QUOTE.READY',
            payload: {
              quoteId: randomUUID(),
              customerId: randomUUID(),
              monthlyPremium: 6.51,
              comptantDue: 90.85,
              devisNumber: `DR${String(i).padStart(8, '0')}`,
              pdfSentTo: 'client@example.com',
            },
          },
        ),
      );
    }

    await allDone;
    expect([...salesSeen].sort()).toEqual([...toSales].sort());
    expect([...maxanceSeen].sort()).toEqual([...toMaxance].sort());

    // Every row consumed by ITS role, none errored/dropped.
    await waitFor(async () => {
      const rows = await db.select().from(agentMessages);
      return rows.every((r) => r.consumedAt !== null);
    });
    const rows = await db.select().from(agentMessages);
    expect(rows).toHaveLength(2 * N);
    for (const r of rows) {
      expect(r.consumedBy).toBe(r.toRole);
      expect(r.error).toBeNull();
    }
  });

  it('test 8d (legacy drain): jobs parked on a pre-role-scoping shared queue are moved to role-scoped queues at boot', async () => {
    // Simulate a deploy: a job sits on the LEGACY shared 'quote' queue (old
    // physical name), addressed to maxance-operator.
    const { getQueue } = await import('../../src/queue/index.js');
    const parsedId = await sendMessage(
      { db },
      {
        fromRole: 'sales-agent',
        toRole: 'maxance-operator',
        intent: 'QUOTE.REQUESTED',
        payload: quoteRequestedPayload(),
      },
    );
    // sendMessage put the job on the role-scoped queue; strip it and plant a
    // legacy-shaped job on the bare category queue instead.
    await getQueue(physicalQueueName('quote', 'maxance-operator')).drain(true);
    await getQueue('quote').add('QUOTE.REQUESTED', { messageId: parsedId, rerouteCount: 1 });

    const moved = await drainLegacySharedQueues({ db }, ['quote']);
    expect(moved).toBe(1);
    const legacyCounts = await getQueue('quote').getJobCounts('wait', 'prioritized', 'delayed');
    expect(
      (legacyCounts.wait ?? 0) + (legacyCounts.prioritized ?? 0) + (legacyCounts.delayed ?? 0),
    ).toBe(0);

    // The drained job is now consumable by the correct role.
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });
    const w = consume({
      db,
      queue: 'quote',
      role: 'maxance-operator',
      handler: async () => {
        resolveDone();
        return { ok: true };
      },
    });
    workers.push(w);
    await w.waitUntilReady();
    await done;

    await waitFor(async () => {
      const [r] = await db.select().from(agentMessages).where(eq(agentMessages.id, parsedId));
      return Boolean(r && r.consumedAt);
    });
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, parsedId));
    expect(row!.consumedBy).toBe('maxance-operator');
  });

  // -------------------------------------------------------------------------
  // multi-queue routing
  // -------------------------------------------------------------------------

  it('test 9 (two queues): LEAD.NEW -> lead worker, QUOTE.REQUESTED -> quote worker', async () => {
    const leadSeen: string[] = [];
    const quoteSeen: string[] = [];
    let leadDone!: () => void;
    let quoteDone!: () => void;
    const leadP = new Promise<void>((res) => {
      leadDone = res;
    });
    const quoteP = new Promise<void>((res) => {
      quoteDone = res;
    });

    const wLead = consume({
      db,
      queue: 'lead',
      role: 'lead-scorer',
      handler: async (env) => {
        leadSeen.push(env.intent);
        leadDone();
        return { ok: true };
      },
    });
    const wQuote = consume({
      db,
      queue: 'quote',
      role: 'quote-builder',
      handler: async (env) => {
        quoteSeen.push(env.intent);
        quoteDone();
        return { ok: true };
      },
    });
    workers.push(wLead, wQuote);
    await Promise.all([wLead.waitUntilReady(), wQuote.waitUntilReady()]);

    await sendMessage(
      { db },
      {
        fromRole: 'src',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );
    await sendMessage(
      { db },
      {
        fromRole: 'src',
        toRole: 'quote-builder',
        intent: 'QUOTE.REQUESTED',
        payload: quoteRequestedPayload(),
      },
    );

    await Promise.all([leadP, quoteP]);
    expect(leadSeen).toEqual(['LEAD.NEW']);
    expect(quoteSeen).toEqual(['QUOTE.REQUESTED']);
  });
});
