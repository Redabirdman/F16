/**
 * Live-DB integration tests for `leads`. Gated on TEST_DATABASE_URL.
 *
 * Covers the basics the lead-intake flow (M5) will rely on:
 *   - default status / nullable score on insert
 *   - state transitions through the lifecycle enum
 *   - common query shapes (by status, by customer, by created_at range)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, and, eq, gte, lte, desc } from 'drizzle-orm';
import { createDb } from '../../src/db/index.js';
import { leads } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';

const liveUrl = process.env.TEST_DATABASE_URL;
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
