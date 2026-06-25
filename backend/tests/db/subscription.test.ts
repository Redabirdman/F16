/**
 * Live-DB integration tests for the M8.T7 subscription lifecycle:
 *   - quotes.subscription_* columns (migration 0010) + repo transitions
 *   - customers encrypted bank columns + saveCustomerBankDetails round-trip
 *
 * Gated on TEST_DATABASE_URL (+ TEST_REDIS_URL for the transition tests —
 * every mark* helper mirrors to HubSpot through the dispatcher, which
 * enqueues a BullMQ job alongside the agent_messages row). Run ONLY against
 * f16_test (5435), never the prod f16 db.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { quotes, customers, leads, agentMessages } from '../../src/db/schema/index.js';
import {
  insertCustomer,
  saveCustomerBankDetails,
  getCustomerBankDetails,
} from '../../src/db/repositories/customers.js';
import {
  insertQuote,
  markSubscriptionRequested,
  markSubscriptionInProgress,
  markSubscriptionPendingInspector,
  markSubscriptionContractIssued,
  markSubscriptionFailed,
} from '../../src/db/repositories/quotes.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const liveUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

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

// ---------------------------------------------------------------------------
// Customer bank details — DB only, no Redis needed.
// ---------------------------------------------------------------------------
const d = describe.skipIf(!liveUrl);

d('customers bank details (live)', () => {
  const db = createDb(liveUrl!);
  // Published ECBS example IBAN — not a real account.
  const IBAN = 'FR1420041010050500013M02606';

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE quotes RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
  });

  it('round-trips bank details through encryption + normalizes the IBAN', async () => {
    const c = await insertCustomer(db, { fullName: 'Bank Owner' });

    await saveCustomerBankDetails(db, c.id, {
      iban: 'fr14 2004 1010 0505 0001 3m02 606', // spaced + lowercase on purpose
      bic: 'bnpa frpp xxx',
      accountHolder: '  Jean Dupont ',
      birthPlaceCity: 'Lyon',
    });

    const details = await getCustomerBankDetails(db, c.id);
    expect(details).not.toBeNull();
    expect(details!.iban).toBe(IBAN);
    expect(details!.bic).toBe('BNPAFRPPXXX');
    expect(details!.accountHolder).toBe('Jean Dupont');
    expect(details!.birthPlaceCity).toBe('Lyon');
  });

  it('stores ciphertext at rest — plaintext never appears in the row', async () => {
    const c = await insertCustomer(db, { fullName: 'Cipher Check' });
    await saveCustomerBankDetails(db, c.id, {
      iban: IBAN,
      bic: 'BNPAFRPP',
      accountHolder: 'Jean Dupont',
      birthPlaceCity: 'Paris',
    });

    const [raw] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(raw!.bankIbanEnc).toBeTruthy();
    expect(raw!.bankIbanEnc).not.toContain(IBAN);
    expect(raw!.bankIbanEnc).not.toContain(IBAN.slice(4)); // BBAN not in clear either
    expect(raw!.bankBicEnc).not.toContain('BNPAFRPP');
    expect(raw!.bankAccountHolderEnc).not.toContain('Dupont');
    // birth_place_city is the documented plaintext exception (dob tier).
    expect(raw!.birthPlaceCity).toBe('Paris');
  });

  it('rejects an invalid IBAN with a masked message (no plaintext leak)', async () => {
    const c = await insertCustomer(db, { fullName: 'Bad Iban' });
    const bad = 'FR1420041010050500013M02607'; // corrupted checksum
    let caught: Error | undefined;
    try {
      await saveCustomerBankDetails(db, c.id, {
        iban: bad,
        bic: 'BNPAFRPP',
        accountHolder: 'Jean Dupont',
        birthPlaceCity: 'Paris',
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/invalid IBAN/);
    expect(caught!.message).not.toContain(bad);
    expect(caught!.message).toContain('FR14 •••• 2607');
  });

  it('rejects a malformed BIC and blank holder/city', async () => {
    const c = await insertCustomer(db, { fullName: 'Bad Fields' });
    const base = { iban: IBAN, bic: 'BNPAFRPP', accountHolder: 'J D', birthPlaceCity: 'Paris' };
    await expect(saveCustomerBankDetails(db, c.id, { ...base, bic: '12345' })).rejects.toThrow(
      /invalid BIC/,
    );
    await expect(
      saveCustomerBankDetails(db, c.id, { ...base, accountHolder: '  ' }),
    ).rejects.toThrow(/accountHolder/);
    await expect(
      saveCustomerBankDetails(db, c.id, { ...base, birthPlaceCity: '' }),
    ).rejects.toThrow(/birthPlaceCity/);
  });

  it('throws on an unknown customer; returns nulls when never collected', async () => {
    await expect(
      saveCustomerBankDetails(db, randomUUID(), {
        iban: IBAN,
        bic: 'BNPAFRPP',
        accountHolder: 'X Y',
        birthPlaceCity: 'Paris',
      }),
    ).rejects.toThrow(/no customer/);

    expect(await getCustomerBankDetails(db, randomUUID())).toBeNull();

    const c = await insertCustomer(db, { fullName: 'No Bank Yet' });
    const details = await getCustomerBankDetails(db, c.id);
    expect(details).toEqual({ iban: null, bic: null, accountHolder: null, birthPlaceCity: null });
  });
});

// ---------------------------------------------------------------------------
// Subscription status transitions — need Redis too: every mark* helper emits
// LEAD.SYNC_HUBSPOT via the dispatcher when the quote is lead-linked.
// ---------------------------------------------------------------------------
const dd = describe.skipIf(!liveUrl || !redisUrl);

dd('quotes subscription lifecycle (live)', () => {
  let db: Database;
  let savedRedisUrl: string | undefined;
  let savedPrefix: string | undefined;
  let savedHubspotKey: string | undefined;

  beforeAll(() => {
    savedRedisUrl = process.env.REDIS_URL;
    savedPrefix = process.env.BULLMQ_PREFIX;
    // Force HUBSPOT_API_KEY ON so the helpers deterministically emit the
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
    process.env.BULLMQ_PREFIX = `f16-test-subscription-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

  async function seedQuote(withLead = true): Promise<{ quoteId: string; leadId: string | null }> {
    const c = await insertCustomer(db, { fullName: 'Closing Customer' });
    let leadId: string | null = null;
    if (withLead) {
      const [l] = await db
        .insert(leads)
        .values({ source: 'website', productLine: 'scooter', customerId: c.id })
        .returning();
      leadId = l!.id;
    }
    const q = await insertQuote(db, {
      customerId: c.id,
      leadId,
      product: 'scooter',
      productVariant: 'malus',
      sessionId: randomUUID(),
    });
    return { quoteId: q.id, leadId };
  }

  async function countHubspotSyncs(leadId: string): Promise<number> {
    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    return msgs.filter((m) => m.intent === 'LEAD.SYNC_HUBSPOT').length;
  }

  it('defaults to subscription_status="none" on insert', async () => {
    const { quoteId } = await seedQuote();
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.subscriptionStatus).toBe('none');
    expect(row!.subscriptionRequestedAt).toBeNull();
    expect(row!.subscriptionCompletedAt).toBeNull();
    expect(row!.souscripteurRef).toBeNull();
    expect(row!.montantComptant).toBeNull();
    expect(row!.fraisBreakdown).toBeNull();
    expect(row!.stripePaymentLinkUrl).toBeNull();
  });

  it('walks the happy path and emits one HubSpot sync per transition', async () => {
    const { quoteId, leadId } = await seedQuote();

    const requested = await markSubscriptionRequested(db, quoteId);
    expect(requested.subscriptionStatus).toBe('requested');
    expect(requested.subscriptionRequestedAt).toBeInstanceOf(Date);
    expect(await countHubspotSyncs(leadId!)).toBe(1);

    const inProgress = await markSubscriptionInProgress(db, quoteId);
    expect(inProgress.subscriptionStatus).toBe('in_progress');
    expect(await countHubspotSyncs(leadId!)).toBe(2);

    const pending = await markSubscriptionPendingInspector(db, quoteId, {
      souscripteurRef: 'T0001234',
      montantComptantEur: 52.04,
      fraisBreakdown: { fraisGestion: 30, commission: 0.39, fraisDossier: 17 },
      stripePaymentLinkUrl: 'https://buy.stripe.com/test_abc123',
    });
    expect(pending.subscriptionStatus).toBe('pending_inspector');
    expect(pending.souscripteurRef).toBe('T0001234');
    // numeric(10,2) round-trips as a string in postgres-js — that's expected.
    expect(pending.montantComptant).toBe('52.04');
    expect(pending.fraisBreakdown).toEqual({
      fraisGestion: 30,
      commission: 0.39,
      fraisDossier: 17,
    });
    expect(pending.stripePaymentLinkUrl).toBe('https://buy.stripe.com/test_abc123');
    expect(await countHubspotSyncs(leadId!)).toBe(3);

    const issued = await markSubscriptionContractIssued(db, quoteId);
    expect(issued.subscriptionStatus).toBe('contract_issued');
    expect(issued.subscriptionCompletedAt).toBeInstanceOf(Date);
    // Pending-inspector outputs survive the final transition.
    expect(issued.souscripteurRef).toBe('T0001234');
    expect(await countHubspotSyncs(leadId!)).toBe(4);
  });

  it('pendingInspector skips fields the extraction did not produce', async () => {
    const { quoteId } = await seedQuote();
    const row = await markSubscriptionPendingInspector(db, quoteId, {});
    expect(row.subscriptionStatus).toBe('pending_inspector');
    expect(row.souscripteurRef).toBeNull();
    expect(row.montantComptant).toBeNull();
    expect(row.fraisBreakdown).toBeNull();
    expect(row.stripePaymentLinkUrl).toBeNull();
  });

  it('markSubscriptionFailed merges the errorCode into raw_response without clobbering it', async () => {
    const { quoteId } = await seedQuote();
    await db
      .update(quotes)
      .set({ rawResponse: { existing: 'audit-data' } })
      .where(eq(quotes.id, quoteId));

    const failed = await markSubscriptionFailed(db, quoteId, {
      errorCode: 'maxance_subscription_wrong_state',
    });
    expect(failed.subscriptionStatus).toBe('failed');
    expect(failed.rawResponse).toEqual({
      existing: 'audit-data',
      subscriptionError: 'maxance_subscription_wrong_state',
    });
  });

  it('does not emit a HubSpot sync for a lead-less quote', async () => {
    const { quoteId } = await seedQuote(false);
    await markSubscriptionRequested(db, quoteId);
    const msgs = await db.select().from(agentMessages);
    expect(msgs.filter((m) => m.intent === 'LEAD.SYNC_HUBSPOT')).toHaveLength(0);
  });

  it('throws on an unknown quote id', async () => {
    await expect(markSubscriptionRequested(db, randomUUID())).rejects.toThrow(/no quote/);
    await expect(markSubscriptionFailed(db, randomUUID(), { errorCode: 'x' })).rejects.toThrow(
      /no quote/,
    );
  });
});
