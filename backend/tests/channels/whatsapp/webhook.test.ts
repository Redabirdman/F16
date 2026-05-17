/**
 * WAHA inbound webhook integration tests (M4.T3).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY — the
 * webhook persists customers (pg) and emits via the dispatcher which
 * enqueues a BullMQ job (redis). Skipped in hermetic CI.
 *
 * Spin up the same containers used by `tests/messaging/dispatcher.test.ts`:
 *
 *   docker run -d --name f16-pg-m4t3 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker run -d --name f16-redis-m4t3 -p 6381:6379 redis:7-alpine --appendonly yes
 *   docker exec -i f16-pg-m4t3 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=... TEST_REDIS_URL=redis://127.0.0.1:6381 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { agentMessages, customers, conversationTurns } from '../../../src/db/schema/index.js';
import { hashPII } from '../../../src/db/crypto.js';
import { buildWhatsAppWebhook } from '../../../src/channels/whatsapp/webhook.js';
import { __resetForTests, shutdownQueues } from '../../../src/queue/index.js';

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

/**
 * Build a raw WAHA `message` event body for a given phone. Defaults emulate
 * a plain text inbound from a stranger.
 */
function buildBody(opts: {
  phone?: string;
  body?: string;
  fromMe?: boolean;
  hasMedia?: boolean;
  mediaUrl?: string;
  event?: string;
  isGroup?: boolean;
  timestamp?: number;
  payload?: unknown; // override to test malformed payloads
}): string {
  if (opts.payload !== undefined) {
    return JSON.stringify({
      event: opts.event ?? 'message',
      session: 'default',
      payload: opts.payload,
    });
  }
  const phone = opts.phone ?? '33612345678';
  const chatId = opts.isGroup ? `${phone}-99887766@g.us` : `${phone}@c.us`;
  return JSON.stringify({
    event: opts.event ?? 'message',
    session: 'default',
    payload: {
      id: `false_${chatId}_3EB0ABCDEF`,
      timestamp: opts.timestamp ?? 1715865000,
      from: chatId,
      fromMe: opts.fromMe ?? false,
      body: opts.body ?? 'Bonjour, je voudrais une assurance',
      hasMedia: opts.hasMedia ?? false,
      ...(opts.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
      type: 'chat',
    },
  });
}

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

d('WAHA inbound webhook (live)', () => {
  let db: Database;
  let prefix: string;
  const SECRET = 'test-shared-secret';

  beforeEach(async () => {
    // Unique BullMQ prefix per test so parallel/CI runs can't see each
    // other's jobs (same idiom as the dispatcher test suite).
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    // CASCADE through customer_facts + conversation_turns + leads.
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  function buildApp(opts?: { hmacSecret?: string }) {
    return buildWhatsAppWebhook({
      db,
      ...(opts && 'hmacSecret' in opts && opts.hmacSecret !== undefined
        ? { hmacSecret: opts.hmacSecret }
        : {}),
    });
  }

  // -------------------------------------------------------------------------
  // 1. Happy path: unknown sender -> customer stub + intent emitted
  // -------------------------------------------------------------------------
  it('test 1 (happy path): valid signed message creates customer + emits intent', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildBody({ phone: '33611111001', body: 'salut' });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { accepted: boolean; customerId: string };
    expect(j.accepted).toBe(true);
    expect(j.customerId).toMatch(/^[0-9a-f-]{36}$/);

    // customer row exists with phone_hash set to HMAC(+33611111001)
    const [c] = await db.select().from(customers).where(eq(customers.id, j.customerId));
    expect(c).toBeDefined();
    expect(c!.phoneHash).toBe(hashPII('+33611111001'));

    // agent_message row exists with the expected payload
    const [msg] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, j.customerId));
    expect(msg).toBeDefined();
    expect(msg!.intent).toBe('CUSTOMER.MESSAGE_RECEIVED');
    expect(msg!.toRole).toBe('sales-agent');
    expect(msg!.toInstance).toBe(`customer-${j.customerId}`);
    const payload = msg!.payload as Record<string, unknown>;
    expect(payload['customerId']).toBe(j.customerId);
    expect(payload['channel']).toBe('whatsapp');
    expect(payload['content']).toBe('salut');
    expect(payload['attachments']).toEqual([]);
    expect(typeof payload['occurredAt']).toBe('string');

    // M4.T7: inbound message persisted to conversation_turns as the
    // companion to the outbound `sendViaChannel` wrapper. agentRole is
    // null because inbound messages have no agent attribution.
    const turns = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, j.customerId));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.direction).toBe('inbound');
    expect(turns[0]!.channel).toBe('whatsapp');
    expect(turns[0]!.content).toBe('salut');
    expect(turns[0]!.attachments).toBeNull();
    expect(turns[0]!.agentRole).toBeNull();
    expect(turns[0]!.agentInstance).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Same sender twice -> dedup
  // -------------------------------------------------------------------------
  it('test 2 (dedup): two webhooks from the same phone resolve to the same customer', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const b1 = buildBody({ phone: '33611111002', body: 'first' });
    const b2 = buildBody({ phone: '33611111002', body: 'second' });

    const r1 = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(b1, SECRET) },
      body: b1,
    });
    const j1 = (await r1.json()) as { customerId: string };

    const r2 = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(b2, SECRET) },
      body: b2,
    });
    const j2 = (await r2.json()) as { customerId: string };

    expect(j2.customerId).toBe(j1.customerId);
    // Only ONE customer row (phone_hash UNIQUE worked + the find branch ran).
    const all = await db.select().from(customers);
    expect(all).toHaveLength(1);
    // Two agent_messages emitted, both correlated to that customer.
    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, j1.customerId));
    expect(msgs).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 3. fromMe -> ignored, no writes
  // -------------------------------------------------------------------------
  it('test 3 (fromMe): outbound echo is ignored with no DB writes', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildBody({ phone: '33611111003', fromMe: true });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ignored: string };
    expect(j.ignored).toBe('fromMe');
    expect(await db.select().from(customers)).toHaveLength(0);
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Group chat -> ignored
  // -------------------------------------------------------------------------
  it('test 4 (group chat): @g.us senders are ignored with no DB writes', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildBody({ phone: '33611111004', isGroup: true });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ignored: string };
    expect(j.ignored).toBe('non-personal-chat');
    expect(await db.select().from(customers)).toHaveLength(0);
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Non-message events -> ignored
  // -------------------------------------------------------------------------
  it('test 5 (non-message event): session.status etc. ignored with no DB writes', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = JSON.stringify({
      event: 'session.status',
      session: 'default',
      payload: { status: 'WORKING' },
    });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ignored: string };
    expect(j.ignored).toBe('session.status');
    expect(await db.select().from(customers)).toHaveLength(0);
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. Invalid HMAC -> 401, no writes
  // -------------------------------------------------------------------------
  it('test 6 (bad signature): invalid HMAC -> 401, no DB writes', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildBody({ phone: '33611111006' });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Wrong secret -> wrong signature.
        'x-webhook-hmac': sign(body, 'wrong-secret'),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(await db.select().from(customers)).toHaveLength(0);
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. Missing HMAC header when secret configured -> 401
  // -------------------------------------------------------------------------
  it('test 7 (missing signature): no HMAC header when secret required -> 401', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildBody({ phone: '33611111007' });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    expect(await db.select().from(customers)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. No HMAC secret configured -> skip signature check (legacy mode)
  // -------------------------------------------------------------------------
  it('test 8 (no secret configured): signature check skipped, message processed', async () => {
    const app = buildApp();
    const body = buildBody({ phone: '33611111008', body: 'hi' });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { accepted: boolean; customerId: string };
    expect(j.accepted).toBe(true);
    expect(await db.select().from(customers)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 9. Invalid envelope JSON -> 400
  // -------------------------------------------------------------------------
  it('test 9 (bad envelope): malformed JSON -> 400, no DB writes', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = '{"event": "message", "payload":'; // truncated
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(customers)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 10. Invalid message payload (missing `from`) -> 400
  // -------------------------------------------------------------------------
  it('test 10 (bad payload): missing `from` -> 400, no DB writes', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    // Valid envelope, invalid payload shape.
    const body = buildBody({
      payload: { id: 'x', timestamp: 1, fromMe: false /* no `from` */ },
    });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(customers)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 11. Media message -> attachments[0].url propagates into the intent
  // -------------------------------------------------------------------------
  it('test 11 (media): media message attaches mediaUrl into the emitted intent', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = buildBody({
      phone: '33611111011',
      body: 'photo',
      hasMedia: true,
      mediaUrl: 'https://files.waha.example.com/abc.jpg',
    });
    const res = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-hmac': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { customerId: string };
    const [msg] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, j.customerId));
    const payload = msg!.payload as { attachments: { url: string }[] };
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]!.url).toBe('https://files.waha.example.com/abc.jpg');

    // M4.T7: the inbound conversation_turns row also carries the mediaUrl
    // so the admin timeline can render the attachment alongside the body.
    const turns = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, j.customerId));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.direction).toBe('inbound');
    expect(turns[0]!.content).toBe('photo');
    expect(turns[0]!.attachments).toHaveLength(1);
    expect(turns[0]!.attachments![0]!.url).toBe('https://files.waha.example.com/abc.jpg');
  });
});
