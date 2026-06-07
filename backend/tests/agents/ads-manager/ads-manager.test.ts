/**
 * Ads Manager (M12 Phase 2) — sync + fatigue + learning.
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL (fatigue emits HUMAN_ACTION via
 * BullMQ). A stub MetaGraphClient (URL-routed fetch) feeds canned Graph data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { MetaGraphClient } from '../../../src/integrations/meta/client.js';
import { agentMessages, ads, campaigns, leads } from '../../../src/db/schema/index.js';
import { syncAdAccount } from '../../../src/agents/ads-manager-agent/sync.js';
import { scanAndFlagFatigue } from '../../../src/agents/ads-manager-agent/fatigue.js';
import {
  computeAdPerformance,
  runLearningSnapshot,
} from '../../../src/agents/ads-manager-agent/learning.js';
import { __resetForTests, shutdownQueues } from '../../../src/queue/index.js';

/** MetaGraphClient whose fetch is routed by URL to canned Graph payloads. */
function stubClient(routes: { match: string; body: unknown }[]): MetaGraphClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const route = routes.find((r) => url.includes(r.match));
    return new Response(JSON.stringify(route ? route.body : { data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return new MetaGraphClient({ accessToken: 'T', fetchImpl, sleepMs: () => Promise.resolve() });
}

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const d = describe.skipIf(!(pgUrl && redisUrl));

let savedPiiKey: string | undefined;
let savedRedisUrl: string | undefined;
let savedPrefix: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY)
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  savedRedisUrl = process.env.REDIS_URL;
  savedPrefix = process.env.BULLMQ_PREFIX;
});
afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
  if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
  else process.env.BULLMQ_PREFIX = savedPrefix;
});

d('ads-manager (live)', () => {
  let db: Database;

  beforeEach(async () => {
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    __resetForTests();
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE campaigns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
  });
  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  function fullTreeClient(opts: { frequency: number; impressions: number }) {
    return stubClient([
      {
        match: '/campaigns',
        body: {
          data: [
            {
              id: 'C1',
              name: 'Trottinette',
              objective: 'OUTCOME_LEADS',
              status: 'ACTIVE',
              daily_budget: '5000',
            },
          ],
        },
      },
      {
        match: '/adsets',
        body: { data: [{ id: 'AS1', name: 'France', status: 'ACTIVE', campaign_id: 'C1' }] },
      },
      {
        match: '/ads',
        body: { data: [{ id: 'AD1', name: 'Fear V1', status: 'ACTIVE', adset_id: 'AS1' }] },
      },
      {
        match: '/insights',
        body: {
          data: [
            {
              ad_id: 'AD1',
              impressions: String(opts.impressions),
              clicks: '40',
              ctr: '4.0',
              spend: '20.00',
              reach: '500',
              frequency: String(opts.frequency),
            },
          ],
        },
      },
    ]);
  }

  it('syncs the campaign→adset→ad tree + hourly metrics', async () => {
    const client = fullTreeClient({ frequency: 1.2, impressions: 1000 });
    const res = await syncAdAccount(db, client, '123');
    expect(res).toMatchObject({ campaigns: 1, adsets: 1, ads: 1, metrics: 1 });

    const camp = await db.select().from(campaigns);
    expect(camp).toHaveLength(1);
    expect(camp[0]!.metaCampaignId).toBe('C1');
    expect(camp[0]!.dailyBudgetCents).toBe(5000n);

    const adRows = await db.select().from(ads);
    expect(adRows[0]!.metaAdId).toBe('AD1');
    expect(adRows[0]!.status).toBe('ACTIVE');
  });

  it('flags fatigue once on the rising edge (frequency ≥ ceiling)', async () => {
    // Sync with a HIGH frequency above the 3.0 ceiling.
    const client = fullTreeClient({ frequency: 3.5, impressions: 2000 });
    await syncAdAccount(db, client, '123');

    const first = await scanAndFlagFatigue(db, { freqCeiling: 3.0, minImpressions: 500 });
    expect(first.breached).toBe(1);
    expect(first.flagged).toBe(1);

    // Ad fatigue score persisted at 1.0; a human action + WA emit exist.
    const adRow = (await db.select().from(ads))[0]!;
    expect(adRow.fatigueScore).toBeGreaterThanOrEqual(1.0);
    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.intent, 'HUMAN_ACTION.REQUESTED'));
    expect(msgs.length).toBeGreaterThanOrEqual(1);

    // Second scan: still breached, but NOT re-flagged (edge-triggered dedup).
    const second = await scanAndFlagFatigue(db, { freqCeiling: 3.0, minImpressions: 500 });
    expect(second.breached).toBe(1);
    expect(second.flagged).toBe(0);
  });

  it('does not flag below the ceiling', async () => {
    const client = fullTreeClient({ frequency: 1.5, impressions: 2000 });
    await syncAdAccount(db, client, '123');
    const res = await scanAndFlagFatigue(db, { freqCeiling: 3.0, minImpressions: 500 });
    expect(res.flagged).toBe(0);
    expect(res.breached).toBe(0);
  });

  it('computes leads-per-spend in the learning snapshot', async () => {
    const client = fullTreeClient({ frequency: 1.2, impressions: 1000 });
    await syncAdAccount(db, client, '123');
    // Two attributed meta leads on AD1.
    for (let i = 0; i < 2; i++) {
      await db.insert(leads).values({
        source: 'meta',
        productLine: 'scooter',
        status: 'new',
        metaLeadgenId: `LG${i}`,
        attribution: { adId: 'AD1' },
      });
    }
    const perf = await computeAdPerformance(db, { days: 7 });
    const ad1 = perf.find((p) => p.metaAdId === 'AD1')!;
    expect(ad1.leads).toBe(2);
    expect(ad1.spendCents).toBe(2000); // 20.00 EUR/USD
    expect(ad1.costPerLeadCents).toBe(1000); // 2000 / 2

    const snap = await runLearningSnapshot(db, { days: 7 });
    expect(snap.ads).toBeGreaterThanOrEqual(1);
    expect(snap.totalLeads).toBe(2);
  });
});
