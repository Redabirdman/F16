/**
 * Sales Agent + Compliance Sentry integration tests (M6.T4).
 *
 * Exercises the full path: BullMQ enqueue → agent worker pickup → Sentry
 * (Haiku stub) → either send-via-channel OR block-and-escalate. Gated on
 * TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY (same gate as
 * the other M3+ integration tests).
 *
 * The Claude stub dispatches on model: Sonnet returns the Sales Agent's
 * draft (`nextSonnetText`); Haiku returns the canned sentry verdict
 * (`nextSentryText`, default = pass).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql, eq, and } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import {
  agentMessages,
  leads,
  conversationTurns,
  humanActions,
} from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { sendMessage } from '../../../src/messaging/dispatcher.js';
import { registerChannel, __resetChannelsForTests } from '../../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelId,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../../src/channels/types.js';
import { __setClaudeClientForTests } from '../../../src/llm/claude.js';
import {
  registerSalesAgentClass,
  __resetSalesAgentRegistrationForTests,
} from '../../../src/agents/sales-agent/index.js';
import { spawn, killAll, __resetAgentRegistryForTests } from '../../../src/agents/registry.js';
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

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate not true within ${timeoutMs}ms`);
}

class StubChannel implements ConversationChannel {
  readonly id: ChannelId;
  readonly sends: SendOptions[] = [];
  private _seq = 0;
  constructor(id: ChannelId) {
    this.id = id;
  }
  capabilities(): ChannelCapabilities {
    return { interactive: true, voice: false, attachments: true, markdown: true };
  }
  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    this.sends.push(opts);
    this._seq += 1;
    return {
      channel: this.id,
      externalId: `stub-${this.id}-${this._seq}`,
      acceptedAt: new Date('2026-05-17T12:00:00.000Z'),
      raw: { stub: true },
    };
  }
}

/**
 * Model-aware Claude stub. Sonnet returns the Sales draft; Haiku returns
 * the sentry verdict JSON. Two queues of canned outputs let one test send
 * a blocked draft then a clean one (test 4).
 */
class StubAnthropic {
  public sonnetCalls: Array<{ model: string }> = [];
  public haikuCalls: Array<{ model: string }> = [];
  /** Queue of texts the Sonnet (Sales LLM) stub returns. Single fallback when empty. */
  public sonnetTexts: string[] = [];
  public sonnetDefault = 'Bonjour, je peux vous aider.';
  /** Queue of texts the Haiku (Sentry) stub returns. Default pass when empty. */
  public sentryTexts: string[] = [];
  public sentryDefault = '{"verdict":"pass","reasons":[]}';
  public messages = {
    create: async (req: { model: string }) => {
      if (req.model.includes('haiku')) {
        this.haikuCalls.push({ model: req.model });
        const text = this.sentryTexts.length > 0 ? this.sentryTexts.shift()! : this.sentryDefault;
        return {
          content: [{ type: 'text' as const, text }],
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 50, output_tokens: 15 },
        };
      }
      this.sonnetCalls.push({ model: req.model });
      const text = this.sonnetTexts.length > 0 ? this.sonnetTexts.shift()! : this.sonnetDefault;
      return {
        content: [{ type: 'text' as const, text }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 100, output_tokens: 25 },
      };
    },
  };
}

d('Sales Agent + Compliance Sentry (live pg + redis)', () => {
  let db: Database;
  let prefix: string;
  let wa: StubChannel;
  let claudeStub: StubAnthropic;

  beforeEach(async () => {
    prefix = `f16-test-comp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();
    __resetAgentRegistryForTests();
    __resetSalesAgentRegistrationForTests();
    __resetChannelsForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agents_state`);

    wa = new StubChannel('whatsapp');
    registerChannel(wa);

    claudeStub = new StubAnthropic();
    __setClaudeClientForTests(claudeStub);

    registerSalesAgentClass();
  });

  afterEach(async () => {
    __setClaudeClientForTests(null);
    try {
      await killAll(db);
    } catch {
      /* ignore */
    }
    try {
      const cleaner = new Redis(redisUrl!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      const keys = await cleaner.keys(`${prefix}:*`);
      if (keys.length > 0) await cleaner.del(...keys);
      await cleaner.quit();
    } catch {
      /* ignore */
    }
    await shutdownQueues().catch(() => {});
    __resetForTests();
    __resetAgentRegistryForTests();
    __resetSalesAgentRegistrationForTests();
    __resetChannelsForTests();
  });

  /** Helper: seed customer + lead, return ids + instance. */
  async function seedAndSpawn(): Promise<{
    customerId: string;
    leadId: string;
    instanceId: string;
  }> {
    const customer = await insertCustomer(db, {
      fullName: 'Alice Compliance',
      phone: '+33611111111',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'scored',
        score: 80,
        scoredAt: new Date(),
      })
      .returning();
    const leadId = insertedLead!.id;
    const instanceId = `lead-${leadId}`;
    // Pre-seed an outbound turn so the lead-scored idempotency path doesn't
    // matter — we're focused on the customer-message + sentry path.
    await db.insert(conversationTurns).values({
      customerId: customer.id,
      leadId,
      channel: 'whatsapp',
      direction: 'outbound',
      content: "Bonjour Alice, c'est Assuryal.",
    });
    await spawn({ role: 'sales-agent', instanceId, db, meta: { leadId } });
    return { customerId: customer.id, leadId, instanceId };
  }

  // -------------------------------------------------------------------------
  // Test 1 — happy path: clean Sales draft + sentry pass → message sent
  // -------------------------------------------------------------------------
  it('test 1 (sentry PASS): clean draft → message sent via channel as before', async () => {
    const { customerId, leadId, instanceId } = await seedAndSpawn();
    claudeStub.sonnetTexts.push('Bonjour Alice, comment puis-je vous aider ?');
    // sentryTexts left empty → default pass.

    const msgId = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId,
          channel: 'whatsapp',
          content: 'bonjour',
          attachments: [],
          occurredAt: new Date('2026-05-17T12:00:00.000Z').toISOString(),
        },
        correlationId: leadId,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msgId));
      return Boolean(row && row.result);
    });

    // Sent through the channel with the Sales draft.
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([
      { type: 'text', text: 'Bonjour Alice, comment puis-je vous aider ?' },
    ]);
    // Both calls fired: Sales (Sonnet) + Sentry (Haiku).
    expect(claudeStub.sonnetCalls).toHaveLength(1);
    expect(claudeStub.haikuCalls).toHaveLength(1);

    // No human action created.
    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 2 — hard server rule: Sales draft is "Votre contrat est validé."
  //         → blocked WITHOUT a Haiku call, human action created, blocked emitted
  // -------------------------------------------------------------------------
  it('test 2 (hard server rule): blocked draft → no send, human_actions row, COMPLIANCE.BLOCKED emitted', async () => {
    const { customerId, leadId, instanceId } = await seedAndSpawn();
    // Hard rule fast-path: this matches `contract-already-bound`.
    claudeStub.sonnetTexts.push('Votre contrat est validé.');

    const msgId = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId,
          channel: 'whatsapp',
          content: 'On en est où ?',
          attachments: [],
          occurredAt: new Date('2026-05-17T12:00:00.000Z').toISOString(),
        },
        correlationId: leadId,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msgId));
      return Boolean(row && row.result);
    });

    // No message sent through the channel.
    expect(wa.sends).toHaveLength(0);
    // Sales LLM was called once; sentry Haiku was NOT (hard rule fast-path).
    expect(claudeStub.sonnetCalls).toHaveLength(1);
    expect(claudeStub.haikuCalls).toHaveLength(0);

    // Handler result shape.
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msgId));
    const result = row!.result as Record<string, unknown>;
    expect(result['sent']).toBe(false);
    expect(result['blocked']).toBe(true);
    expect(typeof result['humanActionId']).toBe('string');

    // human_actions row created with severity=2.
    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.severity).toBe(2);
    expect(actions[0]!.intent).toBe('COMPLIANCE_BLOCKED');
    expect(actions[0]!.correlationId).toBe(leadId);
    expect(actions[0]!.options).toHaveLength(3);

    // COMPLIANCE.BLOCKED row landed in agent_messages.
    const blocked = await db
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.intent, 'COMPLIANCE.BLOCKED'),
          eq(agentMessages.correlationId, leadId),
        ),
      );
    expect(blocked).toHaveLength(1);
    expect((blocked[0]!.payload as { messageId: string }).messageId).toBe(actions[0]!.id);
  });

  // -------------------------------------------------------------------------
  // Test 3 — server-clean draft + LLM sentry returns block
  // -------------------------------------------------------------------------
  it('test 3 (LLM block): clean server rules but sentry LLM blocks → escalated to human', async () => {
    const { customerId, leadId, instanceId } = await seedAndSpawn();
    // Draft is server-clean — sentry consults Haiku, which blocks.
    claudeStub.sonnetTexts.push('Aujourd’hui parlons plutôt météo.');
    claudeStub.sentryTexts.push('{"verdict":"block","reasons":["sort du périmètre"]}');

    const msgId = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId,
          channel: 'whatsapp',
          content: 'bonjour',
          attachments: [],
          occurredAt: new Date('2026-05-17T12:00:00.000Z').toISOString(),
        },
        correlationId: leadId,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msgId));
      return Boolean(row && row.result);
    });

    expect(wa.sends).toHaveLength(0);
    expect(claudeStub.sonnetCalls).toHaveLength(1);
    expect(claudeStub.haikuCalls).toHaveLength(1);

    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.severity).toBe(2);
    expect(actions[0]!.summary.toLowerCase()).toContain('sort du périmètre'.toLowerCase());

    const blocked = await db
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.intent, 'COMPLIANCE.BLOCKED'),
          eq(agentMessages.correlationId, leadId),
        ),
      );
    expect(blocked).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 4 — block then clean: blocked state doesn't linger
  // -------------------------------------------------------------------------
  it('test 4 (no lingering block): blocked draft then clean draft → clean one sends', async () => {
    const { customerId, leadId, instanceId } = await seedAndSpawn();
    // First Sales reply trips the hard rule; second is clean.
    claudeStub.sonnetTexts.push('Votre contrat est validé.');
    claudeStub.sonnetTexts.push('Bonjour, je peux vous aider ?');

    const msg1 = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId,
          channel: 'whatsapp',
          content: 'On en est où ?',
          attachments: [],
          occurredAt: new Date('2026-05-17T12:00:00.000Z').toISOString(),
        },
        correlationId: leadId,
      },
    );
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msg1));
      return Boolean(row && row.result);
    });
    expect(wa.sends).toHaveLength(0);

    // Second customer message — clean draft this time → should send.
    const msg2 = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId,
          channel: 'whatsapp',
          content: 'Et donc ?',
          attachments: [],
          occurredAt: new Date('2026-05-17T12:01:00.000Z').toISOString(),
        },
        correlationId: leadId,
      },
    );
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msg2));
      return Boolean(row && row.result);
    });

    // The clean second draft was sent.
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: 'Bonjour, je peux vous aider ?' }]);
    // Exactly one human_action from the first turn.
    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(1);
  });
});
