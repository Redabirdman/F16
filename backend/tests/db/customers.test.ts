/**
 * Integration tests for customers + customer_facts + conversation_turns
 * against a LIVE Postgres + pgvector. Gated on TEST_DATABASE_URL — skipped
 * otherwise so `pnpm test` stays hermetic in CI environments without docker.
 *
 * Setup: caller is responsible for running `drizzle-kit push` against
 * TEST_DATABASE_URL before invoking these tests. The README + the M2.T3
 * commit message document the recipe.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq, desc } from 'drizzle-orm';
import { createDb } from '../../src/db/index.js';
import { customers, customerFacts, conversationTurns } from '../../src/db/schema/index.js';
import {
  insertCustomer,
  getCustomerById,
  getCustomerByIban,
} from '../../src/db/repositories/customers.js';

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

d('customers (live)', () => {
  const db = createDb(liveUrl!);

  beforeEach(async () => {
    // Cascade from customers wipes facts + turns. Leads have set-null FK so
    // they survive — that's fine here since leads.test.ts owns its own data.
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
  });

  it('roundtrips full PII through insert + select', async () => {
    const input = {
      fullName: 'Élodie Dupont',
      email: 'elodie@example.fr',
      phone: '+33612345678',
      address: { street: '12 rue de Rivoli', city: 'Paris', postcode: '75001' },
      iban: 'FR7630006000011234567890189',
      dob: new Date('1990-05-17'),
      civility: 'Mrs',
      vehicle: { make: 'Renault', model: 'Zoé', year: 2022 },
      driver: { licenseType: 'B', points: 12 },
      preferences: { channel: 'whatsapp', lang: 'fr' },
      consent: { marketing: true, ts: '2026-05-17T12:00:00Z' },
      hubspotId: 'hs-001',
    };
    const inserted = await insertCustomer(db, input);
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);

    const fetched = await getCustomerById(db, inserted.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.fullName).toBe(input.fullName);
    expect(fetched!.email).toBe(input.email);
    expect(fetched!.phone).toBe(input.phone);
    expect(fetched!.address).toEqual(input.address);
    expect(fetched!.iban).toBe(input.iban);
    expect(fetched!.dob?.toISOString().slice(0, 10)).toBe('1990-05-17');
    expect(fetched!.vehicle).toEqual(input.vehicle);
    expect(fetched!.consent).toEqual(input.consent);
    expect(fetched!.hubspotId).toBe('hs-001');

    // Verify the raw ciphertext does NOT equal the plaintext (sanity).
    const [raw] = await db
      .select({ name: customers.fullName, iban: customers.ibanCiphertext })
      .from(customers)
      .where(eq(customers.id, inserted.id));
    expect(raw!.name).not.toBe(input.fullName);
    expect(raw!.iban).not.toBe(input.iban);
  });

  it('enforces IBAN dedup via unique hash index', async () => {
    const base = { fullName: 'A', iban: 'FR7630006000011234567890189' };
    await insertCustomer(db, base);
    await expect(insertCustomer(db, { ...base, fullName: 'B' })).rejects.toThrow();

    // And the lookup-by-IBAN helper finds the original (not the rejected dupe).
    const found = await getCustomerByIban(db, base.iban);
    expect(found?.fullName).toBe('A');
  });

  it('cascades customer delete to customer_facts', async () => {
    const c = await insertCustomer(db, { fullName: 'CascadeTest' });
    await db.insert(customerFacts).values([
      {
        customerId: c.id,
        factType: 'preference',
        content: 'prefers WhatsApp evenings',
        confidence: 0.8,
        recordedBy: 'sales-agent',
      },
      {
        customerId: c.id,
        factType: 'objection',
        content: 'price too high',
        confidence: 0.6,
        recordedBy: 'sales-agent',
      },
    ]);
    const before = await db.select().from(customerFacts).where(eq(customerFacts.customerId, c.id));
    expect(before).toHaveLength(2);

    await db.delete(customers).where(eq(customers.id, c.id));

    const after = await db.select().from(customerFacts).where(eq(customerFacts.customerId, c.id));
    expect(after).toHaveLength(0);
  });

  it('orders conversation_turns by occurred_at desc', async () => {
    const c = await insertCustomer(db, { fullName: 'TurnsTest' });
    const earlier = new Date('2026-05-16T10:00:00Z');
    const later = new Date('2026-05-16T11:00:00Z');

    await db.insert(conversationTurns).values([
      {
        customerId: c.id,
        channel: 'whatsapp',
        direction: 'inbound',
        content: 'hi',
        occurredAt: earlier,
      },
      {
        customerId: c.id,
        channel: 'whatsapp',
        direction: 'outbound',
        agentRole: 'sales-agent',
        agentInstance: 'sales-1',
        content: 'hello back',
        occurredAt: later,
      },
    ]);

    const rows = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, c.id))
      .orderBy(desc(conversationTurns.occurredAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe('hello back');
    expect(rows[1]!.content).toBe('hi');
  });

  it('pgvector kNN smoke — finds the nearer fact first', async () => {
    const c = await insertCustomer(db, { fullName: 'VectorTest' });
    // Use 1536-dim toy vectors: one pointing along dim 0, one along dim 1.
    const v1 = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    const v2 = Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0));
    await db.insert(customerFacts).values([
      { customerId: c.id, factType: 'observation', content: 'fact-1', embedding: v1 },
      { customerId: c.id, factType: 'observation', content: 'fact-2', embedding: v2 },
    ]);

    // Query close to v1 — fact-1 must rank first by cosine distance (<=>).
    const queryVec = `[${v1.join(',')}]`;
    const rows = (await db.execute(
      sql`SELECT content FROM customer_facts WHERE customer_id = ${c.id} ORDER BY embedding <=> ${queryVec}::vector LIMIT 2`,
    )) as unknown as Array<{ content: string }>;
    expect(rows[0]?.content).toBe('fact-1');
    expect(rows[1]?.content).toBe('fact-2');
  });
});
