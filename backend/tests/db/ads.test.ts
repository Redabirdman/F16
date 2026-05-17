/**
 * Live-DB integration tests for the ads pipeline (M2.T5).
 * Gated on TEST_DATABASE_URL — skipped otherwise so `pnpm test` stays
 * hermetic in CI environments without a Postgres container.
 *
 * Covers the invariants the Meta ads pipeline (M12) will rely on:
 *   - upsert idempotency on Meta natural keys (meta_campaign_id, …)
 *   - cascade delete: campaign → adset → ad (creatives survive)
 *   - set null: deleting a creative leaves ads.creative_id = null
 *   - composite PK on ad_metrics_hourly (ad_id, captured_at) UNIQUE
 *   - recordHourlyMetrics overwrites on conflict (Meta restates)
 *   - file_sha256 UNIQUE — content-addressed creative dedup
 *   - getCampaignTree returns a fully nested object
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq, asc } from 'drizzle-orm';
import { createDb } from '../../src/db/index.js';
import { campaigns, adsets, ads, creatives, adMetricsHourly } from '../../src/db/schema/index.js';
import {
  upsertCampaign,
  upsertAdset,
  upsertAd,
  insertCreative,
  recordHourlyMetrics,
  getCampaignTree,
  getMetricsForAd,
} from '../../src/db/repositories/ads.js';

const liveUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!liveUrl);

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedKey;
});

d('ads pipeline (live)', () => {
  const db = createDb(liveUrl!);

  beforeEach(async () => {
    // Cascades hit ad_metrics_hourly + ads + adsets, but we wipe explicitly
    // so a stray FK doesn't leave orphaned creatives between tests.
    await db.execute(sql`TRUNCATE TABLE ad_metrics_hourly RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE ads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE adsets RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE campaigns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE creatives RESTART IDENTITY CASCADE`);
  });

  function randomSha(): string {
    return randomBytes(32).toString('hex');
  }

  it('test 1: inserts campaign → adset → ad → creative tree; getCampaignTree returns nested object', async () => {
    const campaign = await upsertCampaign(db, 'meta_c_1', {
      name: 'Scooter Q3 Push',
      objective: 'OUTCOME_LEADS',
      status: 'ACTIVE',
      productLine: 'scooter',
      dailyBudgetCents: 5000n,
      currency: 'EUR',
    });

    const adset = await upsertAdset(db, 'meta_as_1', {
      campaignId: campaign.id,
      name: 'Paris 25-45 men',
      status: 'ACTIVE',
      targeting: { geo: ['FR-75'], ageMin: 25, ageMax: 45 },
      optimizationGoal: 'LEAD_GENERATION',
      billingEvent: 'IMPRESSIONS',
    });

    const creative = await insertCreative(db, {
      name: 'scooter-fear-v1-9x16',
      angle: 'Fear',
      productLine: 'scooter',
      format: '9:16',
      headline: 'Et si on vous volait votre scooter cette nuit ?',
      ctaText: 'Obtenir un devis',
      fileUrl: 's3://bucket/scooter-fear-v1-9x16.png',
      fileSha256: randomSha(),
      generatedBy: 'ai-nano-banana',
    });

    const ad = await upsertAd(db, 'meta_ad_1', {
      adsetId: adset.id,
      creativeId: creative.id,
      name: 'scooter-fear-v1',
      status: 'ACTIVE',
      primaryText: 'Assurance scooter en 2 minutes',
      headline: 'Vol couvert dès le 1er jour',
      ctaType: 'LEARN_MORE',
    });

    const tree = await getCampaignTree(db, campaign.id);
    expect(tree).not.toBeNull();
    expect(tree!.id).toBe(campaign.id);
    expect(tree!.adsets).toHaveLength(1);
    expect(tree!.adsets[0]!.id).toBe(adset.id);
    expect(tree!.adsets[0]!.ads).toHaveLength(1);
    expect(tree!.adsets[0]!.ads[0]!.id).toBe(ad.id);
    expect(tree!.adsets[0]!.ads[0]!.creative).not.toBeNull();
    expect(tree!.adsets[0]!.ads[0]!.creative!.id).toBe(creative.id);
    expect(tree!.adsets[0]!.ads[0]!.creative!.angle).toBe('Fear');
    expect(tree!.adsets[0]!.ads[0]!.latestMetric).toBeNull();
  });

  it('test 2: upsertCampaign is idempotent on meta_campaign_id, updates updated_at', async () => {
    const first = await upsertCampaign(db, 'meta_c_idem', {
      name: 'v1 name',
      status: 'PAUSED',
      currency: 'EUR',
    });

    // Sleep 1ms so updated_at advances on the same row.
    await new Promise((r) => setTimeout(r, 5));

    const second = await upsertCampaign(db, 'meta_c_idem', {
      name: 'v2 name',
      status: 'ACTIVE',
      currency: 'EUR',
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('v2 name');
    expect(second.status).toBe('ACTIVE');
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());

    const all = await db.select().from(campaigns);
    expect(all).toHaveLength(1);
  });

  it('test 3: cascade delete campaign → adsets → ads (creatives survive)', async () => {
    const campaign = await upsertCampaign(db, 'meta_c_casc', {
      name: 'casc',
      currency: 'EUR',
    });
    const adset = await upsertAdset(db, 'meta_as_casc', {
      campaignId: campaign.id,
      name: 'as',
    });
    const creative = await insertCreative(db, {
      name: 'survivor',
      angle: 'Value',
      format: '1:1',
      fileUrl: 's3://x.png',
      fileSha256: randomSha(),
    });
    await upsertAd(db, 'meta_ad_casc', {
      adsetId: adset.id,
      creativeId: creative.id,
      name: 'ad',
    });

    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));

    const adsetRows = await db.select().from(adsets);
    const adRows = await db.select().from(ads);
    const creativeRows = await db.select().from(creatives);

    expect(adsetRows).toHaveLength(0);
    expect(adRows).toHaveLength(0);
    expect(creativeRows).toHaveLength(1);
    expect(creativeRows[0]!.id).toBe(creative.id);
  });

  it('test 4: deleting a creative sets ads.creative_id = null (ad survives)', async () => {
    const campaign = await upsertCampaign(db, 'meta_c_setnull', {
      name: 'sn',
      currency: 'EUR',
    });
    const adset = await upsertAdset(db, 'meta_as_setnull', {
      campaignId: campaign.id,
      name: 'as',
    });
    const creative = await insertCreative(db, {
      name: 'to-delete',
      angle: 'Speed',
      format: '4:5',
      fileUrl: 's3://td.png',
      fileSha256: randomSha(),
    });
    const ad = await upsertAd(db, 'meta_ad_setnull', {
      adsetId: adset.id,
      creativeId: creative.id,
      name: 'ad',
    });

    await db.delete(creatives).where(eq(creatives.id, creative.id));

    const [survivor] = await db.select().from(ads).where(eq(ads.id, ad.id));
    expect(survivor).toBeDefined();
    expect(survivor!.creativeId).toBeNull();
  });

  it('test 5: recordHourlyMetrics for 2 hours → getMetricsForAd returns both in time order', async () => {
    const campaign = await upsertCampaign(db, 'meta_c_m5', {
      name: 'm5',
      currency: 'EUR',
    });
    const adset = await upsertAdset(db, 'meta_as_m5', {
      campaignId: campaign.id,
      name: 'as',
    });
    const ad = await upsertAd(db, 'meta_ad_m5', {
      adsetId: adset.id,
      name: 'ad',
    });

    const h0 = new Date('2026-05-17T10:00:00Z');
    const h1 = new Date('2026-05-17T11:00:00Z');

    await recordHourlyMetrics(db, ad.id, h0, {
      impressions: 1000,
      clicks: 25,
      ctr: 0.025,
      conversions: 3,
      spendCents: 5000n,
    });
    await recordHourlyMetrics(db, ad.id, h1, {
      impressions: 1500,
      clicks: 40,
      ctr: 40 / 1500,
      conversions: 5,
      spendCents: 7500n,
    });

    const rows = await getMetricsForAd(
      db,
      ad.id,
      new Date('2026-05-17T09:00:00Z'),
      new Date('2026-05-17T12:00:00Z'),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.capturedAt.toISOString()).toBe(h0.toISOString());
    expect(rows[0]!.impressions).toBe(1000);
    expect(rows[1]!.capturedAt.toISOString()).toBe(h1.toISOString());
    expect(rows[1]!.impressions).toBe(1500);
  });

  it('test 6: recordHourlyMetrics overwrites on (ad_id, captured_at) conflict (Meta restates)', async () => {
    const campaign = await upsertCampaign(db, 'meta_c_m6', {
      name: 'm6',
      currency: 'EUR',
    });
    const adset = await upsertAdset(db, 'meta_as_m6', {
      campaignId: campaign.id,
      name: 'as',
    });
    const ad = await upsertAd(db, 'meta_ad_m6', { adsetId: adset.id, name: 'ad' });

    const h = new Date('2026-05-17T14:00:00Z');

    // First read: low numbers (Meta hasn't fully attributed yet).
    await recordHourlyMetrics(db, ad.id, h, {
      impressions: 500,
      clicks: 10,
      conversions: 1,
      spendCents: 2000n,
    });

    // Same hour, re-polled — Meta returns higher numbers after attribution.
    await recordHourlyMetrics(db, ad.id, h, {
      impressions: 800,
      clicks: 18,
      conversions: 2,
      spendCents: 3500n,
    });

    const rows = await db.select().from(adMetricsHourly).where(eq(adMetricsHourly.adId, ad.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.impressions).toBe(800);
    expect(rows[0]!.clicks).toBe(18);
    expect(rows[0]!.conversions).toBe(2);
    expect(rows[0]!.spendCents).toBe(3500n);
  });

  it('test 7: creatives.file_sha256 UNIQUE — same sha rejected', async () => {
    const sha = randomSha();
    await insertCreative(db, {
      name: 'first',
      angle: 'Legal',
      format: '1:1',
      fileUrl: 's3://a.png',
      fileSha256: sha,
    });

    await expect(
      insertCreative(db, {
        name: 'duplicate',
        angle: 'Legal',
        format: '1:1',
        fileUrl: 's3://b.png',
        fileSha256: sha,
      }),
    ).rejects.toThrow();
  });

  it('test 8: composite PK uniqueness — manual INSERT with same (ad_id, captured_at) fails', async () => {
    const campaign = await upsertCampaign(db, 'meta_c_m8', {
      name: 'm8',
      currency: 'EUR',
    });
    const adset = await upsertAdset(db, 'meta_as_m8', {
      campaignId: campaign.id,
      name: 'as',
    });
    const ad = await upsertAd(db, 'meta_ad_m8', { adsetId: adset.id, name: 'ad' });

    const h = new Date('2026-05-17T15:00:00Z');

    await db.insert(adMetricsHourly).values({
      adId: ad.id,
      capturedAt: h,
      impressions: 100,
      clicks: 5,
      conversions: 0,
      spendCents: 200n,
    });

    await expect(
      db.insert(adMetricsHourly).values({
        adId: ad.id,
        capturedAt: h,
        impressions: 999,
        clicks: 99,
        conversions: 0,
        spendCents: 999n,
      }),
    ).rejects.toThrow();
  });

  // Suppress unused-import lint warnings — these are referenced by drizzle's
  // schema reflection above, but tsc-test sometimes flags them.
  void asc;
});
