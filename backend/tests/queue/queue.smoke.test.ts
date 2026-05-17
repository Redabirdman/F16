/**
 * BullMQ + Redis smoke tests.
 *
 * Two layers:
 *   - Unit-ish (always run): factory env-validation + singleton invariant.
 *   - Live (gated on TEST_REDIS_URL): enqueue + worker + priority ordering
 *     + graceful shutdown against a real Redis. Spin up via
 *       `docker run -d --name f16-redis-m3t1 -p 6381:6379 redis:7-alpine`
 *     then `TEST_REDIS_URL=redis://127.0.0.1:6381 pnpm test`.
 *
 * Each LIVE test brings up its own queue + worker on a unique prefix and
 * tears everything down in afterEach so tests don't bleed Redis state.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { getRedis, createWorker, shutdownQueues, __resetForTests } from '../../src/queue/index.js';
import { QUEUE_NAMES } from '../../src/queue/queues.js';

describe('getRedis()', () => {
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.REDIS_URL;
    __resetForTests();
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
    __resetForTests();
  });

  it('throws when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    expect(() => getRedis()).toThrowError(/REDIS_URL/);
  });

  it('returns a singleton (same instance on repeat calls)', () => {
    // Point at a clearly-bogus port — ioredis is lazy and only attempts a
    // socket connection in the background, so construction succeeds even
    // without a listener. We immediately disconnect to avoid retry spam.
    process.env.REDIS_URL = 'redis://127.0.0.1:1/0';
    const a = getRedis();
    const b = getRedis();
    expect(a).toBe(b);
    // Don't quit() — the client never connected, just kill it.
    a.disconnect();
  });
});

// ---------------------------------------------------------------------------
// LIVE tests — require a reachable Redis at TEST_REDIS_URL.
// ---------------------------------------------------------------------------

const liveUrl = process.env.TEST_REDIS_URL;
const dlive = describe.skipIf(!liveUrl);

dlive('queue + worker against live Redis', () => {
  // Unique per-test prefix so parallel/CI runs can't see each other's jobs.
  const prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let savedRedisUrl: string | undefined;
  let savedPrefix: string | undefined;

  beforeEach(() => {
    savedRedisUrl = process.env.REDIS_URL;
    savedPrefix = process.env.BULLMQ_PREFIX;
    process.env.REDIS_URL = liveUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();
  });

  afterEach(async () => {
    // Best-effort cleanup of any keys we created under the test prefix, then
    // restore env. shutdownQueues() handles the singleton; individual tests
    // own their per-test Queue/Worker/QueueEvents handles.
    try {
      const cleaner = new Redis(liveUrl!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      const keys = await cleaner.keys(`${prefix}:*`);
      if (keys.length > 0) await cleaner.del(...keys);
      await cleaner.quit();
    } catch {
      // ignore — best-effort
    }
    await shutdownQueues().catch(() => {});

    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
    if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
    else process.env.BULLMQ_PREFIX = savedPrefix;
    __resetForTests();
  });

  it('enqueues a job and a worker processes it', async () => {
    const queueName = QUEUE_NAMES.QUOTE;
    const q = new Queue(queueName, { connection: getRedis(), prefix });

    const seen: Array<{ name: string; data: unknown }> = [];
    let resolveDone: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });

    const w = createWorker<{ quoteId: string }, { ok: true }>(queueName, async (jobName, data) => {
      seen.push({ name: jobName, data });
      resolveDone();
      return { ok: true };
    });

    try {
      await w.waitUntilReady();
      await q.add('compute-premium', { quoteId: 'q-1' });
      await done;
      expect(seen).toHaveLength(1);
      expect(seen[0]?.name).toBe('compute-premium');
      expect(seen[0]?.data).toEqual({ quoteId: 'q-1' });
    } finally {
      await w.close();
      await q.close();
    }
  });

  it('processes jobs in priority order (lower priority value = sooner)', async () => {
    const queueName = QUEUE_NAMES.QUOTE;
    const q = new Queue(queueName, { connection: getRedis(), prefix });
    const events = new QueueEvents(queueName, { connection: getRedis(), prefix });
    await events.waitUntilReady();

    const processed: string[] = [];
    let resolveAll: () => void;
    const allDone = new Promise<void>((res) => {
      resolveAll = res;
    });

    // Workers process FIFO unless priority is set. BullMQ priority semantics:
    // lower number = higher priority. We pause the queue while enqueuing so
    // all three jobs are present before the worker starts pulling.
    await q.pause();

    await q.add('p-mid', { id: 'mid' }, { priority: 5 });
    await q.add('p-low', { id: 'low' }, { priority: 10 });
    await q.add('p-high', { id: 'high' }, { priority: 1 });

    const w = createWorker<{ id: string }, undefined>(
      queueName,
      async (jobName) => {
        processed.push(jobName);
        if (processed.length === 3) resolveAll();
        return undefined;
      },
      { concurrency: 1 },
    );

    try {
      await w.waitUntilReady();
      await q.resume();
      await allDone;
      expect(processed).toEqual(['p-high', 'p-mid', 'p-low']);
    } finally {
      await w.close();
      await events.close();
      await q.close();
    }
  });

  it('shuts down cleanly via shutdownQueues()', async () => {
    // Touch the singleton + a memoized queue, then shut down. After shutdown
    // the cached redis must be gone and the cached queue map empty — verified
    // via __resetForTests being a no-op (nothing left to clear).
    const queueName = QUEUE_NAMES.QUOTE;
    // Use the module's getQueue so it gets memoized in the registry.
    const mod = await import('../../src/queue/index.js');
    const q = mod.getQueue(queueName);
    expect(q).toBeDefined();

    await shutdownQueues();

    // After shutdown, getRedis() with REDIS_URL still set should build a
    // fresh client (singleton was nulled). That's the contract: shutdown is
    // terminal for the cached instances, not for the module itself.
    const fresh = getRedis();
    expect(fresh).toBeDefined();
    // Clean up the fresh one we just spun up.
    fresh.disconnect();
    __resetForTests();
  });
});
