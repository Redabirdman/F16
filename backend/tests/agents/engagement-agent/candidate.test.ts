/**
 * Candidate query (M11) — DB-backed unit tests.
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY, same scheme as the
 * Sales Agent integration tests. Seeds a handful of leads with controlled
 * status + most-recent-turn timestamps and verifies the query returns only
 * the eligible, sufficiently-stale ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { conversationTurns, leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { findEngagementCandidates } from '../../../src/agents/engagement-agent/candidate.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

/**
 * Monotonic counter so every seeded customer gets a UNIQUE phone. The
 * `customers_phone_hash_uniq` partial index rejects duplicate phone hashes, so
 * tests that seed multiple customers must not reuse a number. Never reset — a
 * strictly-increasing value is collision-free even across truncating tests.
 */
let seedSeq = 0;

/** Helper: seed a lead with a controllable status + a single conversation turn. */
async function seedLeadWithTurn(
  db: Database,
  opts: {
    status: 'new' | 'scored' | 'qualifying' | 'quoting' | 'negotiating' | 'closed_won' | 'dormant';
    turnAgoHours: number;
  },
): Promise<string> {
  seedSeq += 1;
  const c = await insertCustomer(db, {
    fullName: 'Test Lead',
    // Unique per seed: +336 2X XX XX XX, distinct from the +33611111112 used by
    // the no-turns test below.
    phone: `+336${String(20_000_000 + seedSeq)}`,
  });
  const [lead] = await db
    .insert(leads)
    .values({
      customerId: c.id,
      source: 'website',
      productLine: 'scooter',
      status: opts.status,
      score: 70,
    })
    .returning();
  const turnAt = new Date(Date.now() - opts.turnAgoHours * 3600_000);
  await db.insert(conversationTurns).values({
    customerId: c.id,
    leadId: lead!.id,
    channel: 'whatsapp',
    direction: 'outbound',
    agentRole: 'sales-agent',
    agentInstance: 'lead-test',
    content: 'welcome',
    occurredAt: turnAt,
  });
  return lead!.id;
}

d('findEngagementCandidates', () => {
  let db: Database;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
  });

  it('returns a qualifying lead with >24h since last turn', async () => {
    const leadId = await seedLeadWithTurn(db, { status: 'qualifying', turnAgoHours: 30 });
    const candidates = await findEngagementCandidates(db);
    const ids = candidates.map((c) => c.leadId);
    expect(ids).toContain(leadId);
  });

  it('excludes leads with last turn <24h ago', async () => {
    const leadId = await seedLeadWithTurn(db, { status: 'qualifying', turnAgoHours: 2 });
    const candidates = await findEngagementCandidates(db);
    expect(candidates.map((c) => c.leadId)).not.toContain(leadId);
  });

  it('excludes leads in non-eligible statuses (new, closed_won, dormant)', async () => {
    const newId = await seedLeadWithTurn(db, { status: 'new', turnAgoHours: 100 });
    const wonId = await seedLeadWithTurn(db, { status: 'closed_won', turnAgoHours: 100 });
    const dormantId = await seedLeadWithTurn(db, { status: 'dormant', turnAgoHours: 100 });
    const candidates = await findEngagementCandidates(db);
    const ids = candidates.map((c) => c.leadId);
    expect(ids).not.toContain(newId);
    expect(ids).not.toContain(wonId);
    expect(ids).not.toContain(dormantId);
  });

  it('includes leads in scored, qualifying, quoting, negotiating statuses', async () => {
    const a = await seedLeadWithTurn(db, { status: 'scored', turnAgoHours: 30 });
    const b = await seedLeadWithTurn(db, { status: 'qualifying', turnAgoHours: 30 });
    const c = await seedLeadWithTurn(db, { status: 'quoting', turnAgoHours: 30 });
    const e = await seedLeadWithTurn(db, { status: 'negotiating', turnAgoHours: 30 });
    const ids = (await findEngagementCandidates(db)).map((cd) => cd.leadId);
    expect(ids).toEqual(expect.arrayContaining([a, b, c, e]));
  });

  it('excludes leads with no conversation turns at all', async () => {
    const cust = await insertCustomer(db, { fullName: 'No Turn', phone: '+33611111112' });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: cust.id,
        source: 'website',
        productLine: 'scooter',
        status: 'qualifying',
        score: 70,
      })
      .returning();
    const candidates = await findEngagementCandidates(db);
    expect(candidates.map((c) => c.leadId)).not.toContain(lead!.id);
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedLeadWithTurn(db, { status: 'qualifying', turnAgoHours: 30 + i });
    }
    const candidates = await findEngagementCandidates(db, { limit: 3 });
    expect(candidates.length).toBeLessThanOrEqual(3);
  });
});
