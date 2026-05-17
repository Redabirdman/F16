/**
 * Ads pipeline schema (design §10 + §14).
 *
 * Models the Meta ad-tracking hierarchy plus an Assuryal-side creative
 * registry and an hourly time-series metrics table.
 *
 *   campaigns          (Meta top-of-funnel) ──┐
 *      └── adsets       (Meta middle tier) ───┤
 *            └── ads     (Meta lowest unit)   ├─ raw_meta_payload jsonb
 *                  ├── creative_id ──> creatives (Assuryal-side asset registry)
 *                  └── ad_metrics_hourly  (one row per ad per hour)
 *
 * `status` is intentionally NOT an enum — Meta adds values regularly
 * (e.g. 'IN_PROCESS', 'WITH_ISSUES'); a text column accepts new values
 * without a migration. Apps that need strict typing can layer zod at the
 * boundary.
 *
 * Cascade rules:
 *   - campaigns → adsets → ads: cascade. Deleting a campaign cleanly
 *     erases the Meta-side tree we mirror.
 *   - ads.creative_id → set null: a creative can be retired from disk
 *     (asset cleanup) without losing the ad row that referenced it.
 *   - ads → ad_metrics_hourly: cascade. Metrics rows are meaningless
 *     without their parent ad.
 *
 * Budgets are stored as cents in `bigint` to avoid float drift and to
 * cover lifetime budgets that can exceed int4. Currency is stored
 * separately (default 'EUR') — Meta returns budgets in account currency.
 *
 * `ad_metrics_hourly` uses a composite primary key on (ad_id, captured_at)
 * — no surrogate id. Meta restates metrics retroactively, so the poller
 * upserts on that PK to overwrite the bucket with the latest values.
 *
 * `creatives` are content-addressed via `file_sha256` (UNIQUE) so the
 * generation pipeline (M12) deduplicates identical AI outputs across runs.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  real,
  jsonb,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { productLineEnum } from './_enums.js';

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Meta Graph API campaign ID — the natural key we upsert on.
    metaCampaignId: text('meta_campaign_id').notNull(),

    name: text('name').notNull(),
    // Meta's campaign objective, e.g. 'OUTCOME_LEADS', 'OUTCOME_SALES'.
    objective: text('objective'),
    // 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED' | ... — kept as text.
    status: text('status'),

    productLine: productLineEnum('product_line'),

    // Lifetime XOR daily — Meta enforces the constraint; we don't.
    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'bigint' }),
    lifetimeBudgetCents: bigint('lifetime_budget_cents', { mode: 'bigint' }),
    currency: text('currency').notNull().default('EUR'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // When Meta first started serving the campaign (may lag created_at).
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    // Last-known full Meta API response — kept for diffing on next poll.
    rawMetaPayload: jsonb('raw_meta_payload').$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('campaigns_meta_campaign_id_uniq').on(t.metaCampaignId),
    index('campaigns_status_idx').on(t.status),
    index('campaigns_product_line_idx').on(t.productLine),
    index('campaigns_created_at_idx').on(sql`${t.createdAt} DESC`),
  ],
);

export const adsets = pgTable(
  'adsets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    campaignId: uuid('campaign_id')
      .references(() => campaigns.id, { onDelete: 'cascade' })
      .notNull(),

    metaAdsetId: text('meta_adset_id').notNull(),

    name: text('name').notNull(),
    status: text('status'),

    // Meta targeting spec — geo, age, interests, custom audiences.
    targeting: jsonb('targeting').$type<Record<string, unknown>>(),

    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'bigint' }),
    lifetimeBudgetCents: bigint('lifetime_budget_cents', { mode: 'bigint' }),

    // e.g. 'LEAD_GENERATION', 'LINK_CLICKS'.
    optimizationGoal: text('optimization_goal'),
    // e.g. 'IMPRESSIONS', 'LINK_CLICKS'.
    billingEvent: text('billing_event'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

    rawMetaPayload: jsonb('raw_meta_payload').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('adsets_campaign_id_idx').on(t.campaignId),
    uniqueIndex('adsets_meta_adset_id_uniq').on(t.metaAdsetId),
    index('adsets_status_idx').on(t.status),
  ],
);

export const creatives = pgTable(
  'creatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Human-readable handle, e.g. "scooter-fear-v1-9x16".
    name: text('name').notNull(),

    // Free-form: 'Fear' | 'Legal' | 'Value' | 'Speed' | 'Social' (scooter)
    // or 'Malus-Acceptation' | 'Pro-OutilDeTravail' | 'Bonus-Recompense' …
    // varies by product line; we keep it open so M12 can extend without
    // an enum migration.
    angle: text('angle').notNull(),

    productLine: productLineEnum('product_line'),

    // '1:1' | '4:5' | '9:16' | '16:9' — validated at the app boundary
    // (zod) so new aspect ratios don't require a migration.
    format: text('format').notNull(),

    headline: text('headline'),
    subCopy: text('sub_copy'),
    ctaText: text('cta_text'),

    // Where the rendered asset (PNG / MP4) lives — local path or S3 URL.
    fileUrl: text('file_url').notNull(),
    // Content-addressed dedup key (SHA-256 of the asset bytes, hex).
    fileSha256: text('file_sha256').notNull(),

    // Provenance for AI-generated creatives (Nano Banana Pro pipeline, M12).
    generationPrompt: text('generation_prompt'),
    generationMeta: jsonb('generation_meta').$type<Record<string, unknown>>(),
    // 'ai-nano-banana' | 'human' | 'imported'.
    generatedBy: text('generated_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Recall by (productLine, angle) — the M12 picker filters this way.
    index('creatives_product_line_angle_idx').on(t.productLine, t.angle),
    index('creatives_format_idx').on(t.format),
    // Content dedup — the same bytes can never be inserted twice.
    uniqueIndex('creatives_file_sha256_uniq').on(t.fileSha256),
    index('creatives_generated_by_idx').on(t.generatedBy),
  ],
);

export const ads = pgTable(
  'ads',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    adsetId: uuid('adset_id')
      .references(() => adsets.id, { onDelete: 'cascade' })
      .notNull(),

    // Set null on creative delete — keep the ad row's audit trail.
    creativeId: uuid('creative_id').references(() => creatives.id, {
      onDelete: 'set null',
    }),

    metaAdId: text('meta_ad_id').notNull(),

    name: text('name').notNull(),
    status: text('status'),

    // Meta ad copy fields — mirror what the Graph API exposes.
    primaryText: text('primary_text'),
    headline: text('headline'),
    description: text('description'),
    // Meta CTA enum value, e.g. 'LEARN_MORE', 'SIGN_UP', 'GET_QUOTE'.
    ctaType: text('cta_type'),

    // 0..1 — computed by the fatigue scorer (M12). Null until first calc.
    fatigueScore: real('fatigue_score'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

    rawMetaPayload: jsonb('raw_meta_payload').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('ads_adset_id_idx').on(t.adsetId),
    index('ads_creative_id_idx').on(t.creativeId),
    uniqueIndex('ads_meta_ad_id_uniq').on(t.metaAdId),
    index('ads_status_idx').on(t.status),
    // Most-fatigued first — the rotation worker pages from this order.
    // NULLS LAST so ads that haven't been scored yet sink to the bottom.
    index('ads_fatigue_score_idx').on(sql`${t.fatigueScore} DESC NULLS LAST`),
  ],
);

export const adMetricsHourly = pgTable(
  'ad_metrics_hourly',
  {
    adId: uuid('ad_id')
      .references(() => ads.id, { onDelete: 'cascade' })
      .notNull(),
    // Bucket-aligned hour: date_trunc('hour', captured_at). The poller is
    // responsible for truncation; the PK enforces no duplicates per hour.
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),

    impressions: integer('impressions').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    // clicks / impressions — null when impressions = 0 (no division).
    ctr: real('ctr'),
    // E.g. lead-form submits.
    conversions: integer('conversions').notNull().default(0),
    costPerConversionCents: integer('cost_per_conversion_cents'),
    spendCents: bigint('spend_cents', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    frequency: real('frequency'),
    reach: integer('reach'),

    rawMetaPayload: jsonb('raw_meta_payload').$type<Record<string, unknown>>(),
  },
  (t) => [
    // Composite PK — Meta restates retroactively, so the poller upserts
    // onto (ad_id, captured_at) and overwrites the bucket.
    primaryKey({ columns: [t.adId, t.capturedAt], name: 'ad_metrics_hourly_pkey' }),
    // Time-range scans (dashboard "last 24h") — captured_at desc.
    index('ad_metrics_hourly_captured_at_idx').on(sql`${t.capturedAt} DESC`),
  ],
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type Adset = typeof adsets.$inferSelect;
export type NewAdset = typeof adsets.$inferInsert;
export type Creative = typeof creatives.$inferSelect;
export type NewCreative = typeof creatives.$inferInsert;
export type Ad = typeof ads.$inferSelect;
export type NewAd = typeof ads.$inferInsert;
export type AdMetricHourly = typeof adMetricsHourly.$inferSelect;
export type NewAdMetricHourly = typeof adMetricsHourly.$inferInsert;
