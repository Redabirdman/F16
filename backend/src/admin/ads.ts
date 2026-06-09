/**
 * Admin ads surface (M14 V2.5).
 *
 *   GET /v1/admin/ads
 *     Single round-trip bundle of the M12 ads pipeline state for the admin:
 *       - campaigns  (most recent first) + per-campaign adset/ad counts
 *       - creatives  (the Assuryal-side asset registry, newest first)
 *       - learnings  (creative_learnings — the distilled, durable brand/creative
 *                     guidance the system learns from Ridaa's feedback)
 *
 * Read-only. Budgets are returned as integer cents (never floats) plus the
 * currency, so the UI formats them without drift. All lists are bounded so a
 * busy account can't blow up the payload; the admin is an at-a-glance panel,
 * not a reporting warehouse.
 *
 * No PII here — the ads domain holds no customer identifiers, only Meta object
 * ids + creative copy + aggregate guidance.
 */
import { Hono } from 'hono';
import { sql, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { campaigns, adsets, ads, creatives, creativeLearnings } from '../db/schema/index.js';

export interface AdminAdsRouterOptions {
  db: Database;
}

const CAMPAIGN_LIMIT = 50;
const CREATIVE_LIMIT = 100;
const LEARNING_LIMIT = 100;

export interface AdminCampaign {
  id: string;
  metaCampaignId: string;
  name: string;
  objective: string | null;
  status: string | null;
  productLine: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  currency: string;
  adsetCount: number;
  adCount: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AdminCreative {
  id: string;
  name: string;
  angle: string;
  productLine: string | null;
  format: string;
  headline: string | null;
  subCopy: string | null;
  ctaText: string | null;
  fileUrl: string;
  generatedBy: string | null;
  createdAt: string;
}

export interface AdminCreativeLearning {
  id: string;
  angle: string | null;
  guidance: string;
  sourceFeedback: string | null;
  createdByAgent: string | null;
  createdAt: string;
}

export interface AdminAdsResponse {
  generatedAt: string;
  campaigns: AdminCampaign[];
  creatives: AdminCreative[];
  learnings: AdminCreativeLearning[];
}

/** bigint|null cents → number|null (budgets are well within Number range). */
function centsToNumber(v: bigint | null): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function buildAdminAdsRouter(opts: AdminAdsRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/ads', async (c) => {
    const [campaignRows, adsetCountRows, adCountRows, creativeRows, learningRows] =
      await Promise.all([
        opts.db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(CAMPAIGN_LIMIT),
        // adsets per campaign
        opts.db
          .select({
            campaignId: adsets.campaignId,
            n: sql<number>`count(*)::int`,
          })
          .from(adsets)
          .groupBy(adsets.campaignId),
        // ads per campaign (join through adsets)
        opts.db
          .select({
            campaignId: adsets.campaignId,
            n: sql<number>`count(*)::int`,
          })
          .from(ads)
          .innerJoin(adsets, eq(ads.adsetId, adsets.id))
          .groupBy(adsets.campaignId),
        opts.db.select().from(creatives).orderBy(desc(creatives.createdAt)).limit(CREATIVE_LIMIT),
        opts.db
          .select()
          .from(creativeLearnings)
          .orderBy(desc(creativeLearnings.createdAt))
          .limit(LEARNING_LIMIT),
      ]);

    const adsetCountByCampaign = new Map<string, number>();
    for (const r of adsetCountRows) adsetCountByCampaign.set(r.campaignId, r.n);
    const adCountByCampaign = new Map<string, number>();
    for (const r of adCountRows) {
      if (r.campaignId) adCountByCampaign.set(r.campaignId, r.n);
    }

    const body: AdminAdsResponse = {
      generatedAt: new Date().toISOString(),
      campaigns: campaignRows.map((r) => ({
        id: r.id,
        metaCampaignId: r.metaCampaignId,
        name: r.name,
        objective: r.objective,
        status: r.status,
        productLine: r.productLine,
        dailyBudgetCents: centsToNumber(r.dailyBudgetCents),
        lifetimeBudgetCents: centsToNumber(r.lifetimeBudgetCents),
        currency: r.currency,
        adsetCount: adsetCountByCampaign.get(r.id) ?? 0,
        adCount: adCountByCampaign.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      })),
      creatives: creativeRows.map((r) => ({
        id: r.id,
        name: r.name,
        angle: r.angle,
        productLine: r.productLine,
        format: r.format,
        headline: r.headline,
        subCopy: r.subCopy,
        ctaText: r.ctaText,
        fileUrl: r.fileUrl,
        generatedBy: r.generatedBy,
        createdAt: r.createdAt.toISOString(),
      })),
      learnings: learningRows.map((r) => ({
        id: r.id,
        angle: r.angle,
        guidance: r.guidance,
        sourceFeedback: r.sourceFeedback,
        createdByAgent: r.createdByAgent,
        createdAt: r.createdAt.toISOString(),
      })),
    };
    return c.json(body, 200);
  });

  return app;
}
