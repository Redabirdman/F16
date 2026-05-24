/**
 * Customer Engagement scheduler (M11).
 *
 * Periodic tick (default every 5 minutes) that scans `findEngagementCandidates`
 * and emits one `ENGAGEMENT.TICK` per matching lead onto the `engagement`
 * queue. The EngagementAgent consumes them and enforces every per-lead gate
 * (eligible status, quiet hours, cadence step, anti-spam) authoritatively.
 *
 * Why a plain `setInterval` over BullMQ's repeatable jobs:
 *   - Same call-out as the Knowledge Curator (src/knowledge/curator.ts): at
 *     V1 scale (≤ a few hundred eligible leads), an interval is cheaper than
 *     Redis bookkeeping. On process restart the first tick re-seeds the
 *     enqueue cycle naturally.
 *   - Enqueueing one envelope per candidate sounds heavy but is bounded by
 *     `findEngagementCandidates`'s `limit` (200 default). The agent itself
 *     short-circuits most ticks with "threshold-not-reached" or "anti-spam"
 *     so the LLM/channel costs only land on the truly-due nudges.
 *
 * Idempotency: if two scheduler ticks run back-to-back (e.g. interval is
 * shorter than the agent's processing of the previous batch), the second
 * tick re-enqueues the same candidates. The agent's cadence + anti-spam
 * checks make this a no-op — at worst we waste a few BullMQ slots.
 */
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { findEngagementCandidates } from './candidate.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 minutes

export interface EngagementSchedulerOptions {
  db: Database;
  /** Tick cadence in ms. Default 5 minutes. Tests pass small values. */
  intervalMs?: number;
  /** Per-tick candidate cap forwarded to the query. Default 200. */
  candidateLimit?: number;
}

export interface EngagementSchedulerHandle {
  scheduler: NodeJS.Timeout;
  /** Stop the interval. Idempotent. */
  stop(): void;
  /** Test seam: run one tick synchronously without waiting for the interval. */
  tickOnce(): Promise<void>;
}

/**
 * Start the scheduler. Caller owns the handle and MUST call `stop()` on
 * shutdown — otherwise the interval keeps the Node event loop alive.
 *
 * First tick runs immediately so a fresh boot doesn't wait `intervalMs`
 * before issuing the first round. Matches the Knowledge Curator's behavior.
 */
export function startEngagementScheduler(
  opts: EngagementSchedulerOptions,
): EngagementSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const candidateLimit = opts.candidateLimit;

  const tick = async (): Promise<void> => {
    const t0 = Date.now();
    let enqueued = 0;
    let failed = 0;
    try {
      const candidates = await findEngagementCandidates(opts.db, {
        ...(candidateLimit !== undefined ? { limit: candidateLimit } : {}),
      });
      for (const c of candidates) {
        try {
          await sendMessage(
            { db: opts.db },
            {
              fromRole: 'engagement-scheduler',
              toRole: 'engagement-agent',
              toInstance: 'singleton',
              intent: 'ENGAGEMENT.TICK',
              payload: { leadId: c.leadId },
              correlationId: c.leadId,
              priority: 6,
            },
          );
          enqueued += 1;
        } catch (err) {
          failed += 1;
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), leadId: c.leadId },
            'engagement-scheduler: enqueue failed',
          );
        }
      }
      logger.info(
        {
          candidates: candidates.length,
          enqueued,
          failed,
          durationMs: Date.now() - t0,
        },
        'engagement-scheduler: tick complete',
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'engagement-scheduler: tick failed',
      );
    }
  };

  // First tick immediately. Fire-and-forget under a microtask so the
  // scheduler factory returns synchronously.
  void tick();
  const scheduler = setInterval(() => {
    void tick();
  }, intervalMs);

  let stopped = false;
  return {
    scheduler,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(scheduler);
    },
    tickOnce: tick,
  };
}
