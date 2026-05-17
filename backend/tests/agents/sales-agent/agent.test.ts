/**
 * Sales Agent conversation-loop tests (M6.T3).
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY. No Redis needed and no
 * ANTHROPIC_API_KEY needed — we exercise `SalesAgent.onMessage` directly
 * (it's `protected`, so we expose a public seam via a test subclass) and
 * inject a stub Anthropic client via `__setClaudeClientForTests`.
 *
 * Spin up the same pg container the rest of the suite uses:
 *
 *   docker run -d --name f16-pg-m6t3 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker exec -i f16-pg-m6t3 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq, desc } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { conversationTurns, humanActions, leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { __resetForTests, shutdownQueues } from '../../../src/queue/index.js';
import { registerChannel, __resetChannelsForTests } from '../../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelId,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../../src/channels/types.js';
import { __setClaudeClientForTests } from '../../../src/llm/claude.js';
import { SalesAgent, cleanLLMReply } from '../../../src/agents/sales-agent/agent.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../../src/agents/types.js';

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
 * Stub WhatsApp channel that records every send and returns a deterministic
 * delivery receipt. Same pattern as M4.T7's `send.test.ts` stub.
 */
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
 * Test subclass that exposes the `protected onMessage` body as a public
 * `handle(...)` method. The Sales Agent never reaches a real BullMQ worker
 * in these tests — we exercise the LLM + channel-send loop directly.
 */
class TestableSalesAgent extends SalesAgent {
  public handle(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    // `onMessage` is protected; we're a subclass so we can access it directly.
    // Cast through `unknown` to widen the protected member to a callable shape
    // (TS rejects the direct intersection cast because of the protected modifier).
    return (
      this as unknown as {
        onMessage: (e: AgentMessageEnvelope) => Promise<MessageHandlerResult>;
      }
    ).onMessage(envelope);
  }
}

/**
 * Minimal stub Anthropic — records every request, returns a canned text.
 *
 * M6.T4 wired the Compliance Sentry into the customer-message path. The
 * sentry calls Haiku and expects JSON `{verdict, reasons}`. To keep the
 * pre-sentry tests focused on the Sales LLM path, the stub dispatches on
 * model: Haiku always returns `{verdict:"pass",reasons:[]}` so the draft
 * passes through; Sonnet returns the configured `nextText`.
 *
 * `calls` (and `lastCall`) only includes Sonnet calls — Haiku/sentry calls
 * are tracked separately as `sentryCalls`. This preserves the original
 * test assertions (`claudeStub.calls.length` counts Sales LLM calls only).
 */
/**
 * Sonnet response script entry. Either a text-only final turn, or a sequence
 * of tool_use blocks to drive the M6.T5 tool-loop one iteration.
 */
type SonnetScriptedTurn =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_use';
      uses: Array<{ id: string; name: string; input: unknown }>;
    };

class StubAnthropic {
  public calls: Array<{
    model: string;
    max_tokens: number;
    system?: unknown;
    messages: Array<{ role: string; content: unknown }>;
    tools?: unknown;
  }> = [];
  public sentryCalls: Array<{ model: string }> = [];
  public nextText = 'OK';
  /** When set, the sentry stub will return this JSON instead of pass. */
  public nextSentryText: string | null = null;
  /**
   * Optional scripted sequence for the Sonnet (sales) path. When set, each
   * Sonnet `messages.create` pops one entry; once empty we fall back to a
   * single `nextText` response. Lets the M6.T5 round-trip test queue a
   * tool_use turn followed by a text turn.
   */
  public sonnetScript: SonnetScriptedTurn[] = [];
  public messages = {
    create: async (req: {
      model: string;
      max_tokens: number;
      system?: unknown;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown;
    }) => {
      // Haiku tier = sentry. Default to pass so existing tests are unaffected.
      if (req.model.includes('haiku')) {
        this.sentryCalls.push({ model: req.model });
        const text = this.nextSentryText ?? '{"verdict":"pass","reasons":[]}';
        return {
          content: [{ type: 'text' as const, text }],
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 50, output_tokens: 15 },
        };
      }
      // Snapshot the request — the tool-loop mutates the messages array between
      // iterations (pushes assistant + tool_result turns onto the same array
      // it passed us), so a shallow reference would alias every call to the
      // final state. structuredClone gives each recorded call its own copy.
      this.calls.push({
        model: req.model,
        max_tokens: req.max_tokens,
        system: req.system,
        messages: structuredClone(req.messages) as Array<{ role: string; content: unknown }>,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
      });
      const scripted = this.sonnetScript.shift();
      if (scripted) {
        if (scripted.kind === 'tool_use') {
          return {
            content: scripted.uses.map((u) => ({
              type: 'tool_use' as const,
              id: u.id,
              name: u.name,
              input: u.input,
            })),
            stop_reason: 'tool_use' as const,
            usage: { input_tokens: 100, output_tokens: 25 },
          };
        }
        return {
          content: [{ type: 'text' as const, text: scripted.text }],
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 100, output_tokens: 25 },
        };
      }
      return {
        content: [{ type: 'text' as const, text: this.nextText }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 100, output_tokens: 25 },
      };
    },
  };
  get lastCall(): {
    model: string;
    max_tokens: number;
    system?: unknown;
    messages: Array<{ role: string; content: unknown }>;
  } {
    const c = this.calls[this.calls.length - 1];
    if (!c) throw new Error('StubAnthropic: no call recorded');
    return c;
  }
}

function makeEnvelope(intent: string, payload: unknown): AgentMessageEnvelope {
  return {
    id: 'msg-test-1',
    intent,
    toRole: 'sales-agent',
    toInstance: 'lead-test',
    correlationId: null,
    payload,
    priority: 5,
    createdAt: new Date('2026-05-17T11:00:00.000Z'),
  };
}

d('SalesAgent.onMessage (live pg, stub channel, stub Claude)', () => {
  let db: Database;
  let wa: StubChannel;
  let claudeStub: StubAnthropic;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);

    __resetChannelsForTests();
    wa = new StubChannel('whatsapp');
    registerChannel(wa);

    claudeStub = new StubAnthropic();
    __setClaudeClientForTests(claudeStub);
  });

  afterEach(() => {
    __setClaudeClientForTests(null);
    __resetChannelsForTests();
  });

  /** Helper: seed a customer + lead, return their ids. */
  async function seedLead(
    opts: {
      fullName?: string;
      phone?: string | null;
      email?: string | null;
      civility?: string | null;
      vehicle?: Record<string, unknown> | null;
      productLine?: 'scooter' | 'car';
    } = {},
  ): Promise<{ customerId: string; leadId: string }> {
    const c = await insertCustomer(db, {
      fullName: opts.fullName ?? 'Marie Curie',
      phone: opts.phone === undefined ? '+33612345678' : opts.phone,
      email: opts.email ?? null,
      civility: opts.civility ?? null,
      vehicle: opts.vehicle ?? null,
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: c.id,
        source: 'website',
        productLine: opts.productLine ?? 'scooter',
        status: 'scored',
        score: 80,
      })
      .returning();
    return { customerId: c.id, leadId: lead!.id };
  }

  function newAgent(meta: Record<string, unknown> = {}): TestableSalesAgent {
    return new TestableSalesAgent({
      role: 'sales-agent',
      instanceId: 'lead-test',
      model: 'sonnet',
      queues: ['lead', 'customer'],
      db,
      meta,
    });
  }

  // -------------------------------------------------------------------------
  // 1. LEAD.SCORED first-turn welcome — uses opener verbatim, no Claude call
  // -------------------------------------------------------------------------
  it('test 1 (LEAD.SCORED): sends the opener verbatim, no Claude call', async () => {
    const { leadId, customerId } = await seedLead({ fullName: 'Marie' });
    const agent = newAgent({ leadId });

    // Multi-queue subscription assertion: the Sales Agent listens on BOTH the
    // lead queue (LEAD.SCORED) and the customer queue (CUSTOMER.MESSAGE_RECEIVED).
    expect([...agent.queues].sort()).toEqual(['customer', 'lead']);

    const result = await agent.handle(
      makeEnvelope('LEAD.SCORED', {
        leadId,
        score: 80,
        opening: 'Bonjour Marie, c’est Assuryal — vous m’entendez ?',
        channel: 'whatsapp',
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      result: { sent: true, channel: 'whatsapp' },
    });
    // Channel saw the exact text.
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([
      { type: 'text', text: 'Bonjour Marie, c’est Assuryal — vous m’entendez ?' },
    ]);
    expect(wa.sends[0]!.agentRole).toBe('sales-agent');
    expect(wa.sends[0]!.agentInstance).toBe('lead-test');
    // conversation_turns row exists with direction=outbound.
    const turns = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, customerId));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.direction).toBe('outbound');
    expect(turns[0]!.content).toBe('Bonjour Marie, c’est Assuryal — vous m’entendez ?');
    // No Claude call.
    expect(claudeStub.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. LEAD.SCORED idempotency — already welcomed
  // -------------------------------------------------------------------------
  it('test 2 (LEAD.SCORED idempotency): skips when an outbound turn already exists', async () => {
    const { leadId, customerId } = await seedLead();
    // Pre-seed an outbound turn for this lead so the agent sees prior history.
    await db.insert(conversationTurns).values({
      customerId,
      leadId,
      channel: 'whatsapp',
      direction: 'outbound',
      content: 'Bonjour (déjà envoyé)',
    });
    const agent = newAgent({ leadId });

    const result = await agent.handle(
      makeEnvelope('LEAD.SCORED', {
        leadId,
        score: 80,
        opening: 'should not be sent',
        channel: 'whatsapp',
      }),
    );

    expect(result).toEqual({ ok: true, result: { skipped: 'already-welcomed' } });
    expect(wa.sends).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. LEAD.SCORED no contact address — customer.phone is null
  // -------------------------------------------------------------------------
  it('test 3 (LEAD.SCORED no contact): customer phone null -> skipped, no send', async () => {
    const { leadId } = await seedLead({ phone: null });
    const agent = newAgent({ leadId });

    const result = await agent.handle(
      makeEnvelope('LEAD.SCORED', {
        leadId,
        score: 80,
        opening: 'hello',
        channel: 'whatsapp',
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      result: { skipped: 'no-contact-address', channel: 'whatsapp' },
    });
    expect(wa.sends).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. CUSTOMER.MESSAGE_RECEIVED happy path
  // -------------------------------------------------------------------------
  it('test 4 (CUSTOMER.MESSAGE_RECEIVED): builds context, calls Claude (sonnet), sends reply', async () => {
    const { leadId, customerId } = await seedLead({ fullName: 'Marie' });
    // Two prior turns of history.
    await db.insert(conversationTurns).values([
      {
        customerId,
        leadId,
        channel: 'whatsapp',
        direction: 'outbound',
        content: 'Bonjour Marie, c’est Assuryal — vous m’entendez ?',
        occurredAt: new Date('2026-05-17T10:00:00.000Z'),
      },
      {
        customerId,
        leadId,
        channel: 'whatsapp',
        direction: 'inbound',
        content: 'Oui bonjour',
        occurredAt: new Date('2026-05-17T10:01:00.000Z'),
      },
    ]);
    claudeStub.nextText =
      "Pour un prix juste, j'ai besoin de la marque et année de votre véhicule.";

    const agent = newAgent({ leadId });
    const result = await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: "C'est combien ?",
      }),
    );

    // Returned shape.
    expect(result).toMatchObject({
      ok: true,
      result: {
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        sent: true,
        channel: 'whatsapp',
        externalId: 'stub-whatsapp-1',
      },
    });
    expect((result as { ok: true; result: { length: number } }).result.length).toBeGreaterThan(0);

    // Channel send carries the LLM reply.
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([
      {
        type: 'text',
        text: "Pour un prix juste, j'ai besoin de la marque et année de votre véhicule.",
      },
    ]);

    // Claude was called exactly once with sonnet + max_tokens 400 + user
    // prompt = the customer's current message (NOT the prior turns).
    expect(claudeStub.calls).toHaveLength(1);
    const call = claudeStub.lastCall;
    expect(call.model).toMatch(/sonnet/);
    expect(call.max_tokens).toBe(400);
    expect(call.messages).toEqual([{ role: 'user', content: "C'est combien ?" }]);

    // New outbound conversation_turns row landed.
    const turns = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, customerId))
      .orderBy(desc(conversationTurns.occurredAt));
    expect(turns).toHaveLength(3); // 2 prior + 1 new outbound
    expect(turns[0]!.direction).toBe('outbound');
    expect(turns[0]!.content).toBe(
      "Pour un prix juste, j'ai besoin de la marque et année de votre véhicule.",
    );
  });

  // -------------------------------------------------------------------------
  // 5. LLM reply wrapped in quotes -> cleaned in the sent message
  // -------------------------------------------------------------------------
  it('test 5 (cleaning quotes): wrapping straight quotes stripped before send', async () => {
    const { leadId, customerId } = await seedLead();
    claudeStub.nextText = '"Bonjour, je peux vous aider ?"';

    const agent = newAgent({ leadId });
    const result = await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'hello',
      }),
    );
    expect(result.ok).toBe(true);
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: 'Bonjour, je peux vous aider ?' }]);
  });

  // -------------------------------------------------------------------------
  // 6. LLM reply wrapped in ``` fences -> cleaned
  // -------------------------------------------------------------------------
  it('test 6 (cleaning fences): ```...``` wrapper stripped before send', async () => {
    const { leadId, customerId } = await seedLead();
    claudeStub.nextText = '```\nBonjour, je peux vous aider ?\n```';

    const agent = newAgent({ leadId });
    await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'hello',
      }),
    );
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: 'Bonjour, je peux vous aider ?' }]);
  });

  // -------------------------------------------------------------------------
  // 7. LLM reply prefixed "Réponse :" -> stripped
  // -------------------------------------------------------------------------
  it('test 7 (cleaning prefix): "Réponse :" label stripped before send', async () => {
    const { leadId, customerId } = await seedLead();
    claudeStub.nextText = 'Réponse : Bonjour, je peux vous aider ?';

    const agent = newAgent({ leadId });
    await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'hello',
      }),
    );
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: 'Bonjour, je peux vous aider ?' }]);
  });

  // -------------------------------------------------------------------------
  // 8. LLM empty after cleaning -> {ok:false, error:'empty-llm-reply'}, no send
  // -------------------------------------------------------------------------
  it('test 8 (empty after cleaning): no send, ok:false with empty-llm-reply', async () => {
    const { leadId, customerId } = await seedLead();
    // After stripping fence + label this becomes "".
    claudeStub.nextText = '```\n   \n```';

    const agent = newAgent({ leadId });
    const result = await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'hi',
      }),
    );
    expect(result).toEqual({ ok: false, error: 'empty-llm-reply' });
    expect(wa.sends).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 9. LLM reply >1500 chars -> ok:false with reply-too-long, no send
  // -------------------------------------------------------------------------
  it('test 9 (too long): >1500 chars -> ok:false reply-too-long, no send', async () => {
    const { leadId, customerId } = await seedLead();
    claudeStub.nextText = 'A'.repeat(1600);

    const agent = newAgent({ leadId });
    const result = await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'hi',
      }),
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/reply-too-long/);
    expect(wa.sends).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 10. No leadId anywhere -> {ok:false, error:/leadId/}
  // -------------------------------------------------------------------------
  it('test 10 (no leadId): meta empty + no correlationId -> ok:false', async () => {
    const { customerId } = await seedLead();
    const agent = newAgent({}); // no leadId in meta
    const env = makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
      customerId,
      channel: 'whatsapp',
      content: 'hello',
    });
    // Strip correlationId too (envelope default is null already).
    const result = await agent.handle({ ...env, correlationId: null });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/leadId/i);
    expect(wa.sends).toHaveLength(0);
    expect(claudeStub.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 11. System prompt was built from real DB context
  // -------------------------------------------------------------------------
  it('test 11 (system prompt context): includes brand fragment + recent turns from DB', async () => {
    const { leadId, customerId } = await seedLead({
      fullName: 'Jean Dupont',
      civility: 'Monsieur',
      vehicle: { brand: 'Xiaomi', model: 'Pro 2' },
    });
    await db.insert(conversationTurns).values([
      {
        customerId,
        leadId,
        channel: 'whatsapp',
        direction: 'outbound',
        content: 'Bonjour Jean',
        occurredAt: new Date('2026-05-17T09:00:00.000Z'),
      },
      {
        customerId,
        leadId,
        channel: 'whatsapp',
        direction: 'inbound',
        content: 'Bonjour, oui ?',
        occurredAt: new Date('2026-05-17T09:01:00.000Z'),
      },
    ]);
    claudeStub.nextText = 'D’accord, voici les détails.';

    const agent = newAgent({ leadId });
    await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'Vous avez quoi pour moi ?',
      }),
    );

    const call = claudeStub.lastCall;
    // system is an array of TextBlockParam-like blocks.
    expect(Array.isArray(call.system)).toBe(true);
    const blocks = call.system as Array<{ type: string; text: string }>;
    const fullText = blocks.map((b) => b.text).join('\n---\n');
    // Brand fragment marker (the cached Assuryal voice text).
    expect(fullText.toLowerCase()).toContain('assuryal');
    // Customer state inserted into the per-turn fragment.
    expect(fullText).toContain('Jean Dupont');
    expect(fullText).toContain('Monsieur');
    // Recent turns rendered with our [CLIENT] / [ASSURYAL] tags.
    expect(fullText).toContain('[ASSURYAL]');
    expect(fullText).toContain('Bonjour Jean');
    expect(fullText).toContain('[CLIENT]');
    expect(fullText).toContain('Bonjour, oui ?');
    // Channel hint.
    expect(fullText).toContain('whatsapp');
  });

  // -------------------------------------------------------------------------
  // 12. Unhandled intent -> {skipped:'unhandled-intent'}
  // -------------------------------------------------------------------------
  it('test 12 (unhandled intent): returns skipped, no send, no Claude call', async () => {
    const { leadId } = await seedLead();
    const agent = newAgent({ leadId });
    const result = await agent.handle(makeEnvelope('QUOTE.READY', { quoteId: 'x' }));
    expect(result).toMatchObject({
      ok: true,
      result: { skipped: 'unhandled-intent', intent: 'QUOTE.READY' },
    });
    expect(wa.sends).toHaveLength(0);
    expect(claudeStub.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 13. M6.T5 — Sales Agent tool round-trip via `human.escalate`
  //
  // Stub scripts Sonnet to (a) request a `human_escalate` tool call, then
  // (b) return text once it sees the tool_result. Asserts the tool actually
  // ran (a `human_actions` row was inserted) AND the final text was sent on
  // the channel.
  //
  // Gated on TEST_REDIS_URL because `human.escalate` dispatches a
  // HUMAN_ACTION.REQUESTED agent_message via BullMQ — the rest of the file
  // is pg-only.
  // -------------------------------------------------------------------------
  it.skipIf(!process.env.TEST_REDIS_URL)(
    'test 13 (tool round-trip): human.escalate invoked mid-turn -> row created + final text sent',
    async () => {
      const prevRedisUrl = process.env.REDIS_URL;
      const prevPrefix = process.env.BULLMQ_PREFIX;
      process.env.REDIS_URL = process.env.TEST_REDIS_URL!;
      process.env.BULLMQ_PREFIX = `f16-test-toolloop-${randomBytes(4).toString('hex')}`;
      __resetForTests();
      try {
        const { leadId, customerId } = await seedLead({ fullName: 'Léa' });

        // Script Sonnet: first turn = tool_use(human_escalate), second = text.
        claudeStub.sonnetScript = [
          {
            kind: 'tool_use',
            uses: [
              {
                id: 'toolu_esc_1',
                name: 'human_escalate',
                input: {
                  intent: 'TEST_ESCALATE',
                  severity: 1,
                  summary: 'Client urgent, besoin humain',
                },
              },
            ],
          },
          {
            kind: 'text',
            text: 'Un conseiller va vous rappeler très vite.',
          },
        ];

        const agent = newAgent({ leadId });
        const result = await agent.handle(
          makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
            customerId,
            channel: 'whatsapp',
            content: "C'est urgent, j'ai besoin d'aide.",
          }),
        );

        expect(result).toMatchObject({
          ok: true,
          result: { sent: true, channel: 'whatsapp' },
        });

        // Sonnet was called twice — once to get the tool_use, once for text.
        expect(claudeStub.calls.length).toBe(2);
        // Second Sonnet call carries a tool_result for the escalation.
        const secondCall = claudeStub.calls[1]!;
        const secondMsgs = secondCall.messages;
        const lastMsg = secondMsgs[secondMsgs.length - 1]!;
        expect(lastMsg.role).toBe('user');
        const content = lastMsg.content as Array<{ type: string; tool_use_id: string }>;
        expect(content[0]!.type).toBe('tool_result');
        expect(content[0]!.tool_use_id).toBe('toolu_esc_1');

        // human.escalate handler actually ran -> row landed in human_actions.
        const actions = await db
          .select()
          .from(humanActions)
          .where(eq(humanActions.intent, 'TEST_ESCALATE'));
        expect(actions).toHaveLength(1);
        expect(actions[0]!.severity).toBe(1);
        expect(actions[0]!.summary).toMatch(/urgent/);

        // Final text reached the channel.
        expect(wa.sends).toHaveLength(1);
        expect(wa.sends[0]!.body).toEqual([
          { type: 'text', text: 'Un conseiller va vous rappeler très vite.' },
        ]);
      } finally {
        await shutdownQueues().catch(() => {});
        __resetForTests();
        if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = prevRedisUrl;
        if (prevPrefix === undefined) delete process.env.BULLMQ_PREFIX;
        else process.env.BULLMQ_PREFIX = prevPrefix;
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 13. cleanLLMReply — pure unit tests (don't need TEST_DATABASE_URL)
// ---------------------------------------------------------------------------
describe('cleanLLMReply()', () => {
  it('trims whitespace on a clean reply', () => {
    expect(cleanLLMReply('  Bonjour  ')).toBe('Bonjour');
  });
  it('strips ```...``` fences with language tag', () => {
    expect(cleanLLMReply('```text\nBonjour\n```')).toBe('Bonjour');
  });
  it('strips ```...``` fences without language tag', () => {
    expect(cleanLLMReply('```\nBonjour\n```')).toBe('Bonjour');
  });
  it('strips "Réponse :" prefix (with accent)', () => {
    expect(cleanLLMReply('Réponse : Bonjour')).toBe('Bonjour');
  });
  it('strips "Reponse :" prefix (no accent, lowercase r)', () => {
    expect(cleanLLMReply('reponse : Bonjour')).toBe('Bonjour');
  });
  it('strips "Voici :" prefix', () => {
    expect(cleanLLMReply('Voici : Bonjour')).toBe('Bonjour');
  });
  it('strips wrapping straight quotes', () => {
    expect(cleanLLMReply('"Bonjour"')).toBe('Bonjour');
  });
  it('strips wrapping French guillemets', () => {
    expect(cleanLLMReply('«Bonjour»')).toBe('Bonjour');
  });
  it('is a no-op on a clean reply', () => {
    expect(cleanLLMReply('Bonjour Marie, comment puis-je vous aider ?')).toBe(
      'Bonjour Marie, comment puis-je vous aider ?',
    );
  });
  it('does not strip mismatched quotes (open without close)', () => {
    expect(cleanLLMReply('"Bonjour')).toBe('"Bonjour');
  });
});
