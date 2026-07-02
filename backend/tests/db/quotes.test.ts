/**
 * Live-DB integration tests for `quotes` + `maxance_actions`. Gated on
 * TEST_DATABASE_URL — skipped otherwise so `pnpm test` stays hermetic in CI
 * environments without docker.
 *
 * Covers M2.T4 invariants the Maxance Operator (M8) will rely on:
 *   - default `status = 'requested'` + `requested_at = now()` on insert
 *   - markQuoteReady transition
 *   - step_index monotonicity + UNIQUE (quote_id, step_index)
 *   - getQuoteWithActions ordering ASC
 *   - cascade delete from quotes → maxance_actions
 *   - two distinct quotes per customer coexist
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { quotes, maxanceActions, leads, agentMessages } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import {
  insertQuote,
  markQuoteReady,
  markQuotePreview,
  appendMaxanceAction,
  getQuoteWithActions,
} from '../../src/db/repositories/quotes.js';
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

d('quotes + maxance_actions (live)', () => {
  const db = createDb(liveUrl!);

  beforeEach(async () => {
    // quotes cascade to maxance_actions; customers cascade to quotes. Wiping
    // customers + leads is enough but we name them all for clarity.
    await db.execute(sql`TRUNCATE TABLE maxance_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE quotes RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
  });

  async function seedCustomerAndLead(): Promise<{ customerId: string; leadId: string }> {
    const c = await insertCustomer(db, { fullName: 'Quote Owner' });
    const [l] = await db
      .insert(leads)
      .values({ source: 'website', productLine: 'scooter', customerId: c.id })
      .returning();
    return { customerId: c.id, leadId: l!.id };
  }

  it('inserts a quote with minimal fields and default status="requested"', async () => {
    const { customerId, leadId } = await seedCustomerAndLead();
    const sessionId = randomUUID();

    const inserted = await insertQuote(db, {
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId,
      rawFormData: { vehicleType: 'Trottinette électrique' },
    });

    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.status).toBe('requested');
    expect(inserted.requestedAt).toBeInstanceOf(Date);
    expect(inserted.readyAt).toBeNull();
    expect(inserted.monthlyPremium).toBeNull();
    expect(inserted.sessionId).toBe(sessionId);

    const [row] = await db.select().from(quotes).where(eq(quotes.id, inserted.id));
    expect(row!.rawFormData).toEqual({ vehicleType: 'Trottinette électrique' });
  });

  it('insertQuote honors an explicit caller-supplied id (QUOTE.REQUESTED correlation)', async () => {
    // Regression (2026-07-02): quote.request generates payload.quoteId and must
    // insert the row under that exact id, or every markQuote*(payload.quoteId)
    // downstream misses the row ("no quote with id=…").
    const { customerId, leadId } = await seedCustomerAndLead();
    const explicitId = randomUUID();

    const inserted = await insertQuote(db, {
      id: explicitId,
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'trottinette',
      sessionId: randomUUID(),
    });

    expect(inserted.id).toBe(explicitId);
    const [row] = await db.select().from(quotes).where(eq(quotes.id, explicitId));
    expect(row).toBeDefined();
    expect(row!.status).toBe('requested');
  });

  it('markQuoteReady flips status + sets ready_at and pricing fields', async () => {
    const { customerId, leadId } = await seedCustomerAndLead();
    const q = await insertQuote(db, {
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId: randomUUID(),
    });

    const ready = await markQuoteReady(db, q.id, {
      monthlyPremium: '12.34',
      comptantDue: '49.00',
      devisNumber: 'DR0000971882',
      pdfUrl: 'https://maxance.example/q/DR0000971882.pdf',
      rawResponse: { ok: true, totals: { ttc: '12.34' } },
    });

    expect(ready.status).toBe('ready');
    expect(ready.readyAt).toBeInstanceOf(Date);
    // numeric(10,2) round-trips as a string in postgres-js — that's expected.
    expect(ready.monthlyPremium).toBe('12.34');
    expect(ready.comptantDue).toBe('49.00');
    expect(ready.maxanceDevisNumber).toBe('DR0000971882');
    expect(ready.pdfUrl).toBe('https://maxance.example/q/DR0000971882.pdf');
    expect(ready.rawResponse).toEqual({ ok: true, totals: { ttc: '12.34' } });
  });

  it('appendMaxanceAction assigns sequential step_index starting at 0', async () => {
    const { customerId, leadId } = await seedCustomerAndLead();
    const sessionId = randomUUID();
    const q = await insertQuote(db, {
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId,
    });

    const labels = [
      'vehicle.set_type',
      'vehicle.set_brand',
      'driver.set_license',
      'pricing.submit',
      'pricing.confirm',
    ];
    const inserted: number[] = [];
    for (const stepName of labels) {
      const a = await appendMaxanceAction(db, q.id, sessionId, {
        actionText: `do ${stepName}`,
        stepName,
        durationMs: 100,
      });
      inserted.push(a.stepIndex);
    }

    expect(inserted).toEqual([0, 1, 2, 3, 4]);
  });

  it('getQuoteWithActions returns the quote and actions sorted by step_index ASC', async () => {
    const { customerId, leadId } = await seedCustomerAndLead();
    const sessionId = randomUUID();
    const q = await insertQuote(db, {
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId,
    });

    await appendMaxanceAction(db, q.id, sessionId, { actionText: 'step 0', stepName: 's0' });
    await appendMaxanceAction(db, q.id, sessionId, { actionText: 'step 1', stepName: 's1' });
    await appendMaxanceAction(db, q.id, sessionId, { actionText: 'step 2', stepName: 's2' });

    const result = await getQuoteWithActions(db, q.id);
    expect(result).not.toBeNull();
    expect(result!.quote.id).toBe(q.id);
    expect(result!.actions).toHaveLength(3);
    expect(result!.actions.map((a) => a.stepIndex)).toEqual([0, 1, 2]);
    expect(result!.actions.map((a) => a.stepName)).toEqual(['s0', 's1', 's2']);
  });

  it('cascades quote delete to its maxance_actions', async () => {
    const { customerId, leadId } = await seedCustomerAndLead();
    const sessionId = randomUUID();
    const q = await insertQuote(db, {
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId,
    });
    await appendMaxanceAction(db, q.id, sessionId, { actionText: 'a' });
    await appendMaxanceAction(db, q.id, sessionId, { actionText: 'b' });

    const before = await db.select().from(maxanceActions).where(eq(maxanceActions.quoteId, q.id));
    expect(before).toHaveLength(2);

    await db.delete(quotes).where(eq(quotes.id, q.id));

    const after = await db.select().from(maxanceActions).where(eq(maxanceActions.quoteId, q.id));
    expect(after).toHaveLength(0);
  });

  it('enforces UNIQUE (quote_id, step_index)', async () => {
    const { customerId, leadId } = await seedCustomerAndLead();
    const sessionId = randomUUID();
    const q = await insertQuote(db, {
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId,
    });

    // Insert one via repo (step_index = 0) and then a hand-crafted duplicate.
    await appendMaxanceAction(db, q.id, sessionId, { actionText: 'step 0' });
    await expect(
      db.insert(maxanceActions).values({
        quoteId: q.id,
        sessionId,
        actionText: 'duplicate step 0',
        stepIndex: 0,
      }),
    ).rejects.toThrow();
  });

  it('allows two quotes for the same customer (scooter + car)', async () => {
    const { customerId, leadId } = await seedCustomerAndLead();

    const scooter = await insertQuote(db, {
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId: randomUUID(),
    });
    const car = await insertQuote(db, {
      customerId,
      // car attempt happens later, no lead reattached.
      product: 'car',
      productVariant: 'bonus',
      sessionId: randomUUID(),
    });

    expect(scooter.id).not.toBe(car.id);
    expect(scooter.product).toBe('scooter');
    expect(car.product).toBe('car');

    const all = await db.select().from(quotes).where(eq(quotes.customerId, customerId));
    expect(all).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// markQuotePreview — persists the Maxance dry-run price onto the quote row so
// the HubSpot mirror can fill the deal amount/comptant before the devis is
// confirmed. Needs Redis too: emitHubSpotSync goes through the dispatcher,
// which enqueues a BullMQ job alongside the agent_messages row.
// ---------------------------------------------------------------------------
const pp = describe.skipIf(!liveUrl || !redisUrl);

pp('markQuotePreview (live)', () => {
  let db: Database;
  let savedRedisUrl: string | undefined;
  let savedPrefix: string | undefined;
  let savedHubspotKey: string | undefined;

  beforeAll(() => {
    savedRedisUrl = process.env.REDIS_URL;
    savedPrefix = process.env.BULLMQ_PREFIX;
    // Force HUBSPOT_API_KEY ON so the helper deterministically emits the
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
    process.env.BULLMQ_PREFIX = `f16-test-quotespreview-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    __resetForTests();

    db = createDb(liveUrl!);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE maxance_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE quotes RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  async function seedQuote(): Promise<{ quoteId: string; leadId: string }> {
    const c = await insertCustomer(db, { fullName: 'Preview Owner' });
    const [l] = await db
      .insert(leads)
      .values({ source: 'website', productLine: 'scooter', customerId: c.id })
      .returning();
    const q = await insertQuote(db, {
      customerId: c.id,
      leadId: l!.id,
      product: 'scooter',
      productVariant: 'malus',
      sessionId: randomUUID(),
    });
    return { quoteId: q.id, leadId: l!.id };
  }

  it('persists both prices as decimal strings, leaves status unchanged, emits one sync', async () => {
    const { quoteId, leadId } = await seedQuote();

    // M8 preview { monthly: 78.85, annual: 90.85 } → P1 fixture strings.
    const updated = await markQuotePreview(db, quoteId, {
      monthlyPremium: 78.85,
      comptantDue: 90.85,
    });

    // numeric(10,2) round-trips as a string in postgres-js — that's expected.
    expect(updated.monthlyPremium).toBe('78.85');
    expect(updated.comptantDue).toBe('90.85');
    // A preview is NOT 'ready' — status must stay as inserted.
    expect(updated.status).toBe('requested');
    expect(updated.readyAt).toBeNull();

    // The DB row really changed (not just the returned object).
    const [fresh] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(fresh!.monthlyPremium).toBe('78.85');
    expect(fresh!.comptantDue).toBe('90.85');
    expect(fresh!.status).toBe('requested');

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

  it('does nothing (no update, no emit, no throw) when both prices are undefined', async () => {
    const { quoteId, leadId } = await seedQuote();

    const updated = await markQuotePreview(db, quoteId, {
      monthlyPremium: undefined,
      comptantDue: undefined,
    });

    // Returned the current (untouched) row.
    expect(updated.id).toBe(quoteId);
    expect(updated.monthlyPremium).toBeNull();
    expect(updated.comptantDue).toBeNull();
    expect(updated.status).toBe('requested');

    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect(msgs).toHaveLength(0);
  });

  it('persists only the defined price, leaving the other column untouched', async () => {
    const { quoteId } = await seedQuote();

    const updated = await markQuotePreview(db, quoteId, {
      monthlyPremium: 78.85,
      comptantDue: undefined,
    });

    expect(updated.monthlyPremium).toBe('78.85');
    expect(updated.comptantDue).toBeNull();
    expect(updated.status).toBe('requested');
  });
});
