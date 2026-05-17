/**
 * Sales Agent × memory recall — integration tests (M6.T6).
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY. Both Claude AND the
 * embeddings client are stubbed so no external calls happen.
 *
 * What we assert:
 *   - When a customer has prior facts AND embeddings work, the system
 *     prompt the Sales LLM sees contains a "Faits mémorisés" section.
 *   - When the embedding call fails (stub throws), the Sales Agent STILL
 *     replies — recall is best-effort, not blocking.
 *   - When Sonnet emits a `customer_remember_fact` tool_use mid-turn, a row
 *     lands in `customer_facts` and the final text is sent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { customerFacts, leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { registerChannel, __resetChannelsForTests } from '../../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelId,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../../src/channels/types.js';
import { __setClaudeClientForTests } from '../../../src/llm/claude.js';
import { EmbeddingClient, __setEmbeddingClientForTests } from '../../../src/llm/embeddings.js';
import { recordCustomerFact } from '../../../src/memory/index.js';
import { SalesAgent } from '../../../src/agents/sales-agent/agent.js';
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

class TestableSalesAgent extends SalesAgent {
  public handle(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    return (
      this as unknown as {
        onMessage: (e: AgentMessageEnvelope) => Promise<MessageHandlerResult>;
      }
    ).onMessage(envelope);
  }
}

type SonnetScriptedTurn =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_use';
      uses: Array<{ id: string; name: string; input: unknown }>;
    };

class StubAnthropic {
  public sonnetCalls: Array<{
    model: string;
    system?: unknown;
    messages: Array<{ role: string; content: unknown }>;
    tools?: unknown;
  }> = [];
  public sentryCalls = 0;
  public nextText = 'OK';
  public sonnetScript: SonnetScriptedTurn[] = [];
  public messages = {
    create: async (req: {
      model: string;
      max_tokens: number;
      system?: unknown;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown;
    }) => {
      if (req.model.includes('haiku')) {
        this.sentryCalls += 1;
        return {
          content: [{ type: 'text' as const, text: '{"verdict":"pass","reasons":[]}' }],
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 50, output_tokens: 15 },
        };
      }
      this.sonnetCalls.push({
        model: req.model,
        system: req.system,
        messages: structuredClone(req.messages),
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
}

/** Deterministic embedding stub — identical to memory/recall.test.ts. */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    for (let k = 0; k < 16; k++) {
      const idx = ((h + k * 2654435761) >>> 0) % 1536;
      const sign = ((h >>> (k % 16)) & 1) === 0 ? 1 : -1;
      v[idx] = (v[idx] ?? 0) + sign * (0.5 + ((h >>> (k % 8)) & 0xff) / 512);
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

class StubEmbeddingClient extends EmbeddingClient {
  public failAlways = false;
  constructor() {
    super({ apiKey: 'stub', fetchImpl: (async () => ({}) as Response) as typeof fetch });
  }
  override async embed(text: string): Promise<number[]> {
    if (this.failAlways) throw new Error('embeddings down');
    return hashEmbed(text);
  }
  override async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.failAlways) throw new Error('embeddings down');
    return texts.map((t) => hashEmbed(t));
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

d('SalesAgent × memory recall (live pg, stub channel, stub Claude, stub embeddings)', () => {
  let db: Database;
  let wa: StubChannel;
  let claudeStub: StubAnthropic;
  let embedStub: StubEmbeddingClient;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    __resetChannelsForTests();
    wa = new StubChannel('whatsapp');
    registerChannel(wa);
    claudeStub = new StubAnthropic();
    __setClaudeClientForTests(claudeStub);
    embedStub = new StubEmbeddingClient();
    __setEmbeddingClientForTests(embedStub);
  });

  afterEach(() => {
    __setClaudeClientForTests(null);
    __setEmbeddingClientForTests(null);
    __resetChannelsForTests();
  });

  async function seedLead(): Promise<{ customerId: string; leadId: string }> {
    const c = await insertCustomer(db, { fullName: 'Marie', phone: '+33611111111' });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: c.id,
        source: 'website',
        productLine: 'car',
        status: 'scored',
        score: 80,
      })
      .returning();
    return { customerId: c.id, leadId: lead!.id };
  }

  function newAgent(meta: Record<string, unknown>): TestableSalesAgent {
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
  // 1. Recalled facts land in the system prompt.
  // -------------------------------------------------------------------------
  it('test 1: pre-recorded facts appear in the LLM system prompt', async () => {
    const { customerId, leadId } = await seedLead();
    // Two facts pre-recorded so they're available for recall.
    await recordCustomerFact(db, {
      customerId,
      factType: 'preference',
      content: 'préfère WhatsApp comme canal',
      confidence: 0.8,
    });
    await recordCustomerFact(db, {
      customerId,
      factType: 'objection',
      content: 'a refusé une offre auto en septembre',
      confidence: 0.7,
    });

    claudeStub.nextText = 'Bonjour, comment puis-je vous aider ?';
    const agent = newAgent({ leadId });
    // Query is intentionally near-identical to the first fact so the stub
    // hash produces a cosine distance well below the agent's 0.6 ceiling.
    const result = await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'préfère WhatsApp comme canal',
      }),
    );
    expect(result.ok).toBe(true);

    expect(claudeStub.sonnetCalls.length).toBe(1);
    const sys = claudeStub.sonnetCalls[0]!.system as Array<{ text: string }>;
    const fullText = sys.map((b) => b.text).join('\n---\n');
    // The per-turn fragment renders facts under this heading.
    expect(fullText).toContain('Faits mémorisés');
    // The WhatsApp-preference fact is identical to the query — must surface.
    expect(fullText).toContain('préfère WhatsApp');
  });

  // -------------------------------------------------------------------------
  // 2. Embedding failure during recall is non-fatal.
  // -------------------------------------------------------------------------
  it('test 2: when embeddings fail, Sales Agent still replies (no recalled facts)', async () => {
    const { customerId, leadId } = await seedLead();
    embedStub.failAlways = true;

    claudeStub.nextText = 'Bonjour, je peux vous aider.';
    const agent = newAgent({ leadId });
    const result = await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'hello',
      }),
    );
    expect(result.ok).toBe(true);
    // Reply was sent.
    expect(wa.sends).toHaveLength(1);
    // The "Faits mémorisés" section should NOT appear when recall failed.
    const sys = claudeStub.sonnetCalls[0]!.system as Array<{ text: string }>;
    const fullText = sys.map((b) => b.text).join('\n---\n');
    expect(fullText).not.toContain('Faits mémorisés');
  });

  // -------------------------------------------------------------------------
  // 3. customer.remember_fact tool round-trip — row created, final text sent.
  // -------------------------------------------------------------------------
  it('test 3: customer_remember_fact tool call inserts a customer_facts row and final text is sent', async () => {
    const { customerId, leadId } = await seedLead();

    claudeStub.sonnetScript = [
      {
        kind: 'tool_use',
        uses: [
          {
            id: 'toolu_remember_1',
            name: 'customer_remember_fact',
            input: {
              customerId,
              factType: 'preference',
              content: 'préfère WhatsApp',
              confidence: 0.85,
            },
          },
        ],
      },
      { kind: 'text', text: 'Noté, je vous écris sur WhatsApp.' },
    ];

    const agent = newAgent({ leadId });
    const result = await agent.handle(
      makeEnvelope('CUSTOMER.MESSAGE_RECEIVED', {
        customerId,
        channel: 'whatsapp',
        content: 'WhatsApp marche bien pour moi.',
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      result: { sent: true, channel: 'whatsapp' },
    });

    // Two Sonnet calls — one for tool_use, one for the final text.
    expect(claudeStub.sonnetCalls.length).toBe(2);
    // Second call's last user message carries the matching tool_result.
    const secondMsgs = claudeStub.sonnetCalls[1]!.messages;
    const lastMsg = secondMsgs[secondMsgs.length - 1]!;
    const content = lastMsg.content as Array<{ type: string; tool_use_id: string }>;
    expect(content[0]!.type).toBe('tool_result');
    expect(content[0]!.tool_use_id).toBe('toolu_remember_1');

    // customer_facts row landed via the tool handler.
    const rows = await db
      .select()
      .from(customerFacts)
      .where(eq(customerFacts.customerId, customerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.factType).toBe('preference');
    expect(rows[0]!.content).toBe('préfère WhatsApp');
    expect(rows[0]!.confidence).toBeCloseTo(0.85, 5);
    expect(rows[0]!.recordedBy).toBe('sales-agent#lead-test');

    // Final text reached the channel.
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([
      { type: 'text', text: 'Noté, je vous écris sur WhatsApp.' },
    ]);
  });
});
