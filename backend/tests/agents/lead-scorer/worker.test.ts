/**
 * Lead Scorer worker integration tests (M5.T3).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY — the
 * standard M5 trio. The Claude SDK is replaced by a stub `callClaudeImpl`
 * so these tests don't pay LLM costs or require ANTHROPIC_API_KEY. The
 * separate `live.test.ts` covers the real-network smoke check.
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
import type { callClaude } from '../../../src/llm/claude.js';
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

/** Spin-wait until `pred()` returns true or budget expires. */
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

/**
 * Build a stub callClaude that returns a canned string and captures the
 * arguments it was invoked with (so tests can assert what got into the prompt).
 */
type StubCall = { tier: string; userPrompt: string; systemFragments?: unknown };
function makeStub(resp: string | (() => string) | (() => Promise<string>) | { throws: Error }): {
  fn: typeof callClaude;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fn = (async (input: Parameters<typeof callClaude>[0]) => {
    calls.push({
      tier: input.tier,
      userPrompt: input.userPrompt,
      systemFragments: input.systemFragments,
    });
    if (typeof resp === 'object' && 'throws' in resp) throw resp.throws;
    const value = typeof resp === 'function' ? await resp() : resp;
    if (input.structured) {
      return {
        text: value,
        model: 'haiku-stub',
        tier: input.tier,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
        stopReason: 'end_turn',
        durationMs: 1,
      };
    }
    return value;
  }) as typeof callClaude;
  return { fn, calls };
}

d('lead-scorer worker (stubbed LLM)', () => {
  let db: Database;
  let worker: Worker | undefined;
  let prefix: string;

  beforeEach(async () => {
    prefix = `f16-test-lscore-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

  // -------------------------------------------------------------------------
  // 1. Happy path: stub returns valid JSON, lead gets scored, LEAD.SCORED emitted
  // -------------------------------------------------------------------------
  it('test 1 (happy path): valid JSON -> lead.score=85, status=scored, LEAD.SCORED emitted to sales-agent', async () => {
    const stub = makeStub(
      '{"score":85,"channel":"whatsapp","opening":"Bonjour Marie, c\'est Assuryal. Pouvez-vous me confirmer votre besoin ?","rationale":"phone+email+name"}',
    );
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const customer = await insertCustomer(db, {
      fullName: 'Marie Curie',
      email: 'marie@example.com',
      phone: '+33612345678',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
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

    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return row?.score !== null && row?.score !== undefined;
    });

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.score).toBe(85);
    expect(final!.status).toBe('scored');
    expect(final!.scoredAt).not.toBeNull();

    // Singleton model: exactly ONE LEAD.SCORED row, addressed to the
    // sales-agent singleton by role only (no instance targeting).
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return rows.filter((r) => r.intent === 'LEAD.SCORED').length >= 1;
    });

    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    const scoredRows = rows.filter((r) => r.intent === 'LEAD.SCORED');
    expect(scoredRows).toHaveLength(1);
    expect(scoredRows[0]!.toRole).toBe('sales-agent');
    expect(scoredRows[0]!.toInstance).toBeNull();

    // Payload carries the lead context.
    const payload = scoredRows[0]!.payload as Record<string, unknown>;
    expect(payload['leadId']).toBe(leadId);
    expect(payload['score']).toBe(85);
    expect(payload['channel']).toBe('whatsapp');
    expect(typeof payload['opening']).toBe('string');

    // LLM was called exactly once with haiku tier + cached rubric.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.tier).toBe('haiku');
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency: pre-scored lead skips the LLM + emits nothing new
  // -------------------------------------------------------------------------
  it('test 2 (idempotency): pre-scored lead is skipped, no LLM call, no LEAD.SCORED row', async () => {
    const stub = makeStub('SHOULD NOT BE CALLED');
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const customer = await insertCustomer(db, {
      fullName: 'Bob',
      email: 'bob@example.com',
      phone: '+33612345679',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'scored',
        score: 77,
        scoredAt: new Date(),
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

    // Wait for the LEAD.NEW row to be consumed (handler returns skipped).
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      const leadNew = rows.find((r) => r.intent === 'LEAD.NEW');
      return leadNew?.consumedAt != null;
    });

    expect(stub.calls).toHaveLength(0);

    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    // No LEAD.SCORED emitted.
    expect(rows.some((r) => r.intent === 'LEAD.SCORED')).toBe(false);
    // The LEAD.NEW row's result indicates the skip.
    const leadNew = rows.find((r) => r.intent === 'LEAD.NEW')!;
    const result = leadNew.result as Record<string, unknown>;
    expect(result['skipped']).toBe('already-scored');
    expect(result['score']).toBe(77);

    // Lead score unchanged.
    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.score).toBe(77);
  });

  // -------------------------------------------------------------------------
  // 3. Invalid JSON from LLM -> heuristic fallback still scores the lead
  // -------------------------------------------------------------------------
  it('test 3 (invalid JSON): falls back to heuristic, score persisted, LEAD.SCORED still emitted', async () => {
    const stub = makeStub('pas du JSON valide, juste du texte libre');
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const customer = await insertCustomer(db, {
      fullName: 'Heuristic Tester',
      email: 'h@example.com',
      phone: '+33612345670',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
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

    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return row?.score !== null && row?.score !== undefined;
    });

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    // Heuristic: 30 base + 20 phone + 15 email + 10 name = 75 for website source.
    expect(final!.score).toBeGreaterThanOrEqual(30);
    expect(final!.status).toBe('scored');

    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect(rows.some((r) => r.intent === 'LEAD.SCORED')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. JSON wrapped in ```json fence is still parsed
  // -------------------------------------------------------------------------
  it('test 4 (fenced JSON): ```json wrapper is stripped, score parsed correctly', async () => {
    const stub = makeStub(
      '```json\n{"score":50,"channel":"email","opening":"Bonjour, c\'est Assuryal. Pouvez-vous préciser votre besoin ?","rationale":"email only"}\n```',
    );
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const customer = await insertCustomer(db, {
      fullName: 'Fenced',
      email: 'fenced@example.com',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'meta',
        productLine: 'car',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'meta', productLine: 'car' },
        correlationId: leadId,
        priority: 4,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return row?.score !== null && row?.score !== undefined;
    });

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.score).toBe(50);
  });

  // -------------------------------------------------------------------------
  // 5. Schema-violating JSON (score=150) -> heuristic fallback
  // -------------------------------------------------------------------------
  it('test 5 (schema-violating): score out of range -> heuristic fallback', async () => {
    const stub = makeStub('{"score":150,"channel":"whatsapp","opening":"hi","rationale":"nope"}');
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const customer = await insertCustomer(db, {
      fullName: 'Schema Tester',
      phone: '+33612345677',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'organic',
        productLine: 'car',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'organic', productLine: 'car' },
        correlationId: leadId,
        priority: 4,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return row?.score !== null && row?.score !== undefined;
    });

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    // Heuristic for phone+name (no email), source=organic: 30 + 20 + 10 = 60
    expect(final!.score).toBeLessThanOrEqual(100);
    expect(final!.score).toBeGreaterThanOrEqual(30);
    expect(final!.status).toBe('scored');
  });

  // -------------------------------------------------------------------------
  // 6. Claude throws -> agent_message.error populated, lead.score still null
  // -------------------------------------------------------------------------
  it('test 6 (Claude throws): error column populated, no LEAD.SCORED, lead.score stays null', async () => {
    const stub = makeStub({ throws: new Error('rate limit') });
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const customer = await insertCustomer(db, {
      fullName: 'Rate Limited',
      email: 'rate@example.com',
      phone: '+33612345671',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
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

    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return rows.some((r) => r.intent === 'LEAD.NEW' && r.error != null);
    });

    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    const leadNew = rows.find((r) => r.intent === 'LEAD.NEW')!;
    expect(leadNew.error).toMatch(/rate limit/);
    // No LEAD.SCORED row.
    expect(rows.some((r) => r.intent === 'LEAD.SCORED')).toBe(false);

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.score).toBeNull();
    expect(final!.status).toBe('new');
  });

  // -------------------------------------------------------------------------
  // 7. Enrichment: full customer -> userPrompt sent to stub contains all fields
  // -------------------------------------------------------------------------
  it('test 7 (enrichment): full customer fields end up in the user prompt', async () => {
    const stub = makeStub(
      '{"score":92,"channel":"whatsapp","opening":"Bonjour Marie, c\'est Assuryal.","rationale":"hot"}',
    );
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const customer = await insertCustomer(db, {
      fullName: 'Marie Dupont',
      email: 'marie.dupont@example.com',
      phone: '+33612345672',
      vehicle: { type: 'trottinette', brand: 'Xiaomi' },
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'meta',
        productLine: 'scooter',
        status: 'new',
        rawPayload: { gdpr: true, budget: '5€' },
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'meta', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return row?.score !== null && row?.score !== undefined;
    });

    expect(stub.calls).toHaveLength(1);
    const sent = stub.calls[0]!.userPrompt;
    expect(sent).toContain('Marie Dupont');
    expect(sent).toContain('marie.dupont@example.com');
    expect(sent).toContain('+33612345672');
    expect(sent).toContain('Xiaomi');
    expect(sent).toContain('budget');
  });

  // -------------------------------------------------------------------------
  // 8. No-customer lead: scoring still works, no PII in prompt
  // -------------------------------------------------------------------------
  it('test 8 (no customer): lead without customerId still gets scored', async () => {
    const stub = makeStub(
      '{"score":20,"channel":"email","opening":"Bonjour, pouvez-vous me préciser votre besoin ?","rationale":"no info"}',
    );
    worker = startLeadScorerWorker({ db, callClaudeImpl: stub.fn });

    const [insertedLead] = await db
      .insert(leads)
      .values({
        // customerId omitted
        source: 'organic',
        productLine: 'car',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'organic', productLine: 'car' },
        correlationId: leadId,
        priority: 4,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return row?.score !== null && row?.score !== undefined;
    });

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.score).toBe(20);
    expect(final!.status).toBe('scored');

    const sent = stub.calls[0]!.userPrompt;
    expect(sent).not.toMatch(/- Nom/);
    expect(sent).not.toMatch(/- Email/);
    expect(sent).not.toMatch(/- Téléphone/);
  });
});
