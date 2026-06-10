/**
 * Lead intake — pure-logic / DB tests (M5.T1).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY. The
 * dispatcher hits BullMQ, so a live Redis is required even though the tests
 * never run a worker (we only check the `agent_messages` row was written).
 *
 * Spin up the same containers the WAHA webhook tests use:
 *
 *   docker run -d --name f16-pg-m5t1 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker run -d --name f16-redis-m5t1 -p 6381:6379 redis:7-alpine --appendonly yes
 *   docker exec -i f16-pg-m5t1 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=... TEST_REDIS_URL=redis://127.0.0.1:6381 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, customers, leads } from '../../src/db/schema/index.js';
import { hashPII } from '../../src/db/crypto.js';
import { getCustomerById } from '../../src/db/repositories/customers.js';
import { ingestLead, normalizePhone } from '../../src/leads/intake.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const liveBoth = Boolean(pgUrl && redisUrl);
const d = describe.skipIf(!liveBoth);

let savedPiiKey: string | undefined;
let savedRedisUrl: string | undefined;
let savedPrefix: string | undefined;
let savedHubspotKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  savedRedisUrl = process.env.REDIS_URL;
  savedPrefix = process.env.BULLMQ_PREFIX;
  // Force HUBSPOT_API_KEY ON so ingestLead deterministically emits the
  // LEAD.SYNC_HUBSPOT fan-out row regardless of whether .env has the key.
  savedHubspotKey = process.env.HUBSPOT_API_KEY;
  process.env.HUBSPOT_API_KEY = 'pat-test';
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
  if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
  else process.env.BULLMQ_PREFIX = savedPrefix;
  if (savedHubspotKey === undefined) delete process.env.HUBSPOT_API_KEY;
  else process.env.HUBSPOT_API_KEY = savedHubspotKey;
});

// --- normalizePhone() is pure, no DB — runs even when the live gate skips
// the integration block below. Keeping it in this file (vs a `.unit.test.ts`)
// avoids a second file just for two assertions.
describe('normalizePhone()', () => {
  it('canonicalizes the common French input shapes to the same E.164 string', () => {
    expect(normalizePhone('0612345678')).toBe('+33612345678');
    expect(normalizePhone('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(normalizePhone('33612345678')).toBe('+33612345678');
    expect(normalizePhone('+33-6-12-34-56-78')).toBe('+33612345678');
    expect(normalizePhone('612345678')).toBe('+33612345678');
    // Same hash from each spelling proves dedup will match.
    const h = hashPII('+33612345678');
    expect(hashPII(normalizePhone('0612345678')!)).toBe(h);
    expect(hashPII(normalizePhone('+33 6 12 34 56 78')!)).toBe(h);
  });

  it('returns null on inputs we cannot confidently normalize', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    // Too short / too long for E.164 with explicit '+'.
    expect(normalizePhone('+1')).toBeNull();
    expect(normalizePhone('+1234567890123456')).toBeNull();
  });
});

d('ingestLead (live)', () => {
  let db: Database;
  let prefix: string;

  beforeEach(async () => {
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    // CASCADE through leads + conversation_turns + customer_facts.
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path: brand new customer, phone + email
  // -------------------------------------------------------------------------
  it('test 1 (happy path, new customer): writes customer + lead + LEAD.NEW', async () => {
    const result = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      fullName: 'Jean Dupont',
      email: 'jean@example.com',
      phone: '0612345678',
    });
    expect(result.dedup).toBe('new_customer');
    expect(result.leadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.customerId).toMatch(/^[0-9a-f-]{36}$/);

    // 1 customer row with phone_hash bound to the normalized E.164.
    const cs = await db.select().from(customers);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.phoneHash).toBe(hashPII('+33612345678'));
    // Email + phone are encrypted ciphertexts, not the plaintext.
    expect(cs[0]!.email).not.toBe('jean@example.com');
    expect(cs[0]!.phone).not.toBe('+33612345678');

    // 1 lead row, status=new, source=website.
    const ls = await db.select().from(leads);
    expect(ls).toHaveLength(1);
    expect(ls[0]!.status).toBe('new');
    expect(ls[0]!.source).toBe('website');
    expect(ls[0]!.productLine).toBe('scooter');
    expect(ls[0]!.customerId).toBe(result.customerId);

    // 2 agent_messages correlated to the leadId — the lead-scorer gets a
    // LEAD.NEW on the 'lead' queue; hubspot-sync gets a LEAD.SYNC_HUBSPOT on
    // its dedicated 'hubspot' queue (gated on HUBSPOT_API_KEY, forced on here).
    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, result.leadId));
    expect(msgs).toHaveLength(2);
    for (const m of msgs) {
      expect(m.fromRole).toBe('channel.intake');
    }
    const byRole = new Map(msgs.map((m) => [m.toRole, m]));
    expect([...byRole.keys()].sort()).toEqual(['hubspot-sync', 'lead-scorer']);
    expect(byRole.get('lead-scorer')!.intent).toBe('LEAD.NEW');
    expect(byRole.get('hubspot-sync')!.intent).toBe('LEAD.SYNC_HUBSPOT');
  });

  // -------------------------------------------------------------------------
  // 2. Dedup by phone: same phone twice -> same customer, two leads
  // -------------------------------------------------------------------------
  it('test 2 (dedup by phone): same phone twice -> 1 customer, 2 leads', async () => {
    const a = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      fullName: 'Jean Dupont',
      phone: '0612345678',
    });
    const b = await ingestLead(db, {
      source: 'meta',
      productLine: 'car',
      // Same number, different spelling — must still dedup.
      phone: '+33 6 12 34 56 78',
    });
    expect(b.customerId).toBe(a.customerId);
    expect(a.dedup).toBe('new_customer');
    expect(b.dedup).toBe('matched_existing');

    expect(await db.select().from(customers)).toHaveLength(1);
    const ls = await db.select().from(leads);
    expect(ls).toHaveLength(2);
    // Different lead ids, same customer.
    expect(ls[0]!.customerId).toBe(a.customerId);
    expect(ls[1]!.customerId).toBe(a.customerId);
    expect(ls[0]!.id).not.toBe(ls[1]!.id);
  });

  // -------------------------------------------------------------------------
  // 3. No phone, only email -> always new customer (no email dedup in V1)
  // -------------------------------------------------------------------------
  it('test 3 (no phone, only email): each submission creates a new customer (no email dedup in V1)', async () => {
    const a = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      fullName: 'Alice',
      email: 'alice@example.com',
    });
    const b = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      fullName: 'Alice',
      email: 'alice@example.com',
    });
    expect(a.dedup).toBe('new_customer');
    expect(b.dedup).toBe('new_customer');
    expect(b.customerId).not.toBe(a.customerId);
    expect(await db.select().from(customers)).toHaveLength(2);
    expect(await db.select().from(leads)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 4. Phone normalization — every spelling hashes the same
  // -------------------------------------------------------------------------
  it('test 4 (normalization): assorted spellings collapse to one phone_hash', async () => {
    const a = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      phone: '0612345678',
    });
    const b = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      phone: '+33 6 12 34 56 78',
    });
    const cust = await db.select().from(customers).where(eq(customers.id, a.customerId));
    expect(cust[0]!.phoneHash).toBe(hashPII('+33612345678'));
    expect(b.customerId).toBe(a.customerId);
  });

  // -------------------------------------------------------------------------
  // 5. Lead row has raw_payload + source_id
  // -------------------------------------------------------------------------
  it('test 5 (raw_payload + source_id): formAnswers + sourceId populate the lead row', async () => {
    const result = await ingestLead(db, {
      source: 'meta',
      sourceId: 'fb_lead_xyz',
      productLine: 'car',
      phone: '0612345679',
      formAnswers: { age: 30, postal_code: '75001' },
      raw: { ad_id: '987' },
    });
    const [row] = await db.select().from(leads).where(eq(leads.id, result.leadId));
    expect(row!.sourceId).toBe('fb_lead_xyz');
    const raw = row!.rawPayload as Record<string, unknown>;
    expect(raw['age']).toBe(30);
    expect(raw['postal_code']).toBe('75001');
    expect(raw['ad_id']).toBe('987');
  });

  // -------------------------------------------------------------------------
  // 6. LEAD.NEW priority is 4 (one above the default 5)
  // -------------------------------------------------------------------------
  it('test 6 (priority): LEAD.NEW is enqueued at priority 4', async () => {
    const result = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      phone: '0612345680',
    });
    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, result.leadId));
    expect(msgs).toHaveLength(2);
    for (const m of msgs) {
      expect(m.priority).toBe(4);
    }
  });

  // -------------------------------------------------------------------------
  // 7. Decryption roundtrip — fullName / email / phone come back plaintext
  // -------------------------------------------------------------------------
  it('test 7 (decrypt roundtrip): getCustomerById returns plaintext PII', async () => {
    const result = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      fullName: 'Marie Curie',
      email: 'marie@example.com',
      phone: '0612345681',
    });
    const fetched = await getCustomerById(db, result.customerId);
    expect(fetched).not.toBeNull();
    expect(fetched!.fullName).toBe('Marie Curie');
    expect(fetched!.email).toBe('marie@example.com');
    expect(fetched!.phone).toBe('+33612345681');
  });

  // -------------------------------------------------------------------------
  // 8. No PII at all -> lead still ingested, customer stub has placeholder name
  // -------------------------------------------------------------------------
  it('test 8 (minimal payload): missing PII still produces a lead + stub customer', async () => {
    const result = await ingestLead(db, {
      source: 'organic',
      productLine: 'scooter',
    });
    expect(result.dedup).toBe('new_customer');
    const fetched = await getCustomerById(db, result.customerId);
    // Placeholder name encodes the source so admin can disambiguate stubs.
    expect(fetched!.fullName).toBe('Lead organic');
    expect(fetched!.phone).toBeNull();
    expect(fetched!.email).toBeNull();
    expect(await db.select().from(leads)).toHaveLength(1);
  });
});
