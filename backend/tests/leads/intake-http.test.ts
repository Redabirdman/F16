/**
 * Lead intake HTTP transport tests (M5.T1).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY (same as
 * the pure-logic intake suite — ingestLead writes to pg and enqueues into
 * BullMQ). The rate-limit + HMAC-rejection paths don't hit the DB at all,
 * but we keep them in the gated block so a single docker spin covers the
 * full M5.T1 surface.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, customers, leads } from '../../src/db/schema/index.js';
import { buildLeadIntakeRouter } from '../../src/leads/intake-http.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const liveBoth = Boolean(pgUrl && redisUrl);
const d = describe.skipIf(!liveBoth);

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

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function buildPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: 'website',
    productLine: 'scooter',
    fullName: 'Jean Dupont',
    email: 'jean@example.com',
    phone: '0612345678',
    ...overrides,
  });
}

d('lead intake HTTP (live)', () => {
  let db: Database;
  let prefix: string;
  const SECRET = 'test-lead-intake-secret';

  beforeEach(async () => {
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
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

  function buildApp(opts?: { hmacSecret?: string; maxPerMin?: number }) {
    return buildLeadIntakeRouter({
      db,
      ...(opts?.hmacSecret !== undefined ? { hmacSecret: opts.hmacSecret } : {}),
      ...(opts?.maxPerMin !== undefined
        ? { rateLimit: { maxPerMinutePerIp: opts.maxPerMin } }
        : {}),
    });
  }

  // -------------------------------------------------------------------------
  // 1. Happy POST with valid HMAC -> 200 + leadId + customerId + dedup
  // -------------------------------------------------------------------------
  it('test 1 (happy POST): valid signed payload returns 200 with ids', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildPayload({ phone: '0611111001' });
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      accepted: boolean;
      leadId: string;
      customerId: string;
      dedup: string;
    };
    expect(j.accepted).toBe(true);
    expect(j.dedup).toBe('new_customer');
    expect(j.leadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(j.customerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.select().from(leads)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 2. Same phone twice -> 2nd response has dedup:'matched_existing'
  // -------------------------------------------------------------------------
  it('test 2 (dedup over HTTP): same phone twice -> same customer, matched flag', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const b1 = buildPayload({ phone: '0611111002' });
    const r1 = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(b1, SECRET) },
      body: b1,
    });
    const j1 = (await r1.json()) as { customerId: string; dedup: string };

    const b2 = buildPayload({ phone: '+33 6 11 11 10 02' });
    const r2 = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(b2, SECRET) },
      body: b2,
    });
    const j2 = (await r2.json()) as { customerId: string; dedup: string };
    expect(j2.customerId).toBe(j1.customerId);
    expect(j2.dedup).toBe('matched_existing');
    expect(await db.select().from(customers)).toHaveLength(1);
    expect(await db.select().from(leads)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 3. Missing HMAC header (when secret configured) -> 401, no DB write
  // -------------------------------------------------------------------------
  it('test 3 (missing signature): no header when secret required -> 401', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildPayload({ phone: '0611111003' });
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    expect(await db.select().from(leads)).toHaveLength(0);
    expect(await db.select().from(customers)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Invalid HMAC -> 401, no DB write
  // -------------------------------------------------------------------------
  it('test 4 (bad signature): wrong-secret HMAC -> 401', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildPayload({ phone: '0611111004' });
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-f16-signature': sign(body, 'wrong-secret'),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(await db.select().from(leads)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. HMAC disabled (no secret) -> 200 without a signature header
  // -------------------------------------------------------------------------
  it('test 5 (no secret configured): signature check skipped (dev mode)', async () => {
    const app = buildApp();
    const body = buildPayload({ phone: '0611111005' });
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(leads)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6. Invalid JSON body -> 400
  // -------------------------------------------------------------------------
  it('test 6 (bad JSON): malformed body -> 400', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = '{"source": "website", "productLine"'; // truncated
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(leads)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. Missing productLine -> zod 400
  // -------------------------------------------------------------------------
  it('test 7 (bad zod): missing productLine -> 400', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = JSON.stringify({ source: 'website', phone: '0611111007' });
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(leads)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. Rate limit — 31st request from the same IP within <1 min -> 429
  // -------------------------------------------------------------------------
  it('test 8 (rate limit): 31st request from one IP -> 429', async () => {
    const app = buildApp({ maxPerMin: 30 }); // no secret -> simpler bodies
    const body = JSON.stringify({ source: 'website', productLine: 'scooter' });
    const ip = '203.0.113.7';
    for (let i = 0; i < 30; i++) {
      const r = await app.request('/v1/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body,
      });
      expect(r.status).toBe(200);
    }
    const blocked = await app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body,
    });
    expect(blocked.status).toBe(429);
    const j = (await blocked.json()) as { error: string };
    expect(j.error).toBe('rate_limited');
  });

  // -------------------------------------------------------------------------
  // 9. Different IPs are independent — 30+30 both succeed
  // -------------------------------------------------------------------------
  it('test 9 (rate limit per-IP): 30 from A + 30 from B both succeed', async () => {
    const app = buildApp({ maxPerMin: 30 });
    const body = JSON.stringify({ source: 'website', productLine: 'scooter' });
    for (let i = 0; i < 30; i++) {
      const ra = await app.request('/v1/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
        body,
      });
      expect(ra.status).toBe(200);
      const rb = await app.request('/v1/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.11' },
        body,
      });
      expect(rb.status).toBe(200);
    }
  });

  // -------------------------------------------------------------------------
  // 10. PII not leaked on errors — phone in body must NOT appear in response
  // -------------------------------------------------------------------------
  it('test 10 (PII discipline): ingest failure does not echo phone in response', async () => {
    // Force ingestLead to throw by sabotaging the leads table — drop it
    // temporarily. We restore it via afterEach's TRUNCATE flow (next test
    // beforeEach will re-target the live schema; the dropped table only
    // affects this single case).
    //
    // Test isolation note: this test runs *last* in the file by name order,
    // but vitest doesn't guarantee order — we re-create the table at the
    // end so a later test in the same file (none today) wouldn't break.
    await db.execute(sql`ALTER TABLE leads RENAME TO leads_tmp_break`);
    try {
      const app = buildApp({ hmacSecret: SECRET });
      const phone = '1112223333';
      const body = buildPayload({ phone });
      const res = await app.request('/v1/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
        body,
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(phone);
      expect(text).not.toContain('jean@example.com');
      expect(text).not.toContain('Jean Dupont');
      expect(JSON.parse(text)).toEqual({ error: 'ingest_failed' });
    } finally {
      // Restore so the rest of the suite is unaffected. afterEach's
      // TRUNCATE re-runs against the recreated table.
      await db.execute(sql`ALTER TABLE leads_tmp_break RENAME TO leads`);
    }
    // Sanity — no stray rows survived the failed insert.
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });
});
