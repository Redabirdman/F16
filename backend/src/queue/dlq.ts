/**
 * Dead-letter queue (M16 hardening).
 *
 * When a BullMQ job exhausts its retry budget (`attemptsMade >= attempts`)
 * the worker-`failed` handler in `./index.ts` hands it here. We re-enqueue a
 * descriptive record onto a sibling `${queue}-dlq` queue that has NO worker —
 * so the job parks in the `wait` state as a durable, inspectable record
 * instead of silently vanishing into BullMQ's trimmed `failed` set.
 *
 * Ops surface (also exposed via `scripts/dlq.ts`):
 *   - listDlq(queue)    → inspect parked records
 *   - replayDlq(queue)  → re-drive onto the original queue + clear from DLQ
 *   - purgeDlq(queue)   → obliterate the DLQ
 *
 * A DLQ record carries the ORIGINAL job's name + data, so a replay re-enqueues
 * exactly what failed (the dispatcher's jobs carry just `{ messageId }`, so the
 * durable agent_messages row is the real source of truth — replay re-points
 * BullMQ at it).
 */
import type { Job } from 'bullmq';
import { getQueue } from './index.js';
import { logger } from '../logger.js';
import { recordJobDeadLettered } from '../metrics/index.js';

export interface DlqRecord {
  originalQueue: string;
  jobName: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  deadLetteredAt: string;
}

/**
 * DLQ companion name for a queue. Kept in one place so list/replay agree.
 * NOTE: BullMQ forbids `:` in queue names (it's the Redis key separator), so
 * we use a `-dlq` suffix.
 */
export function dlqName(queue: string): string {
  return `${queue}-dlq`;
}

/**
 * Park a permanently-failed job on the DLQ. Best-effort + never throws —
 * a DLQ write failing must not crash the worker. Increments the
 * `f16_jobs_dead_lettered_total{queue}` counter and logs a structured
 * error marker (`dlq`) so ops alerting can key off either.
 */
export async function moveToDlq(originalQueue: string, job: Job): Promise<void> {
  const record: DlqRecord = {
    originalQueue,
    jobName: job.name,
    data: job.data,
    failedReason: job.failedReason ?? 'unknown',
    attemptsMade: job.attemptsMade,
    deadLetteredAt: new Date().toISOString(),
  };
  try {
    recordJobDeadLettered(originalQueue);
    await getQueue(dlqName(originalQueue)).add(job.name, record, {
      // Park forever: no retries, never auto-removed — this IS the record.
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
    logger.error(
      {
        dlq: true,
        queue: originalQueue,
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        failedReason: record.failedReason,
      },
      'job dead-lettered after exhausting retries',
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), queue: originalQueue },
      'failed to write to dead-letter queue',
    );
  }
}

/**
 * Parked job states. We deliberately omit the `waiting` alias — BullMQ's
 * `getJobCounts`/`getJobs` treat `wait` and `waiting` as the SAME list, so
 * passing both double-counts. `prioritized` covers any job added with a
 * priority; `paused` covers a paused queue.
 */
const PARKED_STATES = ['wait', 'prioritized', 'delayed', 'paused'] as const;

/** Read parked DLQ records (newest BullMQ jobs first up to `limit`). */
export async function listDlq(queue: string, limit = 100): Promise<DlqRecord[]> {
  const q = getQueue(dlqName(queue));
  const jobs = await q.getJobs([...PARKED_STATES], 0, limit - 1, false);
  return jobs.map((j) => j.data as DlqRecord);
}

/** Count parked DLQ records. */
export async function countDlq(queue: string): Promise<number> {
  const q = getQueue(dlqName(queue));
  const counts = await q.getJobCounts(...PARKED_STATES);
  return Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
}

/**
 * Re-drive parked DLQ jobs back onto their original queue, then clear them
 * from the DLQ. Returns the number re-driven. With no worker on the DLQ the
 * jobs sit in `wait`, so we drain that state.
 */
export async function replayDlq(queue: string, limit = 100): Promise<number> {
  const dlq = getQueue(dlqName(queue));
  const jobs = await dlq.getJobs([...PARKED_STATES], 0, limit - 1, false);
  let replayed = 0;
  for (const j of jobs) {
    const rec = j.data as DlqRecord;
    await getQueue(rec.originalQueue).add(rec.jobName, rec.data, { attempts: 5 });
    await j.remove();
    replayed += 1;
  }
  if (replayed > 0) logger.info({ queue, replayed }, 'replayed dead-letter jobs');
  return replayed;
}

/** Wipe the DLQ entirely. */
export async function purgeDlq(queue: string): Promise<void> {
  await getQueue(dlqName(queue)).obliterate({ force: true });
}
