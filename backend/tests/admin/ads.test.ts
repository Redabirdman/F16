/**
 * Admin ads surface (M14 V2.5) — DB-backed integration test.
 *
 * Seeds a campaign → adset → ad tree, a creative, and a creative_learning,
 * then verifies the single-bundle shape (campaign counts, creatives, learnings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { campaigns, adsets, ads, creatives, creativeLearnings } from '../../src/db/schema/index.js';
import { buildAdminAdsRouter } from '../../src/admin/ads.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

d('GET /v1/admin/ads', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminAdsRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    // Cascades clean the adset/ad tree; truncate the registries too.
    await db.execute(sql`TRUNCATE TABLE campaigns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE creatives RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE creative_learnings RESTART IDENTITY CASCADE`);
    app = buildAdminAdsRouter({ db });
  });

  it('returns empty arrays on an empty database', async () => {
    const res = await app.request('/v1/admin/ads');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      campaigns: unknown[];
      creatives: unknown[];
      learnings: unknown[];
    };
    expect(body.campaigns).toEqual([]);
    expect(body.creatives).toEqual([]);
    expect(body.learnings).toEqual([]);
  });

  it('bundles campaigns (with counts), creatives, and learnings', async () => {
    const [cp] = await db
      .insert(campaigns)
      .values({
        metaCampaignId: 'camp-1',
        name: 'Trottinette France',
        objective: 'OUTCOME_LEADS',
        status: 'PAUSED',
        productLine: 'scooter',
        dailyBudgetCents: 5000n,
        currency: 'EUR',
      })
      .returning();
    const [as1] = await db
      .insert(adsets)
      .values({ campaignId: cp!.id, metaAdsetId: 'as-1', name: 'AS 1', status: 'PAUSED' })
      .returning();
    await db
      .insert(ads)
      .values({ adsetId: as1!.id, metaAdId: 'ad-1', name: 'Ad 1', status: 'PAUSED' });
    await db
      .insert(ads)
      .values({ adsetId: as1!.id, metaAdId: 'ad-2', name: 'Ad 2', status: 'PAUSED' });

    await db.insert(creatives).values({
      name: 'scooter-speed-v1-9x16',
      angle: 'speed',
      productLine: 'scooter',
      format: '9:16',
      headline: 'Roulez assuré',
      ctaText: 'Devis gratuit',
      fileUrl: 'https://example.com/c1.png',
      fileSha256: 'sha-1',
      generatedBy: 'ai-nano-banana',
    });

    await db.insert(creativeLearnings).values({
      angle: null,
      guidance: 'On assure uniquement les trottinettes électriques debout, jamais assises.',
      sourceFeedback: 'ce ne sont pas des scooters assis',
      createdByAgent: 'creative-agent#x',
    });

    const res = await app.request('/v1/admin/ads');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      campaigns: Array<{
        metaCampaignId: string;
        dailyBudgetCents: number | null;
        adsetCount: number;
        adCount: number;
      }>;
      creatives: Array<{ name: string; angle: string; generatedBy: string | null }>;
      learnings: Array<{ angle: string | null; guidance: string }>;
    };

    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0]!.metaCampaignId).toBe('camp-1');
    expect(body.campaigns[0]!.dailyBudgetCents).toBe(5000);
    expect(body.campaigns[0]!.adsetCount).toBe(1);
    expect(body.campaigns[0]!.adCount).toBe(2);

    expect(body.creatives).toHaveLength(1);
    expect(body.creatives[0]!.name).toBe('scooter-speed-v1-9x16');
    expect(body.creatives[0]!.angle).toBe('speed');
    expect(body.creatives[0]!.generatedBy).toBe('ai-nano-banana');

    expect(body.learnings).toHaveLength(1);
    expect(body.learnings[0]!.angle).toBeNull();
    expect(body.learnings[0]!.guidance).toMatch(/trottinettes électriques debout/);
  });
});
