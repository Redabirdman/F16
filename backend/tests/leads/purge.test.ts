/**
 * DB-gated tests for `purgeContact` (src/leads/purge.ts).
 *
 * Gated on TEST_DATABASE_URL — run ONLY against f16_test (5435), never the
 * prod f16 db. Mirrors the gating + lifecycle of tests/db/subscription.test.ts:
 * skipIf when no live url, createDb(url), $client.end() on teardown, a random
 * PII_ENCRYPTION_KEY so the customers repo can encrypt/hash the phone for dedup.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { customers, leads, conversationTurns } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { insertQuote } from '../../src/db/repositories/quotes.js';
import { purgeContact } from '../../src/leads/purge.js';

const liveUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!liveUrl);

let savedKey: string | undefined;
let db: Database;
beforeAll(() => {
  savedKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  if (liveUrl) db = createDb(liveUrl);
});
afterAll(async () => {
  if (db) await db.$client.end();
  if (savedKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedKey;
});

d('purgeContact', () => {
  const phone = '+33600000111';

  // Start each test from a clean slate for this phone.
  beforeEach(async () => {
    await purgeContact(db, { phone });
  });

  it('removes the customer + their leads/quotes/conversations and is idempotent', async () => {
    const cust = await insertCustomer(db, { fullName: 'Test Purge', email: null, phone });
    const [lead] = await db
      .insert(leads)
      .values({ customerId: cust.id, source: 'meta', productLine: 'scooter', status: 'new' })
      .returning();
    await insertQuote(db, {
      customerId: cust.id,
      leadId: lead!.id,
      product: 'scooter',
      productVariant: 'trottinette',
      sessionId: `sess-${lead!.id}`,
    });
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      channel: 'whatsapp',
      direction: 'outbound',
      content: 'hi',
    });

    const res = await purgeContact(db, { phone });
    expect(res.customer).toBe(1);
    expect(res.leads).toBeGreaterThanOrEqual(1);
    expect(res.quotes).toBeGreaterThanOrEqual(1);
    expect(res.conversations).toBeGreaterThanOrEqual(1);

    const left = await db.select().from(customers).where(eq(customers.id, cust.id));
    expect(left.length).toBe(0);

    const again = await purgeContact(db, { phone }); // idempotent
    expect(again.customer).toBe(0);
    expect(again.leads).toBe(0);
    expect(again.quotes).toBe(0);
    expect(again.conversations).toBe(0);
  });

  it('returns all-zero counts for an unknown / unnormalizable phone', async () => {
    expect(await purgeContact(db, { phone: '+33699999000' })).toEqual({
      customer: 0,
      leads: 0,
      quotes: 0,
      conversations: 0,
      humanActions: 0,
    });
    // Unnormalizable phone short-circuits before any DB read.
    expect(await purgeContact(db, { phone: '123' })).toEqual({
      customer: 0,
      leads: 0,
      quotes: 0,
      conversations: 0,
      humanActions: 0,
    });
  });
});
