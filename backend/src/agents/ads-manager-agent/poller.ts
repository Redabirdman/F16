/**
 * Ads Manager schedulers (M12 Phase 2).
 *
 * Two setInterval loops (same rationale as the engagement + callback
 * schedulers — cheaper than BullMQ repeatable jobs at V1 scale, self-reseeding
 * on restart):
 *
 *   - startAdsPoller — every 15 min: sync the Meta mirror, then scan for
 *     fatigue (frequency-ceiling → WhatsApp notify).
 *   - startAdsLearningScheduler — daily: compute + persist the leads-per-spend
 *     performance snapshot.
 *
 * Each tick is wrapped so a transient Graph/DB error logs and waits for the
 * next interval instead of crashing the loop.
 */
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { MetaGraphClient } from '../../integrations/meta/client.js';
import { syncAdAccount, type SyncResult } from './sync.js';
import { scanAndFlagFatigue, type FatigueOptions, type FatigueScanResult } from './fatigue.js';
import { runLearningSnapshot, type LearningSnapshotResult } from './learning.js';

const DEFAULT_POLL_MS = 15 * 60_000;
const DEFAULT_LEARNING_MS = 24 * 3_600_000;

export interface AdsPollerOptions {
  db: Database;
  client: MetaGraphClient;
  adAccountId: string;
  intervalMs?: number;
  /** Insights window per poll. Default 'today'. */
  datePreset?: string;
  fatigue?: FatigueOptions;
}

export interface AdsPollerHandle {
  scheduler: NodeJS.Timeout;
  stop(): void;
  tickOnce(): Promise<{ sync: SyncResult; fatigue: FatigueScanResult } | null>;
}

export function startAdsPoller(opts: AdsPollerOptions): AdsPollerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;

  const tick = async (): Promise<{ sync: SyncResult; fatigue: FatigueScanResult } | null> => {
    try {
      const sync = await syncAdAccount(opts.db, opts.client, opts.adAccountId, {
        ...(opts.datePreset ? { datePreset: opts.datePreset } : {}),
      });
      const fatigue = await scanAndFlagFatigue(opts.db, opts.fatigue ?? {});
      return { sync, fatigue };
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'ads-poller: tick failed',
      );
      return null;
    }
  };

  void tick();
  const scheduler = setInterval(() => void tick(), intervalMs);
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

export interface AdsLearningOptions {
  db: Database;
  intervalMs?: number;
  /** Performance window in days. Default 7. */
  days?: number;
}

export interface AdsLearningHandle {
  scheduler: NodeJS.Timeout;
  stop(): void;
  tickOnce(): Promise<LearningSnapshotResult | null>;
}

export function startAdsLearningScheduler(opts: AdsLearningOptions): AdsLearningHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_LEARNING_MS;

  const tick = async (): Promise<LearningSnapshotResult | null> => {
    try {
      return await runLearningSnapshot(opts.db, { ...(opts.days ? { days: opts.days } : {}) });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'ads-learning: tick failed',
      );
      return null;
    }
  };

  void tick();
  const scheduler = setInterval(() => void tick(), intervalMs);
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
