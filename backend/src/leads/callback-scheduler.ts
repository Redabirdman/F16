/**
 * Paid-lead callback scheduler (M12).
 *
 * Periodic tick (default every 60s) that finds leads whose `callback_state`
 * is 'pending' and whose `callback_due_at` has arrived, then emits one
 * `VOICE.CALL_SCHEDULED` per lead to the voice-operator (which dials via the
 * OpenAI native-SIP bridge). It is the SINGLE emitter of callbacks for paid
 * leads — even a "Contactez-moi maintenant" lead flows through here (due = now,
 * dialed on the next tick), so there's exactly one idempotent code path.
 *
 * Why a `setInterval` over BullMQ delayed jobs: same rationale as the
 * engagement scheduler — at V1 scale a claim-by-UPDATE is cheaper than Redis
 * delayed-job bookkeeping, and it survives restarts (a due row is simply
 * re-found on the next boot).
 *
 * Idempotency / concurrency: each tick CLAIMS due rows with a single
 * `UPDATE ... WHERE callback_state='pending' RETURNING`, flipping them to
 * 'dispatched' atomically. Two overlapping ticks can't double-dial — the
 * second sees no 'pending' rows. If the emit then fails, the row is reverted
 * to 'pending' so the next tick retries. A lead with no usable phone is marked
 * 'cancelled'.
 *
 * PII discipline: the phone is decrypted only to hand to the voice-operator;
 * it is NEVER logged. Logs key on leadId + callId.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { customers, leads } from '../db/schema/index.js';
import { decryptPII } from '../db/crypto.js';
import { sendMessage } from '../messaging/dispatcher.js';
import { logger } from '../logger.js';

const DEFAULT_INTERVAL_MS = 60_000;

export interface CallbackSchedulerOptions {
  db: Database;
  /** Tick cadence in ms. Default 60s. Tests pass small values. */
  intervalMs?: number;
}

export interface CallbackTickResult {
  emitted: number;
  cancelled: number;
  failed: number;
}

export interface CallbackSchedulerHandle {
  scheduler: NodeJS.Timeout;
  /** Stop the interval. Idempotent. */
  stop(): void;
  /** Test seam: run one tick synchronously. Returns counts. */
  tickOnce(): Promise<CallbackTickResult>;
}

/**
 * One scheduler pass — exported so tests can drive it deterministically
 * (the scheduler factory auto-fires a tick on start, which races assertions).
 * Claims all due, pending callbacks atomically, then dials each.
 */
export async function runCallbackTick(db: Database): Promise<CallbackTickResult> {
  const now = new Date();
  let emitted = 0;
  let cancelled = 0;
  let failed = 0;
  try {
    // Atomically claim every due, pending callback.
    const claimed = await db
      .update(leads)
      .set({ callbackState: 'dispatched', updatedAt: now })
      .where(
        and(
          eq(leads.callbackState, 'pending'),
          isNotNull(leads.callbackDueAt),
          lte(leads.callbackDueAt, now),
        ),
      )
      .returning({ id: leads.id, customerId: leads.customerId });

    for (const row of claimed) {
      try {
        if (!row.customerId) {
          await db
            .update(leads)
            .set({ callbackState: 'cancelled', updatedAt: new Date() })
            .where(eq(leads.id, row.id));
          cancelled += 1;
          continue;
        }
        const [c] = await db
          .select()
          .from(customers)
          .where(eq(customers.id, row.customerId))
          .limit(1);
        const phone = c ? decryptPII(c.phone) : null;
        if (!phone) {
          await db
            .update(leads)
            .set({ callbackState: 'cancelled', updatedAt: new Date() })
            .where(eq(leads.id, row.id));
          logger.warn({ leadId: row.id }, 'callback-scheduler: no phone, cancelled');
          cancelled += 1;
          continue;
        }

        const callId = randomUUID();
        await sendMessage(
          { db },
          {
            fromRole: 'callback-scheduler',
            toRole: 'voice-operator',
            intent: 'VOICE.CALL_SCHEDULED',
            payload: {
              callId,
              customerId: row.customerId,
              toNumber: phone,
              scheduledAt: now.toISOString(),
            },
            correlationId: row.id,
            priority: 3,
          },
        );
        logger.info({ leadId: row.id, callId }, 'callback-scheduler: callback dispatched');
        emitted += 1;
      } catch (err) {
        // Emit failed — revert so the next tick retries this row.
        failed += 1;
        await db
          .update(leads)
          .set({ callbackState: 'pending', updatedAt: new Date() })
          .where(eq(leads.id, row.id))
          .catch(() => {
            /* best-effort revert; next boot re-scans anyway */
          });
        logger.warn(
          { leadId: row.id, err: err instanceof Error ? err.message : String(err) },
          'callback-scheduler: dispatch failed, reverted to pending',
        );
      }
    }

    if (claimed.length > 0) {
      logger.info(
        { claimed: claimed.length, emitted, cancelled, failed },
        'callback-scheduler: tick complete',
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'callback-scheduler: tick failed',
    );
  }
  return { emitted, cancelled, failed };
}

/**
 * Timed MESSAGE follow-up pass (2026-07-08 — « reparlez-moi dans 10 min »).
 *
 * Same claim-by-UPDATE idempotency as the call callbacks, but the outcome is
 * a CUSTOMER.FOLLOWUP_DUE envelope to the sales agent (cascadeName
 * 'timed-followup'), which runs a system-initiated LLM turn and messages the
 * customer on their last inbound channel. No phone decryption needed here —
 * channel resolution happens in the sales-agent handler.
 */
export async function runFollowupTick(db: Database): Promise<CallbackTickResult> {
  const now = new Date();
  let emitted = 0;
  let cancelled = 0;
  let failed = 0;
  try {
    const claimed = await db
      .update(leads)
      .set({ followupState: 'dispatched', updatedAt: now })
      .where(
        and(
          eq(leads.followupState, 'pending'),
          isNotNull(leads.followupDueAt),
          lte(leads.followupDueAt, now),
        ),
      )
      .returning({
        id: leads.id,
        customerId: leads.customerId,
        dueAt: leads.followupDueAt,
        topic: leads.followupTopic,
      });

    for (const row of claimed) {
      try {
        if (!row.customerId) {
          await db
            .update(leads)
            .set({ followupState: 'cancelled', updatedAt: new Date() })
            .where(eq(leads.id, row.id));
          cancelled += 1;
          continue;
        }
        await sendMessage(
          { db },
          {
            fromRole: 'callback-scheduler',
            toRole: 'sales-agent',
            intent: 'CUSTOMER.FOLLOWUP_DUE',
            payload: {
              customerId: row.customerId,
              cascadeName: 'timed-followup',
              stepIndex: 0,
              leadId: row.id,
              ...(row.topic ? { topic: row.topic } : {}),
              ...(row.dueAt ? { dueAt: row.dueAt.toISOString() } : {}),
            },
            correlationId: row.id,
            priority: 3,
          },
        );
        logger.info({ leadId: row.id }, 'followup-tick: timed follow-up dispatched');
        emitted += 1;
      } catch (err) {
        failed += 1;
        await db
          .update(leads)
          .set({ followupState: 'pending', updatedAt: new Date() })
          .where(eq(leads.id, row.id))
          .catch(() => {
            /* best-effort revert; next boot re-scans anyway */
          });
        logger.warn(
          { leadId: row.id, err: err instanceof Error ? err.message : String(err) },
          'followup-tick: dispatch failed, reverted to pending',
        );
      }
    }

    if (claimed.length > 0) {
      logger.info(
        { claimed: claimed.length, emitted, cancelled, failed },
        'followup-tick: tick complete',
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'followup-tick: tick failed',
    );
  }
  return { emitted, cancelled, failed };
}

export function startCallbackScheduler(opts: CallbackSchedulerOptions): CallbackSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tick = async (): Promise<CallbackTickResult> => {
    // Voice callbacks first (time-critical dials), then message follow-ups.
    const calls = await runCallbackTick(opts.db);
    const followups = await runFollowupTick(opts.db);
    return {
      emitted: calls.emitted + followups.emitted,
      cancelled: calls.cancelled + followups.cancelled,
      failed: calls.failed + followups.failed,
    };
  };

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
