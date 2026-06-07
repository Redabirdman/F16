/**
 * Meta ads mirror sync (M12 Phase 2).
 *
 * Pulls the campaign→adset→ad structure + per-ad insights from the Graph API
 * and upserts them into the local mirror (campaigns/adsets/ads + the hourly
 * metrics time-series). Keyed by Meta's natural IDs, so every run overwrites
 * the mirror in place — no diffing in the caller.
 *
 * Hourly bucket: metrics are written to a UTC hour boundary. Meta restates
 * intra-day numbers as attribution settles, so re-running within the same hour
 * upserts (overwrites) the bucket via the repo's composite PK.
 *
 * Orphan handling: an adset whose campaign wasn't returned (paging edge,
 * permission gap) is skipped rather than FK-violating — the next full run picks
 * it up once its parent appears.
 */
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { MetaGraphClient } from '../../integrations/meta/client.js';
import {
  listCampaigns,
  listAdsets,
  listAds,
  getAdInsights,
  type GetAdInsightsOptions,
} from '../../integrations/meta/ads-read.js';
import {
  upsertCampaign,
  upsertAdset,
  upsertAd,
  recordHourlyMetrics,
} from '../../db/repositories/ads.js';

export interface SyncResult {
  campaigns: number;
  adsets: number;
  ads: number;
  metrics: number;
  skippedAdsets: number;
  skippedAds: number;
}

export interface SyncOptions extends GetAdInsightsOptions {
  /** Override the metrics bucket time (tests). Default: current UTC hour. */
  now?: Date;
}

/** Truncate to the UTC hour boundary. */
function hourBucket(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
}

export async function syncAdAccount(
  db: Database,
  client: MetaGraphClient,
  adAccountId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const t0 = Date.now();

  // 1. Campaigns → map Meta id → our uuid.
  const campaigns = await listCampaigns(client, adAccountId);
  const campIdMap = new Map<string, string>();
  for (const c of campaigns) {
    const row = await upsertCampaign(db, c.metaCampaignId, {
      name: c.name,
      objective: c.objective,
      status: c.status,
      dailyBudgetCents: c.dailyBudgetCents,
      lifetimeBudgetCents: c.lifetimeBudgetCents,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      rawMetaPayload: c.raw,
    });
    campIdMap.set(c.metaCampaignId, row.id);
  }

  // 2. Adsets.
  const adsets = await listAdsets(client, adAccountId);
  const adsetIdMap = new Map<string, string>();
  let skippedAdsets = 0;
  for (const a of adsets) {
    const campaignId = a.metaCampaignId ? campIdMap.get(a.metaCampaignId) : undefined;
    if (!campaignId) {
      skippedAdsets += 1;
      continue;
    }
    const row = await upsertAdset(db, a.metaAdsetId, {
      campaignId,
      name: a.name,
      status: a.status,
      targeting: a.targeting,
      dailyBudgetCents: a.dailyBudgetCents,
      lifetimeBudgetCents: a.lifetimeBudgetCents,
      optimizationGoal: a.optimizationGoal,
      billingEvent: a.billingEvent,
      rawMetaPayload: a.raw,
    });
    adsetIdMap.set(a.metaAdsetId, row.id);
  }

  // 3. Ads.
  const ads = await listAds(client, adAccountId);
  const adIdMap = new Map<string, string>();
  let skippedAds = 0;
  for (const ad of ads) {
    const adsetId = ad.metaAdsetId ? adsetIdMap.get(ad.metaAdsetId) : undefined;
    if (!adsetId) {
      skippedAds += 1;
      continue;
    }
    const row = await upsertAd(db, ad.metaAdId, {
      adsetId,
      name: ad.name,
      status: ad.status,
      rawMetaPayload: ad.raw,
    });
    adIdMap.set(ad.metaAdId, row.id);
  }

  // 4. Per-ad insights → hourly metrics.
  const bucket = hourBucket(opts.now ?? new Date());
  const insights = await getAdInsights(client, adAccountId, {
    ...(opts.datePreset ? { datePreset: opts.datePreset } : {}),
  });
  let metrics = 0;
  for (const ins of insights) {
    const adId = adIdMap.get(ins.metaAdId);
    if (!adId) continue;
    await recordHourlyMetrics(db, adId, bucket, {
      impressions: ins.impressions,
      clicks: ins.clicks,
      ctr: ins.ctr,
      conversions: ins.conversions,
      spendCents: ins.spendCents,
      frequency: ins.frequency,
      reach: ins.reach,
      rawMetaPayload: ins.raw,
    });
    metrics += 1;
  }

  const result: SyncResult = {
    campaigns: campaigns.length,
    adsets: adsetIdMap.size,
    ads: adIdMap.size,
    metrics,
    skippedAdsets,
    skippedAds,
  };
  logger.info({ ...result, durationMs: Date.now() - t0 }, 'ads-sync: complete');
  return result;
}
