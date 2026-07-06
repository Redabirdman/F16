/**
 * Choice executors — DB+Redis-backed tests (2026-07-06).
 *
 * Covers the "Retry the quote" resolution actually re-running the quote:
 *   - QUOTE_FAILED:retry mints a NEW quotes row + emits QUOTE.REQUESTED to
 *     the maxance-operator with the original run's exact formData, flips the
 *     lead to 'quoting', and returns the English group note.
 *   - QUOTE_STUCK:retry is NOT self-blocked by the stuck quote's own
 *     'requested' row (the ne() exclusion).
 *   - In-flight guard: another priceless 'requested' quote younger than 72h
 *     for the same lead skips the retry with the "already running" note.
 *   - No stored rawFormData → graceful note, no insert, no emit.
 *   - Unregistered (intent, option) pairs → null, no side effects.
 *   - Business-hours parking: portal closed (frozen Saturday clock) → the
 *     BullMQ delivery is DELAYED and the note carries the parked suffix.
 *   - Agent wiring: HUMAN_ACTION.RESOLVED through ReporterAgent posts the
 *     closure AND the retry confirmation, and the retry side effect runs.
 *
 * Same live-infra shape as tests/messaging/dispatcher.test.ts (unique
 * BULLMQ_PREFIX per test, redis key wipe in afterEach) + the watchdog suite's
 * seeding helpers. Gated on TEST_DATABASE_URL + TEST_REDIS_URL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { agentMessages, leads, quotes } from '../../../src/db/schema/index.js';
import type { HumanAction } from '../../../src/db/schema/agent-runtime.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { createAction } from '../../../src/db/repositories/human-actions.js';
import { physicalQueueName } from '../../../src/messaging/dispatcher.js';
import { getQueue, shutdownQueues, __resetForTests } from '../../../src/queue/index.js';
import {
  executeResolutionChoice,
  hasChoiceExecutor,
} from '../../../src/agents/reporter-agent/choice-executors.js';
import { ReporterAgent } from '../../../src/agents/reporter-agent/agent.js';
import type { WahaClient } from '../../../src/channels/whatsapp/waha-client.js';
import type { AgentMessageEnvelope } from '../../../src/messaging/dispatcher.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const d = describe.skipIf(!pgUrl || !redisUrl);

const TROTTINETTE_FORM_DATA = {
  vehicleKind: 'trottinette',
  purchasePriceEur: 800,
  purchaseDate: '2026-01-15',
  postalCode: '75011',
  stationnement: 'garage_box',
  clientDateOfBirth: '1995-03-20',
};

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

d('reporter-agent choice executors (live)', () => {
  let db: Database;
  let prefix: string;
  let seedSeq = 0;

  beforeEach(async () => {
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE quotes RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);

    // Deterministic OPEN window by default; the parking test opts out.
    process.env.MAXANCE_HOURS_247 = '1';
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.MAXANCE_HOURS_247;
    // Best-effort wipe of test-prefix keys, then drop the cached singletons.
    try {
      const cleaner = new Redis(redisUrl!, { maxRetriesPerRequest: null, enableReadyCheck: false });
      const keys = await cleaner.keys(`${prefix}:*`);
      if (keys.length > 0) await cleaner.del(...keys);
      await cleaner.quit();
    } catch {
      /* ignore */
    }
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  /** Seed customer + lead + one quote row (rawFormData opt-out for the guard test). */
  async function seedQuote(opts: {
    status: 'requested' | 'expired' | 'ready';
    rawFormData?: Record<string, unknown> | null;
    fullName?: string;
  }): Promise<{ quoteId: string; leadId: string; customerId: string }> {
    const suffix = String(seedSeq++).padStart(2, '0');
    const cust = await insertCustomer(db, {
      fullName: opts.fullName ?? 'Marie Testeuse',
      phone: `+336222222${suffix}`,
      email: `marie.retry.${suffix}@example.com`,
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: cust.id,
        source: 'website',
        productLine: 'scooter',
        status: 'quoting',
        score: 80,
      })
      .returning();
    const [quote] = await db
      .insert(quotes)
      .values({
        customerId: cust.id,
        leadId: lead!.id,
        product: 'scooter',
        productVariant: 'trottinette',
        status: opts.status,
        sessionId: `sess-${randomUUID()}`,
        rawFormData: opts.rawFormData === undefined ? TROTTINETTE_FORM_DATA : opts.rawFormData,
      })
      .returning();
    return { quoteId: quote!.id, leadId: lead!.id, customerId: cust.id };
  }

  /** human_actions row shaped like the QUOTE_FAILED/QUOTE_STUCK creation sites. */
  async function seedAction(intent: 'QUOTE_FAILED' | 'QUOTE_STUCK', quoteId: string) {
    return createAction(db, {
      createdByAgent: 'sales-agent#singleton',
      correlationId: quoteId,
      intent,
      severity: 2,
      summary: `Quote ${quoteId} failed (login_failed:maxance_extension_no_active_tab).`,
      options: [
        { id: 'retry', label: 'Retry the quote', kind: 'approve' },
        { id: 'manual', label: 'Do the quote manually', kind: 'approve' },
        { id: 'abandon', label: 'Abandon this lead', kind: 'reject' },
      ],
    });
  }

  function execCtx(action: HumanAction, choice = 'retry') {
    return {
      db,
      action,
      chosenOptionId: choice,
      fromRole: 'human-router',
      fromInstance: 'singleton',
    };
  }

  it('registers the two V1 executors', () => {
    expect(hasChoiceExecutor('QUOTE_FAILED', 'retry')).toBe(true);
    expect(hasChoiceExecutor('QUOTE_STUCK', 'retry')).toBe(true);
    expect(hasChoiceExecutor('QUOTE_FAILED', 'manual')).toBe(false);
    expect(hasChoiceExecutor('SUBSCRIPTION_FAILED', 'retry')).toBe(false);
  });

  it('QUOTE_FAILED:retry mints a new quote + emits QUOTE.REQUESTED + flips the lead', async () => {
    const { quoteId, leadId, customerId } = await seedQuote({ status: 'expired' });
    const action = await seedAction('QUOTE_FAILED', quoteId);

    const result = await executeResolutionChoice(execCtx(action));

    expect(result).not.toBeNull();
    expect(result?.detail).toMatchObject({ retried: true, parked: false });
    const newQuoteId = result?.detail?.newQuoteId as string;
    expect(newQuoteId).toBeDefined();
    expect(newQuoteId).not.toBe(quoteId);

    // New canonical quotes row, fresh session, same lead/customer/formData.
    const rows = await db.select().from(quotes);
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.id === newQuoteId);
    expect(fresh).toBeDefined();
    expect(fresh?.status).toBe('requested');
    expect(fresh?.customerId).toBe(customerId);
    expect(fresh?.leadId).toBe(leadId);
    expect(fresh?.product).toBe('scooter');
    expect(fresh?.productVariant).toBe('trottinette');
    expect(fresh?.rawFormData).toEqual(TROTTINETTE_FORM_DATA);
    expect(fresh?.sessionId).not.toBe(rows.find((r) => r.id === quoteId)?.sessionId);

    // QUOTE.REQUESTED emitted to the maxance-operator with the tool's shape.
    const msgs = await db.select().from(agentMessages);
    const emitted = msgs.find((m) => m.intent === 'QUOTE.REQUESTED');
    expect(emitted).toBeDefined();
    expect(emitted?.toRole).toBe('maxance-operator');
    expect(emitted?.toInstance).toBe('singleton');
    expect(emitted?.fromRole).toBe('human-router');
    expect(emitted?.payload).toEqual({
      quoteId: newQuoteId,
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'trottinette',
      formData: TROTTINETTE_FORM_DATA,
    });

    // Lead lifecycle flipped best-effort.
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    expect(lead?.status).toBe('quoting');

    // English group note: first name + new short ref, no parked suffix (247 on).
    expect(result?.groupNote).toContain('Retrying the quote for Marie');
    expect(result?.groupNote).toContain(`#${newQuoteId.slice(0, 8)}`);
    expect(result?.groupNote).not.toContain('portal closed');
  });

  it("QUOTE_STUCK:retry is not blocked by the stuck quote's own 'requested' row", async () => {
    // A stuck quote is still status='requested' with no price — the in-flight
    // guard must exclude it (ne) or every stuck retry would self-block.
    const { quoteId } = await seedQuote({ status: 'requested' });
    const action = await seedAction('QUOTE_STUCK', quoteId);

    const result = await executeResolutionChoice(execCtx(action));

    expect(result?.detail).toMatchObject({ retried: true });
    expect(await db.select().from(quotes)).toHaveLength(2);
    const msgs = await db.select().from(agentMessages);
    expect(msgs.some((m) => m.intent === 'QUOTE.REQUESTED')).toBe(true);
  });

  it('skips with an "already running" note when another quote is in flight', async () => {
    const { quoteId, leadId, customerId } = await seedQuote({ status: 'expired' });
    // A second, priceless 'requested' quote for the SAME lead (e.g. a prior
    // retry or a parked weekend job) — the guard must skip.
    await db.insert(quotes).values({
      customerId,
      leadId,
      product: 'scooter',
      productVariant: 'trottinette',
      status: 'requested',
      sessionId: `sess-${randomUUID()}`,
      rawFormData: TROTTINETTE_FORM_DATA,
    });
    const action = await seedAction('QUOTE_FAILED', quoteId);

    const result = await executeResolutionChoice(execCtx(action));

    expect(result?.groupNote).toBe('A retry is already running for this customer.');
    expect(result?.detail).toMatchObject({ retried: false, reason: 'retry_in_flight' });
    expect(await db.select().from(quotes)).toHaveLength(2); // nothing new
    const msgs = await db.select().from(agentMessages);
    expect(msgs.some((m) => m.intent === 'QUOTE.REQUESTED')).toBe(false);
  });

  it('degrades gracefully when the quote has no stored form data', async () => {
    const { quoteId } = await seedQuote({ status: 'expired', rawFormData: null });
    const action = await seedAction('QUOTE_FAILED', quoteId);

    const result = await executeResolutionChoice(execCtx(action));

    expect(result?.groupNote).toContain('Could not retry automatically');
    expect(result?.groupNote).toContain('run it from the admin');
    expect(result?.detail).toMatchObject({ retried: false, reason: 'no_stored_form_data' });
    expect(await db.select().from(quotes)).toHaveLength(1);
    const msgs = await db.select().from(agentMessages);
    expect(msgs.some((m) => m.intent === 'QUOTE.REQUESTED')).toBe(false);
  });

  it('returns null (no side effects) for unregistered choices', async () => {
    const { quoteId } = await seedQuote({ status: 'expired' });
    const action = await seedAction('QUOTE_FAILED', quoteId);

    expect(await executeResolutionChoice(execCtx(action, 'manual'))).toBeNull();
    expect(await executeResolutionChoice(execCtx(action, 'abandon'))).toBeNull();
    expect(
      await executeResolutionChoice(execCtx({ ...action, intent: 'LEAD_DORMANT' }, 'retry')),
    ).toBeNull();

    expect(await db.select().from(quotes)).toHaveLength(1);
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });

  it('parks the retry as a DELAYED delivery when the portal is closed', async () => {
    // Real business window (no 247 escape) + a frozen Saturday-noon clock —
    // same instant the business-hours suite uses for "weekend closed".
    delete process.env.MAXANCE_HOURS_247;
    vi.useFakeTimers({ toFake: ['Date'] }); // Date only — BullMQ/redis keep real timers
    vi.setSystemTime(new Date('2026-07-11T11:00:00Z')); // Sat 12:00 Casablanca

    const { quoteId } = await seedQuote({ status: 'expired' });
    const action = await seedAction('QUOTE_FAILED', quoteId);

    const result = await executeResolutionChoice(execCtx(action));

    expect(result?.detail).toMatchObject({ retried: true, parked: true });
    expect(result?.groupNote).toContain('Retrying the quote for Marie');
    expect(result?.groupNote).toContain('(portal closed — it will run at reopening)');

    // Durable row exists now; the BullMQ job sits in the DELAYED set.
    const msgs = await db.select().from(agentMessages);
    expect(msgs.some((m) => m.intent === 'QUOTE.REQUESTED')).toBe(true);
    const queue = getQueue(physicalQueueName('quote', 'maxance-operator'));
    expect(await queue.getDelayedCount()).toBe(1);
  });

  it('wires through ReporterAgent RESOLVED: closure + retry confirmation posted', async () => {
    const { quoteId } = await seedQuote({ status: 'expired' });
    const action = await seedAction('QUOTE_FAILED', quoteId);

    const sent: Array<{ chatId: string; text: string }> = [];
    const waha = {
      sendText: vi.fn(async (input: { chatId: string; text: string }) => {
        sent.push(input);
        return { id: 'm1' } as unknown as Awaited<ReturnType<WahaClient['sendText']>>;
      }),
    } as unknown as WahaClient;

    class TestableReporter extends ReporterAgent {
      public callOnMessage(envelope: AgentMessageEnvelope): Promise<unknown> {
        return (
          this as unknown as { onMessage: (e: AgentMessageEnvelope) => Promise<unknown> }
        ).onMessage(envelope);
      }
    }
    const agent = new TestableReporter(
      {
        role: 'human-router',
        instanceId: 'singleton',
        model: 'haiku',
        queues: ['human_action'],
        db,
      },
      { waha, groupChatId: '120363012345678901@g.us' },
    );

    const result = (await agent.callOnMessage({
      id: randomUUID(),
      fromRole: 'admin',
      fromInstance: 'singleton',
      toRole: 'human-router',
      toInstance: 'singleton',
      intent: 'HUMAN_ACTION.RESOLVED',
      payload: { humanActionId: action.id, choice: 'retry', source: 'whatsapp' },
      correlationId: action.id,
      priority: 3,
      createdAt: new Date(),
      requiresHuman: false,
    } as unknown as AgentMessageEnvelope)) as {
      ok: boolean;
      result?: { executed?: { retried?: boolean } };
    };

    expect(result.ok).toBe(true);
    expect(result.result?.executed?.retried).toBe(true);

    // Closure first, then the retry confirmation.
    expect(sent).toHaveLength(2);
    expect(sent[0]?.text).toContain('✅');
    expect(sent[0]?.text).toContain('Retry the quote');
    expect(sent[1]?.text).toContain('Retrying the quote for Marie');

    // The side effect actually ran.
    expect(await db.select().from(quotes)).toHaveLength(2);
    const msgs = await db.select().from(agentMessages);
    expect(msgs.some((m) => m.intent === 'QUOTE.REQUESTED')).toBe(true);
  });
});
