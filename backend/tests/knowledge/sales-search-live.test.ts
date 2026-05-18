/**
 * Sales Agent × real Assuryal knowledge base — LIVE end-to-end test (M7.T5).
 *
 * Gated on the full live stack: TEST_DATABASE_URL + TEST_REDIS_URL +
 * PII_ENCRYPTION_KEY + ANTHROPIC_API_KEY + OPENROUTER_API_KEY. Skips cleanly
 * (no failure) when any are missing — the gating predicate runs at
 * describe-time so unconfigured CI never hits these costs.
 *
 * What this proves end-to-end:
 *   1. Real OpenRouter embeddings ingest the Assuryal markdown corpus (~25
 *      chunks) into pg.
 *   2. The Sales Agent (real Claude Sonnet) handles a French customer message
 *      via the dispatcher → BullMQ → BaseAgent → onMessage flow.
 *   3. `knowledge.search` is now wired to real query embeddings, so when (and
 *      only when) Claude decides to invoke it, the kNN finds the
 *      trottinette-EDPM chunk and the agent's reply can ground in it.
 *
 * Cost envelope: one corpus-wide embedding pass (~25 chunks) +
 * one Sonnet turn (~1–3 tool calls + final text). At today's rates that's on
 * the order of $0.01-$0.03. Do NOT loop this test.
 *
 * Important: Claude is free to answer from training rather than calling
 * knowledge.search. We assert STRUCTURALLY (a reply landed on the channel
 * and the agent_messages row was consumed). The "25 km/h" content check is
 * a SOFT heuristic — Claude almost always mentions the speed limit since
 * it's basic French law, but the test does not strictly require it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import { sql, eq, and } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, customers, leads } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { ingestSource } from '../../src/knowledge/ingest.js';
import { markdownFileAdapter } from '../../src/knowledge/adapters/markdown-file.js';
import { registerChannel, __resetChannelsForTests } from '../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelId,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../src/channels/types.js';
import { sendMessage } from '../../src/messaging/dispatcher.js';
import { spawn, killAll, __resetAgentRegistryForTests } from '../../src/agents/registry.js';
import {
  registerSalesAgentClass,
  __resetSalesAgentRegistrationForTests,
} from '../../src/agents/sales-agent/index.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const REQUIRED = [
  'TEST_DATABASE_URL',
  'TEST_REDIS_URL',
  'PII_ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
const skip = REQUIRED.some((k) => !process.env[k]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Resolve the Assuryal MD file at the repo root (one level above backend/). */
const ASSURYAL_MD_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'ASSURYAL base connaissance agent.md',
);

let savedRedisUrl: string | undefined;
let savedPrefix: string | undefined;

beforeAll(() => {
  savedRedisUrl = process.env.REDIS_URL;
  savedPrefix = process.env.BULLMQ_PREFIX;
});

afterAll(() => {
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
  if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
  else process.env.BULLMQ_PREFIX = savedPrefix;
});

class StubChannel implements ConversationChannel {
  readonly id: ChannelId = 'whatsapp';
  readonly sent: SendOptions[] = [];
  private _seq = 0;
  capabilities(): ChannelCapabilities {
    return { interactive: false, voice: false, attachments: false, markdown: false };
  }
  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    this.sent.push(opts);
    this._seq += 1;
    return {
      channel: this.id,
      externalId: `stub-${this._seq}`,
      acceptedAt: new Date(),
    };
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms`);
}

describe.skipIf(skip)('M7.T5 — Sales Agent uses real knowledge base (LIVE)', () => {
  let db: Database;
  let prefix: string;
  let stubChannel: StubChannel;
  let orchestratorWorker: Worker | undefined;

  beforeEach(async () => {
    prefix = `f16-test-m7t5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = process.env['TEST_REDIS_URL']!;
    process.env.BULLMQ_PREFIX = prefix;

    __resetForTests();
    __resetAgentRegistryForTests();
    __resetSalesAgentRegistrationForTests();
    __resetChannelsForTests();

    db = createDb(process.env['TEST_DATABASE_URL']!);
    await db.execute(sql`
      TRUNCATE customer_facts, conversation_turns, agent_messages, human_actions,
        knowledge_chunks, maxance_actions, quotes, leads, customers,
        agents_state RESTART IDENTITY CASCADE
    `);

    stubChannel = new StubChannel();
    registerChannel(stubChannel);
    registerSalesAgentClass();
  });

  afterEach(async () => {
    try {
      await killAll(db);
    } catch {
      /* ignore */
    }
    if (orchestratorWorker) await orchestratorWorker.close().catch(() => {});
    orchestratorWorker = undefined;
    try {
      const cleaner = new Redis(process.env['TEST_REDIS_URL']!, {
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

  it('Sales Agent processes a knowledge-grounded customer message end-to-end', async () => {
    // ----------------------------------------------------------------------
    // 1. Ingest the real Assuryal MD with REAL OpenRouter embeddings.
    // ----------------------------------------------------------------------
    const ingest = await ingestSource(db, markdownFileAdapter, {
      name: 'assuryal_knowledge_md',
      path: ASSURYAL_MD_PATH,
    });
    expect(ingest.chunksFailed).toBe(0);
    expect(ingest.chunksProcessed).toBeGreaterThan(10);

    // ----------------------------------------------------------------------
    // 2. Seed a customer + lead in 'qualifying' status, then spawn the Sales
    //    Agent instance directly — bypass the LEAD.NEW → scorer → orchestrator
    //    chain so this test stays focused on the knowledge-search loop.
    // ----------------------------------------------------------------------
    const customer = await insertCustomer(db, {
      fullName: 'Marie Test',
      phone: '+33612345678',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'qualifying',
        score: 80,
      })
      .returning();
    const leadId = insertedLead!.id;
    const instanceId = `lead-${leadId}`;

    await spawn({
      role: 'sales-agent',
      instanceId,
      db,
      meta: { leadId },
    });

    // ----------------------------------------------------------------------
    // 3. Send the inbound customer message. Question is one whose answer
    //    lives in the Assuryal MD (EDPM speed limit). Real Sonnet will
    //    process it; whether it invokes knowledge.search is its own choice.
    // ----------------------------------------------------------------------
    const messageId = await sendMessage(
      { db },
      {
        fromRole: 'channel.whatsapp',
        toRole: 'sales-agent',
        toInstance: instanceId,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId: customer.id,
          channel: 'whatsapp',
          content:
            'Bonjour, quelle est la vitesse maximale légale autorisée pour une trottinette électrique en France ?',
          attachments: [],
          occurredAt: new Date().toISOString(),
        },
        correlationId: leadId,
        priority: 4,
      },
    );

    // ----------------------------------------------------------------------
    // 4. Wait for the agent to produce a channel send. 180s ceiling — real
    //    Sonnet + the compliance Haiku sentry + (potentially) a tool-use
    //    round-trip + the final text generation can stretch to 60–90s in
    //    practice; we leave generous headroom for cold-start network jitter.
    // ----------------------------------------------------------------------
    await waitFor(() => stubChannel.sent.length >= 1, {
      timeoutMs: 180_000,
      intervalMs: 500,
    });

    // Structural assertion #1 — a reply went out on the WhatsApp channel.
    expect(stubChannel.sent).toHaveLength(1);
    const sent = stubChannel.sent[0]!;
    expect(sent.to.address).toBe('+33612345678');
    expect(sent.body.length).toBeGreaterThan(0);
    const firstBlock = sent.body[0] as { type: string; text: string };
    expect(firstBlock.type).toBe('text');
    expect(firstBlock.text.length).toBeGreaterThan(0);

    // Structural assertion #2 — the inbound agent_message was consumed.
    await waitFor(
      async () => {
        const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
        return row?.consumedAt != null;
      },
      { timeoutMs: 5_000, intervalMs: 200 },
    );
    const [consumed] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
    expect(consumed!.consumedAt).not.toBeNull();
    const result = consumed!.result as Record<string, unknown>;
    expect(result['sent']).toBe(true);
    expect(result['channel']).toBe('whatsapp');

    // Soft heuristic — the canonical EDPM speed limit is 25 km/h, and the
    // chunk is in the corpus. Whether the LLM chose to RAG it or pulled the
    // fact from training, the answer almost always contains it. We log a
    // warning rather than failing if the phrasing differs wildly.
    if (!/25\s*km/i.test(firstBlock.text)) {
      console.warn(
        'M7.T5 live test: reply did not mention "25 km" — text was:\n' + firstBlock.text,
      );
    }

    // ----------------------------------------------------------------------
    // 5. Cleanup hand-off — the afterEach kills the instance + closes the
    //    workers. We just confirm the lead row is still consistent.
    // ----------------------------------------------------------------------
    const [postLead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.customerId, customer.id)));
    expect(postLead).toBeDefined();

    // Sanity: the customer row still decrypts. Don't log decrypted PII.
    const [postCustomer] = await db.select().from(customers).where(eq(customers.id, customer.id));
    expect(postCustomer).toBeDefined();
  }, 300_000);
});
