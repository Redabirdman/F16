/**
 * BullMQ + Redis client factory for @f16/backend.
 *
 * Singleton ioredis connection wrapped behind `getRedis()` (lazy — importing
 * this module must not require REDIS_URL, so tests can stub env and tooling
 * can import without a running Redis). `getQueue()` memoizes Queue instances
 * per name so callers can fan out enqueues without managing lifecycle.
 *
 * NOTE: BullMQ requires `maxRetriesPerRequest: null` on the underlying
 * ioredis client; otherwise the blocking commands BullMQ uses (BRPOPLPUSH,
 * XREADGROUP) will fail intermittently. We also disable readyCheck because
 * BullMQ does its own.
 */
import { Queue, Worker, QueueEvents } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { metrics, recordJobCompleted, recordJobFailed, queueDepthGauge } from '../metrics/index.js';
import { moveToDlq } from './dlq.js';

let _redis: Redis | null = null;

/**
 * Default retry policy applied to EVERY job (M16 hardening). A transient
 * failure (Redis blip, Maxance 502, Graph rate-limit) is retried with
 * exponential backoff instead of dying on the first throw. Per-`add` options
 * override these key-by-key, so the dispatcher's `priority`/`removeOn*` still
 * win while inheriting `attempts` + `backoff`. After `attempts` are exhausted
 * the worker-`failed` handler dead-letters the job (see ./dlq.ts).
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

/** Process-wide singleton ioredis client built from REDIS_URL. */
export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL not set');
    _redis = new Redis(url, {
      maxRetriesPerRequest: null, // BullMQ requires this
      enableReadyCheck: false,
    });
    _redis.on('error', (err) => logger.error({ err }, 'redis client error'));
    _redis.on('connect', () => logger.info('redis client connected'));
  }
  return _redis;
}

function prefix(): string {
  return process.env.BULLMQ_PREFIX ?? 'f16';
}

const _queues = new Map<string, Queue>();

/** Memoized Queue accessor — one instance per name per process. */
export function getQueue(name: string): Queue {
  let q = _queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getRedis(),
      prefix: prefix(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    _queues.set(name, q);
  }
  return q;
}

/**
 * Build a Worker bound to the shared redis singleton. Workers are NOT
 * memoized — callers own the lifecycle (typical pattern: one worker per
 * process, started at boot, awaited on shutdown).
 */
export function createWorker<T = unknown, R = unknown>(
  queueName: string,
  processor: (jobName: string, data: T) => Promise<R>,
  opts: { concurrency?: number } = {},
): Worker<T, R> {
  const worker = new Worker<T, R>(
    queueName,
    async (job) => {
      const startedAt = Date.now();
      const result = await processor(job.name, job.data);
      recordJobCompleted(queueName, (Date.now() - startedAt) / 1000);
      return result;
    },
    {
      connection: getRedis(),
      prefix: prefix(),
      concurrency: opts.concurrency ?? 1,
    },
  );

  // M16 — observe + dead-letter. `failed` fires on every failed attempt;
  // we count each, and once the job has exhausted its `attempts` budget we
  // park it on the DLQ (best-effort, never throws).
  worker.on('failed', (job, err) => {
    recordJobFailed(queueName);
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      void moveToDlq(queueName, job);
    } else {
      logger.warn(
        {
          queue: queueName,
          jobName: job.name,
          attemptsMade: job.attemptsMade,
          maxAttempts,
          err: err instanceof Error ? err.message : String(err),
        },
        'bullmq job failed — will retry',
      );
    }
  });
  worker.on('error', (err) =>
    logger.error(
      { err: err instanceof Error ? err.message : String(err), queue: queueName },
      'bullmq worker error',
    ),
  );

  return worker;
}

/**
 * Register a scrape-time collector that snapshots BullMQ job counts per
 * queue + state into the `f16_queue_depth` gauge. Call once at boot with
 * the set of live queue names — or a provider function when the set is only
 * known dynamically (role-scoped physical queues appear as traffic flows).
 * Idempotent-ish: registering twice just adds a second (harmless) collector
 * that overwrites the same series.
 */
export function registerQueueDepthCollector(
  queueNames: readonly string[] | (() => readonly string[]),
): void {
  const gauge = queueDepthGauge();
  metrics.registerCollector(async () => {
    const names = typeof queueNames === 'function' ? queueNames() : queueNames;
    for (const name of names) {
      const counts = await getQueue(name).getJobCounts(
        'wait',
        'active',
        'delayed',
        'failed',
        'completed',
        'paused',
      );
      for (const [state, n] of Object.entries(counts)) {
        gauge.set({ queue: name, state }, n ?? 0);
      }
    }
  });
}

/** Build a QueueEvents listener bound to the shared redis singleton. */
export function createQueueEvents(queueName: string): QueueEvents {
  return new QueueEvents(queueName, {
    connection: getRedis(),
    prefix: prefix(),
  });
}

/**
 * Close every memoized queue, then quit the redis singleton. Safe to call
 * multiple times. Workers are caller-owned and must be closed separately.
 */
export async function shutdownQueues(): Promise<void> {
  for (const q of _queues.values()) {
    await q.close();
  }
  _queues.clear();
  if (_redis) {
    await _redis.quit().catch(() => {
      // ignore — quit may race with an already-closing socket
    });
    _redis = null;
  }
}

/**
 * Test-only escape hatch — clears the cached singleton + queue map without
 * closing them. Callers MUST close any handles they grabbed before calling
 * this; otherwise sockets leak.
 */
export function __resetForTests(): void {
  _queues.clear();
  _redis = null;
}
