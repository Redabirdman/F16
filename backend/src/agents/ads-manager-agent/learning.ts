/**
 * Ads learning loop (M12 Phase 2).
 *
 * Daily job that scores every ad by the metric that actually matters to
 * Assuryal — LEADS PER SPEND — using F16's own attributed leads (not Meta's
 * modeled conversions), joined to the spend mirror. It persists a ranked
 * snapshot so the Ad Expert (Phase 3 drafting) can lean toward the angles /
 * creatives that converted and away from the ones that burned budget.
 *
 * "Leads" here = leads whose `attribution.adId` matches the ad's Meta id in the
 * window (the M12 webhook stamps that on every paid lead). cost-per-lead is in
 * cents; ads with spend but zero leads sort worst.
 *
 * V1 persistence: the snapshot is written to the audit log (forensic + admin
 * visibility) and logged. Phase 3 wires it into the drafting prompt + a
 * knowledge doc.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { appendAudit } from '../../db/repositories/audit-log.js';

export interface AdPerformance {
  metaAdId: string;
  name: string;
  impressions: number;
  clicks: number;
  ctr: number | null;
  spendCents: number;
  leads: number;
  /** Spend per attributed lead, cents. null when leads = 0. */
  costPerLeadCents: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Per-ad performance over the last `days` (default 7), ranked best→worst by
 * cost-per-lead (ads with leads first, cheapest CPL on top; zero-lead ads with
 * spend last).
 */
export async function computeAdPerformance(
  db: Database,
  opts: { days?: number; now?: Date } = {},
): Promise<AdPerformance[]> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - (opts.days ?? 7) * DAY_MS);

  const rows = (await db.execute(sql`
    SELECT
      a.meta_ad_id AS "metaAdId",
      a.name       AS "name",
      COALESCE(SUM(m.impressions), 0)::bigint AS "impressions",
      COALESCE(SUM(m.clicks), 0)::bigint      AS "clicks",
      COALESCE(SUM(m.spend_cents), 0)::bigint AS "spendCents",
      (
        SELECT COUNT(*) FROM leads l
        WHERE l.source = 'meta'
          AND l.attribution->>'adId' = a.meta_ad_id
          AND l.created_at >= ${from}
      )::bigint AS "leads"
    FROM ads a
    LEFT JOIN ad_metrics_hourly m ON m.ad_id = a.id AND m.captured_at >= ${from}
    GROUP BY a.id, a.meta_ad_id, a.name
  `)) as unknown as Array<{
    metaAdId: string;
    name: string;
    impressions: string | number;
    clicks: string | number;
    spendCents: string | number;
    leads: string | number;
  }>;

  const perf: AdPerformance[] = rows.map((r) => {
    const impressions = Number(r.impressions);
    const clicks = Number(r.clicks);
    const spendCents = Number(r.spendCents);
    const leads = Number(r.leads);
    return {
      metaAdId: r.metaAdId,
      name: r.name,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : null,
      spendCents,
      leads,
      costPerLeadCents: leads > 0 ? Math.round(spendCents / leads) : null,
    };
  });

  // Rank: ads with leads first (cheapest CPL on top), then zero-lead ads by
  // spend descending (most wasteful first → clearest rotation candidates).
  perf.sort((a, b) => {
    if (a.leads > 0 && b.leads > 0) return (a.costPerLeadCents ?? 0) - (b.costPerLeadCents ?? 0);
    if (a.leads > 0) return -1;
    if (b.leads > 0) return 1;
    return b.spendCents - a.spendCents;
  });
  return perf;
}

export interface LearningSnapshotResult {
  ads: number;
  totalLeads: number;
  totalSpendCents: number;
}

/**
 * Compute + persist the daily performance snapshot. No-ops quietly when there
 * are no ads yet (fresh account). Writes one audit row with the ranked top/
 * bottom for forensic + admin visibility.
 */
export async function runLearningSnapshot(
  db: Database,
  opts: { days?: number; now?: Date } = {},
): Promise<LearningSnapshotResult> {
  const perf = await computeAdPerformance(db, opts);
  const totalLeads = perf.reduce((s, p) => s + p.leads, 0);
  const totalSpendCents = perf.reduce((s, p) => s + p.spendCents, 0);

  if (perf.length === 0) {
    return { ads: 0, totalLeads: 0, totalSpendCents: 0 };
  }

  const top = perf.filter((p) => p.leads > 0).slice(0, 5);
  const worst = perf.filter((p) => p.leads === 0 && p.spendCents > 0).slice(0, 5);

  try {
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'ads-manager-agent#singleton',
      action: 'ads.learning.snapshot',
      targetType: 'account',
      targetId: 'meta-ads',
      after: {
        windowDays: opts.days ?? 7,
        ads: perf.length,
        totalLeads,
        totalSpendCents,
        topByCpl: top.map((p) => ({
          name: p.name,
          leads: p.leads,
          costPerLeadCents: p.costPerLeadCents,
          ctr: p.ctr,
        })),
        worstSpendNoLeads: worst.map((p) => ({ name: p.name, spendCents: p.spendCents })),
      },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'ads-learning: audit write failed (non-blocking)',
    );
  }

  logger.info(
    { ads: perf.length, totalLeads, totalSpendCents, topCount: top.length },
    'ads-learning: snapshot recorded',
  );
  return { ads: perf.length, totalLeads, totalSpendCents };
}
