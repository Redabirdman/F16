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
import { agentMessages, conversationTurns, leads, quotes } from '../../../src/db/schema/index.js';
import type { HumanAction } from '../../../src/db/schema/agent-runtime.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { createAction } from '../../../src/db/repositories/human-actions.js';
import { insertTurn } from '../../../src/db/repositories/conversation-turns.js';
import { physicalQueueName } from '../../../src/messaging/dispatcher.js';
import { getQueue, shutdownQueues, __resetForTests } from '../../../src/queue/index.js';
import {
  executeResolutionChoice,
  hasChoiceExecutor,
} from '../../../src/agents/reporter-agent/choice-executors.js';
import { HUMAN_ACTION_DRAFT_MARKER } from '../../../src/agents/reporter-agent/humanize.js';
import { registerChannel, __resetChannelsForTests } from '../../../src/channels/registry.js';
import type { DeliveryReceipt, SendOptions } from '../../../src/channels/types.js';
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
    // send_as_is tests register a fake whatsapp adapter — other suites (and
    // the quote-retry tests) rely on an EMPTY registry.
    __resetChannelsForTests();
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

  it('registers the V1 executors', () => {
    expect(hasChoiceExecutor('QUOTE_FAILED', 'retry')).toBe(true);
    expect(hasChoiceExecutor('QUOTE_STUCK', 'retry')).toBe(true);
    expect(hasChoiceExecutor('COMPLIANCE_BLOCKED', 'send_as_is')).toBe(true);
    expect(hasChoiceExecutor('VOICE_CALL_FAILED', 'retry')).toBe(true);
    // reject = do nothing; revise = future work — no executors on purpose.
    expect(hasChoiceExecutor('COMPLIANCE_BLOCKED', 'reject_send')).toBe(false);
    expect(hasChoiceExecutor('COMPLIANCE_BLOCKED', 'revise')).toBe(false);
    expect(hasChoiceExecutor('QUOTE_FAILED', 'manual')).toBe(false);
    expect(hasChoiceExecutor('SUBSCRIPTION_FAILED', 'retry')).toBe(false);
    expect(hasChoiceExecutor('VOICE_CALL_FAILED', 'ignore')).toBe(false);
  });

  it('VOICE_CALL_FAILED:retry re-emits VOICE.CALL_SCHEDULED with the profile phone', async () => {
    const cust = await insertCustomer(db, {
      fullName: 'Paul Rappel',
      phone: '+33757000000',
      email: null,
    });
    const action = await createAction(db, {
      createdByAgent: 'voice-operator#singleton',
      correlationId: cust.id,
      intent: 'VOICE_CALL_FAILED',
      severity: 2,
      summary: 'Outbound call to Paul Rappel could not be placed — the dial was rejected.',
      options: [
        { id: 'retry', label: 'Retry the call', kind: 'approve' },
        { id: 'ignore', label: 'Ignore', kind: 'reject' },
      ],
    });

    const result = await executeResolutionChoice(execCtx(action));

    expect(result).not.toBeNull();
    expect(result?.detail).toMatchObject({ retried: true });
    expect(result?.groupNote).toContain('Retrying the call to Paul');

    const msgs = await db.select().from(agentMessages);
    const scheduled = msgs.find((m) => m.intent === 'VOICE.CALL_SCHEDULED');
    expect(scheduled).toBeDefined();
    expect(scheduled?.toRole).toBe('voice-operator');
    const payload = scheduled?.payload as { customerId: string; toNumber: string; callId: string };
    expect(payload.customerId).toBe(cust.id);
    expect(payload.toNumber).toBe('+33757000000');
    expect(payload.callId).toBe(result?.detail?.callId);
  });

  it('VOICE_CALL_FAILED:retry degrades gracefully when the customer has no phone', async () => {
    const cust = await insertCustomer(db, {
      fullName: 'Sans Telephone',
      phone: null,
      email: 'sans.tel@example.com',
    });
    const action = await createAction(db, {
      createdByAgent: 'voice-operator#singleton',
      correlationId: cust.id,
      intent: 'VOICE_CALL_FAILED',
      severity: 2,
      summary: 'Outbound call to Sans Telephone could not be placed.',
      options: [{ id: 'retry', label: 'Retry the call', kind: 'approve' }],
    });

    const result = await executeResolutionChoice(execCtx(action));

    expect(result?.detail).toMatchObject({ retried: false, reason: 'no_phone_on_file' });
    const msgs = await db.select().from(agentMessages);
    expect(msgs.find((m) => m.intent === 'VOICE.CALL_SCHEDULED')).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // COMPLIANCE_BLOCKED:send_as_is — "Send it anyway" actually sends the draft
  // (2026-07-06 live test: Achraf approved blocked drafts and NOTHING went out)
  // -------------------------------------------------------------------------

  const BLOCKED_DRAFT =
    'Parfait Karim ! Vos deux devis ont bien été envoyés par email : ' +
    'DR0000984054 (sans options) et DR0000984055 (avec options). ' +
    "N'hésitez pas si vous avez la moindre question.";

  /** Seed customer + lead only (no quote) — send_as_is correlates by LEAD id. */
  async function seedLead(): Promise<{ leadId: string; customerId: string }> {
    const suffix = String(seedSeq++).padStart(2, '0');
    const cust = await insertCustomer(db, {
      fullName: 'Karim Testeur',
      phone: `+336333333${suffix}`,
      email: `karim.blocked.${suffix}@example.com`,
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
    return { leadId: lead!.id, customerId: cust.id };
  }

  /** human_actions row shaped like the COMPLIANCE_BLOCKED creation sites (reply-core.ts / agent.ts). */
  async function seedBlockedAction(leadId: string, draft: string | null) {
    return createAction(db, {
      createdByAgent: 'sales-agent#singleton',
      correlationId: leadId,
      intent: 'COMPLIANCE_BLOCKED',
      severity: 2,
      summary:
        'Sales Agent draft bloqué (LLM). Raisons : affirmation non validée' +
        (draft === null ? '' : `${HUMAN_ACTION_DRAFT_MARKER}${draft}`),
      options: [
        { id: 'send_as_is', label: 'Send it anyway', kind: 'approve' },
        { id: 'reject_send', label: 'Do not send', kind: 'reject' },
        { id: 'revise', label: 'Ask for a revision', kind: 'revise' },
      ],
    });
  }

  /** Register a fake whatsapp adapter capturing every send. */
  function registerFakeWhatsapp(): SendOptions[] {
    const sends: SendOptions[] = [];
    registerChannel({
      id: 'whatsapp',
      capabilities: () => ({
        interactive: false,
        voice: false,
        attachments: true,
        markdown: false,
      }),
      send: async (opts: SendOptions): Promise<DeliveryReceipt> => {
        sends.push(opts);
        return {
          channel: 'whatsapp',
          externalId: `wa-${sends.length}`,
          acceptedAt: new Date(),
        };
      },
    });
    return sends;
  }

  it('COMPLIANCE_BLOCKED:send_as_is sends the draft verbatim + logs the outbound turn', async () => {
    const sends = registerFakeWhatsapp();
    const { leadId, customerId } = await seedLead();
    const action = await seedBlockedAction(leadId, BLOCKED_DRAFT);

    const result = await executeResolutionChoice(execCtx(action, 'send_as_is'));

    expect(result).not.toBeNull();
    expect(result?.detail).toMatchObject({ sent: true, channel: 'whatsapp' });
    expect(result?.groupNote).toBe('Approved message sent to Karim.');

    // The channel adapter received the draft VERBATIM, addressed to the
    // customer's phone, attributed to the sales-agent.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toEqual([{ type: 'text', text: BLOCKED_DRAFT }]);
    expect(sends[0]?.to.channel).toBe('whatsapp');
    expect(sends[0]?.agentRole).toBe('sales-agent');
    expect(sends[0]?.correlationId).toBe(leadId);

    // sendViaChannel wrote the audit turn with the draft text.
    const turns = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, customerId));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.direction).toBe('outbound');
    expect(turns[0]?.content).toBe(BLOCKED_DRAFT);
    expect(turns[0]?.leadId).toBe(leadId);
    expect(turns[0]?.agentRole).toBe('sales-agent');
  });

  it('send_as_is degrades gracefully when the summary carries no draft', async () => {
    const sends = registerFakeWhatsapp();
    const { leadId } = await seedLead();
    const action = await seedBlockedAction(leadId, null);

    const result = await executeResolutionChoice(execCtx(action, 'send_as_is'));

    expect(result?.groupNote).toBe('No stored draft — nothing sent.');
    expect(result?.detail).toMatchObject({ sent: false, reason: 'no_stored_draft' });
    expect(sends).toHaveLength(0);
    expect(await db.select().from(conversationTurns)).toHaveLength(0);
  });

  it('send_as_is is idempotent — skips when a recent outbound turn already carries the draft', async () => {
    const sends = registerFakeWhatsapp();
    const { leadId, customerId } = await seedLead();
    const action = await seedBlockedAction(leadId, BLOCKED_DRAFT);

    // A prior delivery (e.g. a redelivered RESOLVED envelope already ran the
    // executor) — the draft text sits in a recent outbound turn.
    await insertTurn(db, {
      customerId,
      leadId,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      content: BLOCKED_DRAFT,
    });

    const result = await executeResolutionChoice(execCtx(action, 'send_as_is'));

    expect(result?.groupNote).toBe('Already sent.');
    expect(result?.detail).toMatchObject({ sent: false, reason: 'already_sent' });
    expect(sends).toHaveLength(0);
    // Still exactly the one pre-existing turn — no double text to the customer.
    expect(await db.select().from(conversationTurns)).toHaveLength(1);
  });

  it('send_as_is warns (not throws) when the customer cannot be resolved', async () => {
    registerFakeWhatsapp();
    // correlationId points at a lead that does not exist.
    const action = await seedBlockedAction(randomUUID(), BLOCKED_DRAFT);

    const result = await executeResolutionChoice(execCtx(action, 'send_as_is'));

    expect(result?.groupNote).toBe('Could not send the approved message — handle from the admin.');
    expect(result?.detail).toMatchObject({ sent: false, reason: 'lead_not_resolved' });
  });
});
