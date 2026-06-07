/**
 * Ads pipeline repository — thin upsert / read helpers over the Meta
 * mirror (campaigns/adsets/ads) plus the creative registry and hourly
 * metrics time-series.
 *
 * Upsert semantics:
 *   The Meta poller (M12) keys every entity by Meta's natural ID
 *   (meta_campaign_id, meta_adset_id, meta_ad_id) and re-runs every 15
 *   minutes. Each helper does `INSERT ... ON CONFLICT (<meta key>) DO
 *   UPDATE` with `updated_at = now()` so subsequent polls overwrite the
 *   mirror in place — no diffing logic in the caller.
 *
 * Metrics overwrite:
 *   `ad_metrics_hourly` uses (ad_id, captured_at) as its primary key.
 *   Meta restates historical buckets as attribution settles, so
 *   `recordHourlyMetrics` upserts on that PK and overwrites all the
 *   metric columns. Callers are expected to truncate `captured_at` to
 *   the hour (`date_trunc('hour', …)`) before calling.
 *
 * No PII: nothing in this pipeline is PII (Meta IDs, ad copy, spend in
 * cents). No crypto module is involved.
 */
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { adMetricsHourly, ads, adsets, campaigns, creatives } from '../schema/index.js';
import type {
  Ad,
  AdMetricHourly,
  Adset,
  Campaign,
  Creative,
  NewAd,
  NewAdset,
  NewCampaign,
  NewCreative,
} from '../schema/ads.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Upsertable fields on campaigns (all optional except what's required at
 *  insert time on a fresh row — those are still optional here because the
 *  Meta poller may seed minimal data first and fill in later). */
export type UpsertCampaignInput = Omit<NewCampaign, 'id' | 'metaCampaignId' | 'createdAt'>;

export type UpsertAdsetInput = Omit<NewAdset, 'id' | 'metaAdsetId' | 'createdAt'>;

export type UpsertAdInput = Omit<NewAd, 'id' | 'metaAdId' | 'createdAt'>;

export type InsertCreativeInput = Omit<NewCreative, 'id' | 'createdAt'>;

/** Metric values for a single hourly bucket. */
export interface HourlyMetricsInput {
  impressions?: number;
  clicks?: number;
  ctr?: number | null;
  conversions?: number;
  costPerConversionCents?: number | null;
  spendCents?: bigint;
  frequency?: number | null;
  reach?: number | null;
  rawMetaPayload?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

export interface AdWithCreativeAndMetric extends Ad {
  creative: Creative | null;
  /** The most recent ad_metrics_hourly row for this ad, or null. */
  latestMetric: AdMetricHourly | null;
}

export interface AdsetWithAds extends Adset {
  ads: AdWithCreativeAndMetric[];
}

export interface CampaignWithAdsetsAndAds extends Campaign {
  adsets: AdsetWithAds[];
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

/**
 * Insert or update a campaign keyed by `metaCampaignId`. On conflict the
 * mutable fields are overwritten and `updated_at = now()`. Returns the
 * resulting row in both cases.
 */
export async function upsertCampaign(
  db: Database,
  metaCampaignId: string,
  partial: UpsertCampaignInput,
): Promise<Campaign> {
  const values: NewCampaign = {
    metaCampaignId,
    name: partial.name ?? '',
    objective: partial.objective ?? null,
    status: partial.status ?? null,
    productLine: partial.productLine ?? null,
    dailyBudgetCents: partial.dailyBudgetCents ?? null,
    lifetimeBudgetCents: partial.lifetimeBudgetCents ?? null,
    currency: partial.currency ?? 'EUR',
    startedAt: partial.startedAt ?? null,
    endedAt: partial.endedAt ?? null,
    rawMetaPayload: partial.rawMetaPayload ?? null,
  };

  const [row] = await db
    .insert(campaigns)
    .values(values)
    .onConflictDoUpdate({
      target: campaigns.metaCampaignId,
      set: {
        name: values.name,
        objective: values.objective,
        status: values.status,
        productLine: values.productLine,
        dailyBudgetCents: values.dailyBudgetCents,
        lifetimeBudgetCents: values.lifetimeBudgetCents,
        currency: values.currency,
        startedAt: values.startedAt,
        endedAt: values.endedAt,
        rawMetaPayload: values.rawMetaPayload,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  if (!row) throw new Error('upsertCampaign: insert returned no row');
  return row;
}

export async function upsertAdset(
  db: Database,
  metaAdsetId: string,
  partial: UpsertAdsetInput,
): Promise<Adset> {
  if (!partial.campaignId) throw new Error('upsertAdset: campaignId is required');

  const values: NewAdset = {
    campaignId: partial.campaignId,
    metaAdsetId,
    name: partial.name ?? '',
    status: partial.status ?? null,
    targeting: partial.targeting ?? null,
    dailyBudgetCents: partial.dailyBudgetCents ?? null,
    lifetimeBudgetCents: partial.lifetimeBudgetCents ?? null,
    optimizationGoal: partial.optimizationGoal ?? null,
    billingEvent: partial.billingEvent ?? null,
    rawMetaPayload: partial.rawMetaPayload ?? null,
  };

  const [row] = await db
    .insert(adsets)
    .values(values)
    .onConflictDoUpdate({
      target: adsets.metaAdsetId,
      set: {
        campaignId: values.campaignId,
        name: values.name,
        status: values.status,
        targeting: values.targeting,
        dailyBudgetCents: values.dailyBudgetCents,
        lifetimeBudgetCents: values.lifetimeBudgetCents,
        optimizationGoal: values.optimizationGoal,
        billingEvent: values.billingEvent,
        rawMetaPayload: values.rawMetaPayload,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  if (!row) throw new Error('upsertAdset: insert returned no row');
  return row;
}

export async function upsertAd(
  db: Database,
  metaAdId: string,
  partial: UpsertAdInput,
): Promise<Ad> {
  if (!partial.adsetId) throw new Error('upsertAd: adsetId is required');

  const values: NewAd = {
    adsetId: partial.adsetId,
    creativeId: partial.creativeId ?? null,
    metaAdId,
    name: partial.name ?? '',
    status: partial.status ?? null,
    primaryText: partial.primaryText ?? null,
    headline: partial.headline ?? null,
    description: partial.description ?? null,
    ctaType: partial.ctaType ?? null,
    fatigueScore: partial.fatigueScore ?? null,
    rawMetaPayload: partial.rawMetaPayload ?? null,
  };

  const [row] = await db
    .insert(ads)
    .values(values)
    .onConflictDoUpdate({
      target: ads.metaAdId,
      set: {
        adsetId: values.adsetId,
        creativeId: values.creativeId,
        name: values.name,
        status: values.status,
        primaryText: values.primaryText,
        headline: values.headline,
        description: values.description,
        ctaType: values.ctaType,
        fatigueScore: values.fatigueScore,
        rawMetaPayload: values.rawMetaPayload,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  if (!row) throw new Error('upsertAd: insert returned no row');
  return row;
}

/**
 * Insert a creative. No upsert here — creatives are content-addressed
 * (file_sha256 UNIQUE), so an identical asset will hard-reject and the
 * caller is expected to look up the existing row instead.
 */
export async function insertCreative(db: Database, input: InsertCreativeInput): Promise<Creative> {
  const [row] = await db
    .insert(creatives)
    .values({
      name: input.name,
      angle: input.angle,
      productLine: input.productLine ?? null,
      format: input.format,
      headline: input.headline ?? null,
      subCopy: input.subCopy ?? null,
      ctaText: input.ctaText ?? null,
      fileUrl: input.fileUrl,
      fileSha256: input.fileSha256,
      generationPrompt: input.generationPrompt ?? null,
      generationMeta: input.generationMeta ?? null,
      generatedBy: input.generatedBy ?? null,
    })
    .returning();

  if (!row) throw new Error('insertCreative: insert returned no row');
  return row;
}

// ---------------------------------------------------------------------------
// Hourly metrics
// ---------------------------------------------------------------------------

/**
 * Insert or overwrite a single hourly metrics bucket for `adId`. Caller
 * MUST truncate `hour` to the hour (e.g. `date_trunc('hour', now())`) —
 * the composite PK `(ad_id, captured_at)` is the authoritative dedup key.
 */
export async function recordHourlyMetrics(
  db: Database,
  adId: string,
  hour: Date,
  metrics: HourlyMetricsInput,
): Promise<void> {
  const impressions = metrics.impressions ?? 0;
  const clicks = metrics.clicks ?? 0;
  const conversions = metrics.conversions ?? 0;
  const spendCents = metrics.spendCents ?? 0n;
  // Auto-compute CTR if the caller didn't pass it and impressions > 0.
  const ctr =
    metrics.ctr !== undefined ? metrics.ctr : impressions > 0 ? clicks / impressions : null;

  await db
    .insert(adMetricsHourly)
    .values({
      adId,
      capturedAt: hour,
      impressions,
      clicks,
      ctr,
      conversions,
      costPerConversionCents: metrics.costPerConversionCents ?? null,
      spendCents,
      frequency: metrics.frequency ?? null,
      reach: metrics.reach ?? null,
      rawMetaPayload: metrics.rawMetaPayload ?? null,
    })
    .onConflictDoUpdate({
      target: [adMetricsHourly.adId, adMetricsHourly.capturedAt],
      set: {
        impressions,
        clicks,
        ctr,
        conversions,
        costPerConversionCents: metrics.costPerConversionCents ?? null,
        spendCents,
        frequency: metrics.frequency ?? null,
        reach: metrics.reach ?? null,
        rawMetaPayload: metrics.rawMetaPayload ?? null,
      },
    });
}

/** An ad joined with its most-recent hourly metric (or null if never polled). */
export interface AdWithLatestMetric {
  ad: Ad;
  latestMetric: AdMetricHourly | null;
}

/**
 * All ads (optionally filtered by status) each joined with their latest
 * `ad_metrics_hourly` row. Used by the fatigue scorer + learning loop. One
 * round-trip for ads, one batched DISTINCT ON for the latest metric.
 */
export async function getAdsWithLatestMetric(
  db: Database,
  opts: { statuses?: string[] } = {},
): Promise<AdWithLatestMetric[]> {
  const adRows =
    opts.statuses && opts.statuses.length > 0
      ? await db.select().from(ads).where(inArray(ads.status, opts.statuses))
      : await db.select().from(ads);
  if (adRows.length === 0) return [];

  const adIds = adRows.map((a) => a.id);
  const latest: AdMetricHourly[] = (await db.execute(sql`
    SELECT DISTINCT ON (ad_id)
      ad_id                       AS "adId",
      captured_at                 AS "capturedAt",
      impressions,
      clicks,
      ctr,
      conversions,
      cost_per_conversion_cents   AS "costPerConversionCents",
      spend_cents                 AS "spendCents",
      frequency,
      reach,
      raw_meta_payload            AS "rawMetaPayload"
    FROM ad_metrics_hourly
    WHERE ad_id = ANY(${sql.raw(`ARRAY[${adIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
    ORDER BY ad_id, captured_at DESC
  `)) as unknown as AdMetricHourly[];

  const byAd = new Map<string, AdMetricHourly>();
  for (const m of latest) byAd.set(m.adId, m);
  return adRows.map((ad) => ({ ad, latestMetric: byAd.get(ad.id) ?? null }));
}

/** Persist a computed fatigue score (0..1) on an ad. */
export async function setAdFatigueScore(
  db: Database,
  adId: string,
  fatigueScore: number,
): Promise<void> {
  await db
    .update(ads)
    .set({ fatigueScore, updatedAt: sql`now()` })
    .where(eq(ads.id, adId));
}

/** Range query — all metrics rows for an ad in `[from, to]`, ASC by time. */
export async function getMetricsForAd(
  db: Database,
  adId: string,
  from: Date,
  to: Date,
): Promise<AdMetricHourly[]> {
  return db
    .select()
    .from(adMetricsHourly)
    .where(
      and(
        eq(adMetricsHourly.adId, adId),
        gte(adMetricsHourly.capturedAt, from),
        lte(adMetricsHourly.capturedAt, to),
      ),
    )
    .orderBy(asc(adMetricsHourly.capturedAt));
}

// ---------------------------------------------------------------------------
// Tree read
// ---------------------------------------------------------------------------

/**
 * Returns the full campaign tree: campaign → adsets → ads → creative +
 * latest hourly metric row per ad. Three round-trips (campaign, adsets,
 * ads-with-creatives), plus one extra to pull the latest metric per ad in
 * a single batched query.
 *
 * Volume note: a campaign typically holds <50 adsets and <500 ads in
 * Assuryal's setup, so the in-memory join is cheap. If this ever grows
 * past O(10⁴) ads, rewrite as a SQL CTE.
 */
export async function getCampaignTree(
  db: Database,
  campaignId: string,
): Promise<CampaignWithAdsetsAndAds | null> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) return null;

  const adsetRows = await db.select().from(adsets).where(eq(adsets.campaignId, campaignId));

  if (adsetRows.length === 0) {
    return { ...campaign, adsets: [] };
  }

  const adsetIds = adsetRows.map((a) => a.id);

  // Fetch ads + their creatives (LEFT JOIN — creative_id may be null).
  const adRows = await db
    .select({
      ad: ads,
      creative: creatives,
    })
    .from(ads)
    .leftJoin(creatives, eq(ads.creativeId, creatives.id))
    .where(inArray(ads.adsetId, adsetIds));

  // Latest metric per ad — single round-trip via DISTINCT ON.
  const adIds = adRows.map((r) => r.ad.id);
  const latestMetrics: AdMetricHourly[] =
    adIds.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT DISTINCT ON (ad_id)
            ad_id                       AS "adId",
            captured_at                 AS "capturedAt",
            impressions,
            clicks,
            ctr,
            conversions,
            cost_per_conversion_cents   AS "costPerConversionCents",
            spend_cents                 AS "spendCents",
            frequency,
            reach,
            raw_meta_payload            AS "rawMetaPayload"
          FROM ad_metrics_hourly
          WHERE ad_id = ANY(${sql.raw(`ARRAY[${adIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
          ORDER BY ad_id, captured_at DESC
        `)) as unknown as AdMetricHourly[]);

  const latestByAdId = new Map<string, AdMetricHourly>();
  for (const m of latestMetrics) latestByAdId.set(m.adId, m);

  const adsByAdsetId = new Map<string, AdWithCreativeAndMetric[]>();
  for (const { ad, creative } of adRows) {
    const enriched: AdWithCreativeAndMetric = {
      ...ad,
      creative,
      latestMetric: latestByAdId.get(ad.id) ?? null,
    };
    const list = adsByAdsetId.get(ad.adsetId) ?? [];
    list.push(enriched);
    adsByAdsetId.set(ad.adsetId, list);
  }

  return {
    ...campaign,
    adsets: adsetRows.map((adset) => ({
      ...adset,
      ads: adsByAdsetId.get(adset.id) ?? [],
    })),
  };
}
