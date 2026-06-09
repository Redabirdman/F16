/**
 * Dead-letter queue tests (M16).
 *
 * Live-Redis gated (TEST_REDIS_URL). Exercises the full path: a worker whose
 * processor throws → BullMQ exhausts `attempts` → the `failed` handler in
 * createWorker parks the job on `${queue}-dlq` → list/replay/purge.
 *
 *   docker run -d --name f16-redis-dlq -p 6381:6379 redis:7-alpine
 *   TEST_REDIS_URL=redis://127.0.0.1:6381 pnpm test tests/queue/dlq.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getQueue, createWorker, shutdownQueues, __resetForTests } from '../../src/queue/index.js';
import { listDlq, countDlq, replayDlq, purgeDlq, dlqName } from '../../src/queue/dlq.js';

const liveUrl = process.env.TEST_REDIS_URL;
const d = describe.skipIf(!liveUrl);

async function waitFor(
  pred: () => Promise<boolean>,
  timeoutMs = Number(process.env.TEST_WAITFOR_MS) || 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out');
}

d('dead-letter queue', () => {
  let savedRedisUrl: string | undefined;
  let savedPrefix: string | undefined;
  const QUEUE = 'dlqtest';

  beforeEach(() => {
    savedRedisUrl = process.env.REDIS_URL;
    savedPrefix = process.env.BULLMQ_PREFIX;
    process.env.REDIS_URL = liveUrl!;
    process.env.BULLMQ_PREFIX = `f16-dlq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    __resetForTests();
  });

  afterEach(async () => {
    await purgeDlq(QUEUE).catch(() => {});
    await getQueue(QUEUE)
      .obliterate({ force: true })
      .catch(() => {});
    await shutdownQueues().catch(() => {});
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
    if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
    else process.env.BULLMQ_PREFIX = savedPrefix;
    __resetForTests();
  });

  it('parks a permanently-failed job on the DLQ', async () => {
    const worker = createWorker(QUEUE, async () => {
      throw new Error('always fails');
    });
    try {
      await worker.waitUntilReady();
      // attempts:1 → fails once, immediately dead-lettered.
      await getQueue(QUEUE).add('boom', { x: 1 }, { attempts: 1 });

      await waitFor(async () => (await countDlq(QUEUE)) >= 1);

      const records = await listDlq(QUEUE);
      expect(records).toHaveLength(1);
      expect(records[0]?.originalQueue).toBe(QUEUE);
      expect(records[0]?.jobName).toBe('boom');
      expect(records[0]?.data).toEqual({ x: 1 });
      expect(records[0]?.failedReason).toContain('always fails');
      expect(records[0]?.attemptsMade).toBe(1);
    } finally {
      await worker.close();
    }
  });

  it('replays a DLQ job back onto the original queue', async () => {
    // Worker that fails so the job lands in the DLQ, then we close it and
    // replay onto the (now worker-less) original queue and assert it waits.
    const worker = createWorker(QUEUE, async () => {
      throw new Error('nope');
    });
    await worker.waitUntilReady();
    await getQueue(QUEUE).add('redrive', { y: 2 }, { attempts: 1 });
    await waitFor(async () => (await countDlq(QUEUE)) >= 1);
    await worker.close(); // no consumer now

    const replayed = await replayDlq(QUEUE);
    expect(replayed).toBe(1);
    expect(await countDlq(QUEUE)).toBe(0);

    // The replayed job now waits on the original queue. (Omit the `waiting`
    // alias — it double-counts the `wait` list.)
    const counts = await getQueue(QUEUE).getJobCounts('wait', 'prioritized', 'delayed');
    const waiting = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
    expect(waiting).toBe(1);
  });

  it('purges the DLQ', async () => {
    await getQueue(dlqName(QUEUE)).add(
      'x',
      {
        originalQueue: QUEUE,
        jobName: 'x',
        data: {},
        failedReason: 'r',
        attemptsMade: 1,
        deadLetteredAt: 'now',
      },
      { attempts: 1 },
    );
    expect(await countDlq(QUEUE)).toBe(1);
    await purgeDlq(QUEUE);
    expect(await countDlq(QUEUE)).toBe(0);
  });
});
