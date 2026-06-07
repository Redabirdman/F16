/**
 * Meta leadgen webhook tests (M12).
 *
 * The handshake + signature-rejection cases are pure (no DB) and always run.
 * The leadgen→ingest cases are gated on TEST_DATABASE_URL + TEST_REDIS_URL
 * (ingestLead writes the lead + emits LEAD.NEW via BullMQ), same as the
 * intake tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { leads } from '../../src/db/schema/index.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';
import { buildMetaLeadgenRouter } from '../../src/http/meta-leadgen-webhook.js';
import type { LeadgenData } from '../../src/integrations/meta/client.js';
import type { MetaGraphClient } from '../../src/integrations/meta/client.js';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'verify-me';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

/** Fake Graph client returning a canned lead for any id. */
function fakeClient(lead: Partial<LeadgenData> & { id: string }): MetaGraphClient {
  return {
    getLeadgenData: async (id: string): Promise<LeadgenData> => ({
      id,
      createdTime: '2026-06-07T10:00:00+0000',
      fieldData: [],
      adId: 'AD1',
      adName: 'Ad',
      adsetId: 'AS1',
      adsetName: 'Adset',
      campaignId: 'C1',
      campaignName: 'Campaign',
      formId: 'F1',
      platform: 'fb',
      raw: {},
      ...lead,
    }),
  } as unknown as MetaGraphClient;
}

function leadgenBody(leadgenId: string): string {
  return JSON.stringify({
    object: 'page',
    entry: [
      {
        id: 'PAGE1',
        changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, form_id: 'F1' } }],
      },
    ],
  });
}

// --- Pure cases (no DB) -----------------------------------------------------
describe('meta leadgen webhook — handshake + signature', () => {
  const app = buildMetaLeadgenRouter({
    db: {} as Database,
    client: fakeClient({ id: 'x' }),
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
  });

  it('echoes hub.challenge when the verify token matches', async () => {
    const res = await app.request(
      `/v1/meta/leadgen-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHALLENGE42`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('CHALLENGE42');
  });

  it('rejects a wrong verify token with 403', async () => {
    const res = await app.request(
      `/v1/meta/leadgen-webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=X`,
    );
    expect(res.status).toBe(403);
  });

  it('rejects a body with a bad signature (401) before any processing', async () => {
    const body = leadgenBody('LEAD1');
    const res = await app.request('/v1/meta/leadgen-webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef', 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON with 400 (signature valid)', async () => {
    const body = 'not-json';
    const res = await app.request('/v1/meta/leadgen-webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(400);
  });
});

// --- Live cases (DB + Redis) ------------------------------------------------
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

d('meta leadgen webhook — ingest (live)', () => {
  let db: Database;

  beforeEach(async () => {
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    __resetForTests();
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
  });
  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  function appFor(lead: Partial<LeadgenData> & { id: string }) {
    return buildMetaLeadgenRouter({
      db,
      client: fakeClient(lead),
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });
  }

  it('ingests a whatsapp-preference lead with attribution', async () => {
    const app = appFor({
      id: 'LEAD_WA',
      fieldData: [
        { name: 'full_name', values: ['Jean Dupont'] },
        { name: 'phone_number', values: ['0612345678'] },
        { name: 'preferred_channel', values: ['Par WhatsApp'] },
        { name: 'preferred_time', values: ['Le matin'] },
      ],
    });
    const body = leadgenBody('LEAD_WA');
    const res = await app.request('/v1/meta/leadgen-webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);

    const rows = await db.select().from(leads).where(eq(leads.metaLeadgenId, 'LEAD_WA'));
    expect(rows).toHaveLength(1);
    const lead = rows[0]!;
    expect(lead.source).toBe('meta');
    expect(lead.preferredChannel).toBe('whatsapp');
    expect(lead.preferredTime).toBe('matin');
    expect(lead.callbackState).toBeNull(); // whatsapp → no callback
    expect((lead.attribution as Record<string, unknown>).campaignId).toBe('C1');
  });

  it('schedules a callback for a call-preference lead (pending + due time set)', async () => {
    const app = appFor({
      id: 'LEAD_CALL',
      fieldData: [
        { name: 'full_name', values: ['Marie Curie'] },
        { name: 'phone_number', values: ['0612345679'] },
        { name: 'preferred_channel', values: ['Par appel téléphonique'] },
        { name: 'preferred_time', values: ['Contactez-moi maintenant'] },
      ],
    });
    const body = leadgenBody('LEAD_CALL');
    await app.request('/v1/meta/leadgen-webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });

    const [lead] = await db.select().from(leads).where(eq(leads.metaLeadgenId, 'LEAD_CALL'));
    expect(lead!.preferredChannel).toBe('call');
    expect(lead!.callbackState).toBe('pending');
    expect(lead!.callbackDueAt).not.toBeNull();
  });

  it('dedups a redelivered leadgen id (idempotent)', async () => {
    const app = appFor({
      id: 'LEAD_DUP',
      fieldData: [{ name: 'phone_number', values: ['0612345680'] }],
    });
    const body = leadgenBody('LEAD_DUP');
    const h = { 'x-hub-signature-256': sign(body) };
    const r1 = await app.request('/v1/meta/leadgen-webhook', { method: 'POST', headers: h, body });
    const r2 = await app.request('/v1/meta/leadgen-webhook', { method: 'POST', headers: h, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const rows = await db.select().from(leads).where(eq(leads.metaLeadgenId, 'LEAD_DUP'));
    expect(rows).toHaveLength(1);
  });
});
