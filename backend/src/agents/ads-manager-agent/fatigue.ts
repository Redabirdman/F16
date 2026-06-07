/**
 * Ad fatigue detection (M12 Phase 2).
 *
 * Ridaa's rule: a HARD FREQUENCY CEILING → notify (no auto-pause; Tier-2). When
 * an active ad's latest frequency crosses the ceiling, F16 flags it to
 * Ridaa/Achraf via the existing human-action WhatsApp channel with a
 * recommendation to rotate the creative.
 *
 * Edge-triggered, so we notify ONCE per breach rather than every poll: the
 * fatigue score (frequency / ceiling, clamped 0..1) is persisted on the ad;
 * we only raise a human action on the rising edge (previous score < 1.0,
 * new score >= 1.0). Frequency rarely falls back below the ceiling, so this
 * naturally dedups without extra state.
 *
 * `ctrDropPct` (CTR decay vs the ad's recent baseline) is computed only for
 * the few breaching ads and included in the alert for context.
 */
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import * as humanActions from '../../db/repositories/human-actions.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import {
  getAdsWithLatestMetric,
  setAdFatigueScore,
  getMetricsForAd,
} from '../../db/repositories/ads.js';

export interface FatigueOptions {
  /** Frequency at/above which an ad is "fatigued". Default 3.0. */
  freqCeiling?: number;
  /** Ignore ads with fewer impressions in the latest bucket. Default 500. */
  minImpressions?: number;
}

export interface FatigueScanResult {
  scanned: number;
  breached: number;
  flagged: number;
}

const DAY_MS = 86_400_000;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** CTR decay of the latest bucket vs the mean of the prior 7 days (0..1). */
async function computeCtrDrop(db: Database, adId: string): Promise<number> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * DAY_MS);
  const rows = await getMetricsForAd(db, adId, from, to);
  if (rows.length < 2) return 0;
  const last = rows[rows.length - 1];
  const prior = rows.slice(0, -1).filter((r) => r.ctr !== null);
  if (!last || last.ctr === null || prior.length === 0) return 0;
  const baseline = prior.reduce((s, r) => s + (r.ctr ?? 0), 0) / prior.length;
  if (baseline <= 0) return 0;
  return clamp01((baseline - last.ctr) / baseline);
}

export async function scanAndFlagFatigue(
  db: Database,
  opts: FatigueOptions = {},
): Promise<FatigueScanResult> {
  const freqCeiling = opts.freqCeiling ?? 3.0;
  const minImpressions = opts.minImpressions ?? 500;

  const ads = await getAdsWithLatestMetric(db, { statuses: ['ACTIVE'] });
  let breached = 0;
  let flagged = 0;

  for (const { ad, latestMetric } of ads) {
    if (!latestMetric) continue;
    const freq = latestMetric.frequency ?? 0;
    const impressions = latestMetric.impressions ?? 0;

    const newScore = clamp01(freq / freqCeiling);
    const prevScore = ad.fatigueScore;
    await setAdFatigueScore(db, ad.id, newScore);

    const isBreach = freq >= freqCeiling && impressions >= minImpressions;
    const wasBreach = prevScore !== null && prevScore >= 1.0;
    if (isBreach) breached += 1;
    if (!isBreach || wasBreach) continue;

    // Rising edge → notify once.
    const ctrDropPct = await computeCtrDrop(db, ad.id);
    const summary =
      `Annonce « ${ad.name} » fatiguée : fréquence ${freq.toFixed(1)} ≥ ${freqCeiling.toFixed(1)}` +
      (ctrDropPct > 0 ? ` (CTR en baisse de ${Math.round(ctrDropPct * 100)} %)` : '') +
      `. Recommandation : rafraîchir le visuel ou mettre l'annonce en pause.`;

    const action = await humanActions.createAction(db, {
      createdByAgent: 'ads-manager-agent#singleton',
      correlationId: ad.id,
      intent: 'AD_FATIGUE',
      severity: 3,
      summary,
      options: [
        { id: 'rotate', label: 'Rafraîchir le visuel', kind: 'approve' },
        { id: 'pause', label: "Mettre l'annonce en pause", kind: 'approve' },
        { id: 'ignore', label: 'Laisser tourner', kind: 'reject' },
      ],
    });

    await sendMessage(
      { db },
      {
        fromRole: 'ads-manager-agent',
        fromInstance: 'singleton',
        toRole: 'human-router',
        intent: 'HUMAN_ACTION.REQUESTED',
        payload: { humanActionId: action.id, severity: 3, summary: action.summary },
        correlationId: ad.id,
        requiresHuman: true,
        priority: 4,
      },
    );

    try {
      await appendAudit(db, {
        actorType: 'agent',
        actorId: 'ads-manager-agent#singleton',
        action: 'ads.fatigue.detected',
        targetType: 'ad',
        targetId: ad.id,
        after: { frequency: freq, ctrDropPct, fatigueScore: newScore },
        meta: { humanActionId: action.id },
      });
    } catch {
      /* non-blocking */
    }

    logger.info(
      { adId: ad.id, frequency: freq, ctrDropPct, humanActionId: action.id },
      'ads-fatigue: flagged for rotation',
    );
    flagged += 1;
  }

  if (breached > 0 || flagged > 0) {
    logger.info({ scanned: ads.length, breached, flagged }, 'ads-fatigue: scan complete');
  }
  return { scanned: ads.length, breached, flagged };
}
