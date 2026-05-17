/**
 * Sales Agent multi-queue subscription tests.
 *
 * Locks the production routing gap M6.T3 surfaced: in production the Sales
 * Agent must consume LEAD.SCORED (routes to the 'lead' queue) AND
 * CUSTOMER.MESSAGE_RECEIVED (routes to the 'customer' queue). The M6.T3 suite
 * bypassed BullMQ entirely by calling `onMessage` through a test subclass —
 * green tests there did NOT prove the agent would receive customer replies.
 *
 * These tests exercise the full path: pg row + BullMQ enqueue + worker pickup.
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY (same gate
 * as the other M3+ integration tests).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { agentMessages, leads, conversationTurns } from '../../../src/db/schema/index.js';
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
import {
  spawn,
  killAll,
  getInstance,
  __resetAgentRegistryForTests,
} from '../../../src/agents/registry.js';
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
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate not true within ${timeoutMs}ms`);
}

/** Stub channel — records every send. Same shape as M6.T3 / M5.T4. */
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

/** Minimal stub Anthropic — records calls, returns a canned text. */
class StubAnthropic {
  public calls: unknown[] = [];
  public nextText = 'merci';
  public messages = {
    create: async (req: unknown) => {
      this.calls.push(req);
      return {
        content: [{ type: 'text' as const, text: this.nextText }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 50, output_tokens: 10 },
      };
    },
  };
}

d('SalesAgent multi-queue (live pg + redis)', () => {
  let db: Database;
  let prefix: string;
  let wa: StubChannel;
  let claudeStub: StubAnthropic;

  beforeEach(async () => {
    prefix = `f16-test-mq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

  /**
   * Test 1 — LEAD.SCORED routes via the 'lead' queue and lands on the agent.
   * Proves the agent's lead-queue worker is wired.
   */
  it('test 1 (lead queue): LEAD.SCORED is consumed by a spawned sales-agent', async () => {
    const customer = await insertCustomer(db, {
      fullName: 'Alice MQ',
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

    const agent = await spawn({
      role: 'sales-agent',
      instanceId,
      db,
      meta: { leadId },
    });
    // Sanity: multi-queue subscription wired.
    expect([...agent.queues].sort()).toEqual(['customer', 'lead']);

    const messageId = await sendMessage(
      { db },
      {
        fromRole: 'sales-spawn-orchestrator',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'LEAD.SCORED',
        payload: {
          leadId,
          score: 80,
          channel: 'whatsapp',
          opening: "Bonjour Alice, c'est Assuryal.",
        },
        correlationId: leadId,
      },
    );

    // The agent's 'lead' worker should pick up the row and execute the
    // first-turn welcome — sending the opener verbatim via the stub channel.
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
      return Boolean(row && row.result);
    }, 8000);

    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: "Bonjour Alice, c'est Assuryal." }]);
    expect(wa.sends[0]!.agentRole).toBe('sales-agent');
    expect(wa.sends[0]!.agentInstance).toBe(instanceId);
    // No Claude call — LEAD.SCORED uses the opener verbatim.
    expect(claudeStub.calls).toHaveLength(0);
  });

  /**
   * Test 2 — CUSTOMER.MESSAGE_RECEIVED routes via the 'customer' queue and
   * lands on the SAME agent instance. Proves the agent's customer-queue
   * worker is wired. In production, CUSTOMER.MESSAGE_RECEIVED never appears
   * on the 'lead' queue (dispatcher routes it to 'customer'); pre-fix, the
   * agent would not have a worker on 'customer' and the message would sit.
   */
  it('test 2 (customer queue): CUSTOMER.MESSAGE_RECEIVED is consumed by the same instance', async () => {
    const customer = await insertCustomer(db, {
      fullName: 'Alice MQ',
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

    // Seed an outbound turn so handleLeadScored idempotency doesn't matter —
    // we're only testing the customer-queue worker path here.
    await db.insert(conversationTurns).values({
      customerId: customer.id,
      leadId,
      channel: 'whatsapp',
      direction: 'outbound',
      content: "Bonjour Alice, c'est Assuryal.",
    });

    await spawn({ role: 'sales-agent', instanceId, db, meta: { leadId } });

    claudeStub.nextText = 'merci';

    const messageId = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId: customer.id,
          channel: 'whatsapp',
          content: 'bonjour',
          attachments: [],
          occurredAt: new Date('2026-05-17T12:00:00.000Z').toISOString(),
        },
        correlationId: leadId,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
      return Boolean(row && row.result);
    }, 8000);

    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: 'merci' }]);
    expect(claudeStub.calls).toHaveLength(1);
  });

  /**
   * Test 3 — One instance, BOTH messages. Confirms the same handler services
   * both queues, exactly once each (no double-processing, no drops). This is
   * the production scenario M6.T3's stub couldn't cover.
   */
  it('test 3 (same handler, both queues): one instance services lead + customer queues', async () => {
    const customer = await insertCustomer(db, {
      fullName: 'Alice MQ',
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

    await spawn({ role: 'sales-agent', instanceId, db, meta: { leadId } });

    claudeStub.nextText = 'merci';

    // Step 1: LEAD.SCORED -> 'lead' queue -> opener sent verbatim.
    const leadMsgId = await sendMessage(
      { db },
      {
        fromRole: 'sales-spawn-orchestrator',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'LEAD.SCORED',
        payload: {
          leadId,
          score: 80,
          channel: 'whatsapp',
          opening: "Bonjour Alice, c'est Assuryal.",
        },
        correlationId: leadId,
      },
    );
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, leadMsgId));
      return Boolean(row && row.result);
    }, 8000);

    // Step 2: CUSTOMER.MESSAGE_RECEIVED -> 'customer' queue -> LLM reply sent.
    const custMsgId = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId: customer.id,
          channel: 'whatsapp',
          content: 'bonjour',
          attachments: [],
          occurredAt: new Date('2026-05-17T12:00:00.000Z').toISOString(),
        },
        correlationId: leadId,
      },
    );
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, custMsgId));
      return Boolean(row && row.result);
    }, 8000);

    // Both rows consumed by the SAME instance, exactly once.
    const [leadRow] = await db.select().from(agentMessages).where(eq(agentMessages.id, leadMsgId));
    const [custRow] = await db.select().from(agentMessages).where(eq(agentMessages.id, custMsgId));
    expect(leadRow!.consumedBy).toBe('sales-agent');
    expect(custRow!.consumedBy).toBe('sales-agent');
    expect((leadRow!.result as Record<string, unknown>)['sent']).toBe(true);
    expect((custRow!.result as Record<string, unknown>)['sent']).toBe(true);

    // Channel saw exactly two outbound messages — the opener + the LLM reply.
    expect(wa.sends).toHaveLength(2);
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: "Bonjour Alice, c'est Assuryal." }]);
    expect(wa.sends[1]!.body).toEqual([{ type: 'text', text: 'merci' }]);

    // One Claude call (for the customer reply only). LEAD.SCORED doesn't call.
    expect(claudeStub.calls).toHaveLength(1);

    // The same registry instance handled both.
    const inst = getInstance('sales-agent', instanceId);
    expect(inst).toBeDefined();
    expect(inst!.isRunning()).toBe(true);
  });
});
