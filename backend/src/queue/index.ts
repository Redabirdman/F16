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
import { Redis } from 'ioredis';
import { logger } from '../logger.js';

let _redis: Redis | null = null;

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
    q = new Queue(name, { connection: getRedis(), prefix: prefix() });
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
  return new Worker<T, R>(queueName, async (job) => processor(job.name, job.data), {
    connection: getRedis(),
    prefix: prefix(),
    concurrency: opts.concurrency ?? 1,
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
