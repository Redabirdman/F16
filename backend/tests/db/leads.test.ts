/**
 * Live-DB integration tests for `leads`. Gated on TEST_DATABASE_URL.
 *
 * Covers the basics the lead-intake flow (M5) will rely on:
 *   - default status / nullable score on insert
 *   - state transitions through the lifecycle enum
 *   - common query shapes (by status, by customer, by created_at range)
 *
 * The `setLeadStatus (live)` block below additionally needs TEST_REDIS_URL:
 * the repository helper emits a LEAD.SYNC_HUBSPOT via the dispatcher, which
 * enqueues a BullMQ job alongside the agent_messages row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, and, eq, gte, lte, desc } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, leads } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { setLeadStatus } from '../../src/db/repositories/leads.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const liveUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
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

d('leads (live)', () => {
  const db = createDb(liveUrl!);

  beforeEach(async () => {
    // Wipe both tables — leads.customer_id is set-null on customer delete,
    // so we can't rely on cascade here.
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
  });

  it('inserts with default status="new" and null score', async () => {
    const [row] = await db
      .insert(leads)
      .values({
        source: 'website',
        productLine: 'scooter',
        rawPayload: { utm_source: 'google' },
      })
      .returning();
    expect(row!.status).toBe('new');
    expect(row!.score).toBeNull();
    expect(row!.customerId).toBeNull();
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it('moves through the status state machine', async () => {
    const [row] = await db.insert(leads).values({ source: 'meta', productLine: 'car' }).returning();
    const id = row!.id;

    const steps: Array<'scored' | 'qualifying' | 'quoting' | 'closed_won'> = [
      'scored',
      'qualifying',
      'quoting',
      'closed_won',
    ];
    for (const status of steps) {
      const [updated] = await db
        .update(leads)
        .set({ status, updatedAt: new Date() })
        .where(eq(leads.id, id))
        .returning();
      expect(updated!.status).toBe(status);
    }
  });

  it('queries by status, by customer_id, and by created_at range', async () => {
    const c = await insertCustomer(db, { fullName: 'LeadOwner' });

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await db.insert(leads).values([
      {
        source: 'website',
        productLine: 'scooter',
        customerId: c.id,
        status: 'new',
        createdAt: now,
        updatedAt: now,
      },
      {
        source: 'meta',
        productLine: 'car',
        customerId: c.id,
        status: 'closed_won',
        score: 92,
        createdAt: yesterday,
        updatedAt: yesterday,
      },
      {
        source: 'organic',
        productLine: 'car',
        status: 'new',
      },
    ]);

    const newLeads = await db.select().from(leads).where(eq(leads.status, 'new'));
    expect(newLeads).toHaveLength(2);

    const byCustomer = await db
      .select()
      .from(leads)
      .where(eq(leads.customerId, c.id))
      .orderBy(desc(leads.createdAt));
    expect(byCustomer).toHaveLength(2);
    expect(byCustomer[0]!.status).toBe('new');

    // Range query — only the "yesterday" row.
    const range = await db
      .select()
      .from(leads)
      .where(
        and(
          gte(leads.createdAt, new Date(yesterday.getTime() - 1000)),
          lte(leads.createdAt, new Date(yesterday.getTime() + 1000)),
        ),
      );
    expect(range).toHaveLength(1);
    expect(range[0]!.score).toBe(92);
  });
});

// ---------------------------------------------------------------------------
// setLeadStatus / emitHubSpotSync — the single chokepoint for lead status
// writes (HubSpot rich mirror, Phase 2). Needs Redis too: the dispatcher
// enqueues a BullMQ job for every agent_messages row.
// ---------------------------------------------------------------------------
const dd = describe.skipIf(!liveUrl || !redisUrl);

dd('setLeadStatus (live)', () => {
  let db: Database;
  let savedRedisUrl: string | undefined;
  let savedPrefix: string | undefined;
  let savedHubspotKey: string | undefined;

  beforeAll(() => {
    savedRedisUrl = process.env.REDIS_URL;
    savedPrefix = process.env.BULLMQ_PREFIX;
    // Force HUBSPOT_API_KEY ON so setLeadStatus deterministically emits the
    // LEAD.SYNC_HUBSPOT row regardless of whether .env has the key.
    savedHubspotKey = process.env.HUBSPOT_API_KEY;
    process.env.HUBSPOT_API_KEY = 'pat-test';
  });

  afterAll(() => {
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
    if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
    else process.env.BULLMQ_PREFIX = savedPrefix;
    if (savedHubspotKey === undefined) delete process.env.HUBSPOT_API_KEY;
    else process.env.HUBSPOT_API_KEY = savedHubspotKey;
  });

  beforeEach(async () => {
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = `f16-test-leadsrepo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    __resetForTests();

    db = createDb(liveUrl!);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  it('updates status and enqueues a hubspot sync', async () => {
    const [row] = await db
      .insert(leads)
      .values({ source: 'website', productLine: 'scooter' })
      .returning();
    const leadId = row!.id;
    expect(row!.status).toBe('new');

    const updated = await setLeadStatus(db, leadId, 'qualifying');
    expect(updated.status).toBe('qualifying');

    // The DB row really changed (not just the returned object).
    const [fresh] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(fresh!.status).toBe('qualifying');
    expect(fresh!.updatedAt.getTime()).toBeGreaterThanOrEqual(row!.updatedAt.getTime());

    // Exactly one LEAD.SYNC_HUBSPOT for hubspot-sync, correlated to the lead.
    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.intent).toBe('LEAD.SYNC_HUBSPOT');
    expect(msgs[0]!.toRole).toBe('hubspot-sync');
    expect((msgs[0]!.payload as Record<string, unknown>)['leadId']).toBe(leadId);
  });

  it('still updates status (and emits nothing) when HUBSPOT_API_KEY is unset', async () => {
    delete process.env.HUBSPOT_API_KEY;
    try {
      const [row] = await db
        .insert(leads)
        .values({ source: 'meta', productLine: 'car' })
        .returning();
      const leadId = row!.id;

      const updated = await setLeadStatus(db, leadId, 'scored');
      expect(updated.status).toBe('scored');

      const msgs = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      expect(msgs).toHaveLength(0);
    } finally {
      process.env.HUBSPOT_API_KEY = 'pat-test';
    }
  });

  it('throws on an unknown lead id', async () => {
    await expect(setLeadStatus(db, randomUUID(), 'quoting')).rejects.toThrow(/no lead/);
  });
});
