/**
 * Website lead intake HTTP tests (2026-07-15).
 *
 * Non-gated block: honeypot + validation + CORS never touch the DB, so they
 * run everywhere with a stub. Gated block (TEST_DATABASE_URL + TEST_REDIS_URL
 * + PII key, same as intake-http.test.ts): full ingest, productLine mapping,
 * formAnswers passthrough, WA group notification.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { customers, leads } from '../../src/db/schema/index.js';
import { buildWebsiteLeadIntakeRouter } from '../../src/leads/website-intake-http.js';
import type { WahaClient } from '../../src/channels/whatsapp/waha-client.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const liveBoth = Boolean(pgUrl && redisUrl);
const d = describe.skipIf(!liveBoth);

const ORIGIN = 'https://www.assuryalconseil.fr';

function buildBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'Jean Testeur',
    phone: '0612345678',
    email: 'jean@example.com',
    canal: 'whatsapp',
    insurance_type: 'moto',
    source_page: '/assurance-moto',
    rgpd: true,
    ...overrides,
  });
}

function makeFakeWaha(): { client: WahaClient; sent: { chatId: string; text: string }[] } {
  const sent: { chatId: string; text: string }[] = [];
  const client = {
    sendText: async (input: { chatId: string; text: string }) => {
      sent.push(input);
      return { id: 'fake' };
    },
  } as unknown as WahaClient;
  return { client, sent };
}

describe('website lead intake (no DB needed)', () => {
  const stubDb = {} as Database;

  it('honeypot filled -> fake 200, ingest not attempted', async () => {
    // Stub DB would throw if ingestLead ran — a 200 proves the early return.
    const app = buildWebsiteLeadIntakeRouter({ db: stubDb });
    const res = await app.request('/v1/website-leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: buildBody({ website: 'http://spam.example' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
  });

  it('invalid payload -> 400', async () => {
    const app = buildWebsiteLeadIntakeRouter({ db: stubDb });
    const res = await app.request('/v1/website-leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ name: 'X' }), // too short + missing fields
    });
    expect(res.status).toBe(400);
  });

  it('rate limit -> 429 after budget exhausted', async () => {
    const app = buildWebsiteLeadIntakeRouter({ db: stubDb, rateLimit: { maxPerMinutePerIp: 2 } });
    const hit = () =>
      app.request('/v1/website-leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
        body: buildBody({ website: 'bot' }), // honeypot -> no DB touch
      });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });

  it('CORS preflight from the site origin is allowed', async () => {
    const app = buildWebsiteLeadIntakeRouter({ db: stubDb });
    const res = await app.request('/v1/website-leads', {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('CORS preflight from a foreign origin gets no allow-origin', async () => {
    const app = buildWebsiteLeadIntakeRouter({ db: stubDb });
    const res = await app.request('/v1/website-leads', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

let savedPiiKey: string | undefined;
let savedRedisUrl: string | undefined;
let savedPrefix: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
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

d('website lead intake (live)', () => {
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

  it('happy POST: ingests, maps productLine, keeps true product in formAnswers, notifies WA group', async () => {
    const { client, sent } = makeFakeWaha();
    const app = buildWebsiteLeadIntakeRouter({ db, waha: client, groupChatId: 'g@g.us' });
    const res = await app.request('/v1/website-leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: buildBody({ insurance_type: 'sante', utm_source: 'google' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);

    const rows = await db.select().from(leads);
    expect(rows).toHaveLength(1);
    const lead = rows[0]!;
    expect(lead.source).toBe('website');
    expect(lead.productLine).toBe('car'); // sante maps to the closest binary value
    // formAnswers + raw merge into the raw_payload jsonb column.
    const rawPayload = lead.rawPayload as Record<string, unknown>;
    expect(rawPayload.insurance_type).toBe('sante');
    expect(rawPayload.utm_source).toBe('google');

    // WA notification fired to the group with the TRUE product label.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe('g@g.us');
    expect(sent[0]!.text).toContain('Jean Testeur');
    expect(sent[0]!.text).toContain('Santé');
  });

  it('moto maps to scooter productLine', async () => {
    const app = buildWebsiteLeadIntakeRouter({ db });
    const res = await app.request('/v1/website-leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: buildBody({ insurance_type: 'moto', phone: '0612345679' }),
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(leads);
    expect(rows[0]!.productLine).toBe('scooter');
  });

  it('WA failure does not fail the ingest', async () => {
    const failing = {
      sendText: async () => {
        throw new Error('waha down');
      },
    } as unknown as WahaClient;
    const app = buildWebsiteLeadIntakeRouter({ db, waha: failing, groupChatId: 'g@g.us' });
    const res = await app.request('/v1/website-leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: buildBody({ phone: '0612345680' }),
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(leads)).toHaveLength(1);
  });

  it('dedup: existing phone matches existing customer', async () => {
    const app = buildWebsiteLeadIntakeRouter({ db });
    const first = await app.request('/v1/website-leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: buildBody({ phone: '0612345681' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/v1/website-leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: buildBody({ phone: '+33 6 12 34 56 81' }),
    });
    expect(second.status).toBe(200);
    expect(await db.select().from(customers)).toHaveLength(1);
    expect(await db.select().from(leads)).toHaveLength(2);
    const withEmail = await db.select().from(leads).where(eq(leads.source, 'website'));
    expect(withEmail).toHaveLength(2);
  });
});
