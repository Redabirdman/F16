/**
 * Lead Scorer LIVE Claude smoke test (M5.T3).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY +
 * ANTHROPIC_API_KEY. Hits the real Haiku endpoint exactly once.
 *
 * Budget: ~$0.001 per run with maxTokens=300. The cap is enforced by the
 * SDK call's `maxTokens` advisory; we also keep the prompt short to stay
 * deep inside the cache-aware envelope on subsequent runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { createDb, type Database } from '../../../src/db/index.js';
import { agentMessages, leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { sendMessage } from '../../../src/messaging/dispatcher.js';
import { startLeadScorerWorker } from '../../../src/agents/lead-scorer/index.js';
import { __resetForTests, shutdownQueues } from '../../../src/queue/index.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const liveAll = Boolean(pgUrl && redisUrl && hasKey);
const d = describe.skipIf(!liveAll);

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

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

d('lead-scorer worker (LIVE Claude Haiku)', () => {
  let db: Database;
  let worker: Worker | undefined;
  let prefix: string;

  beforeEach(async () => {
    prefix = `f16-test-lscore-live-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    if (worker) await worker.close().catch(() => {});
    worker = undefined;
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  it('scores a realistic French scooter lead via real Haiku call', async () => {
    worker = startLeadScorerWorker({ db });

    const customer = await insertCustomer(db, {
      fullName: 'Marie Dupont',
      email: 'marie.dupont@example.com',
      phone: '+33612345678',
      vehicle: { type: 'trottinette', brand: 'Xiaomi', model: 'Pro 2' },
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
        rawPayload: { gdpr: true, budget: '5-10€/mois' },
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    // Live LLM call — allow plenty of budget for the round-trip.
    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return row?.score !== null && row?.score !== undefined;
    }, 30_000);

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(typeof final!.score).toBe('number');
    expect(final!.score!).toBeGreaterThanOrEqual(0);
    expect(final!.score!).toBeLessThanOrEqual(100);
    expect(final!.status).toBe('scored');
    expect(final!.scoredAt).not.toBeNull();

    // LEAD.SCORED was emitted with a valid channel + a French opening.
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return rows.some((r) => r.intent === 'LEAD.SCORED');
    }, 5_000);

    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    const scored = rows.find((r) => r.intent === 'LEAD.SCORED')!;
    const payload = scored.payload as Record<string, unknown>;
    expect(['whatsapp', 'voice', 'email', 'sms']).toContain(payload['channel']);
    expect(typeof payload['opening']).toBe('string');
    // French opening — at least one accent/cedilla/apostrophe ought to land.
    const opening = payload['opening'] as string;
    expect(opening.length).toBeGreaterThan(5);
    // Loose check: French openings almost always include a common French
    // greeting or accented character.
    expect(opening).toMatch(/[éèêàçâô']|Bonjour|Bonsoir|Salut/i);
  }, 60_000);
});
