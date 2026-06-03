/**
 * Sales Agent reply-core tests (M10).
 *
 * Exercises `generateSalesReply` directly — the channel-agnostic brain shared
 * by the WhatsApp event path and the synchronous voice route. Asserts it
 * RETURNS the right discriminated-union outcome instead of sending.
 *
 * DB-gated (TEST_DATABASE_URL + PII_ENCRYPTION_KEY), no Redis required for the
 * reply / skip cases. The compliance-block case is gated additionally on
 * TEST_REDIS_URL because it emits a COMPLIANCE.BLOCKED agent_message via
 * BullMQ — same dependency the inline agent path had.
 *
 * LLM is stubbed via the same `__setClaudeClientForTests` seam agent.test.ts
 * uses: Haiku (sentry) → pass by default; Sonnet (sales) → `nextText`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { humanActions, leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { __resetForTests, shutdownQueues } from '../../../src/queue/index.js';
import { __setClaudeClientForTests } from '../../../src/llm/claude.js';
import { __setEmbeddingClientForTests, type EmbeddingClient } from '../../../src/llm/embeddings.js';
import { generateSalesReply } from '../../../src/agents/sales-agent/reply-core.js';

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
 * Minimal model-aware Claude stub: Haiku (sentry) returns a verdict JSON
 * (default pass); Sonnet (sales) returns `nextText`. Mirrors the stub in
 * agent.test.ts / compliance-integration.test.ts.
 */
class StubAnthropic {
  public sonnetCalls: Array<{ model: string }> = [];
  public sentryCalls: Array<{ model: string }> = [];
  public nextText = 'Bonjour, comment puis-je vous aider ?';
  public nextSentryText: string | null = null;
  public messages = {
    create: async (req: { model: string }) => {
      if (req.model.includes('haiku')) {
        this.sentryCalls.push({ model: req.model });
        const text = this.nextSentryText ?? '{"verdict":"pass","reasons":[]}';
        return {
          content: [{ type: 'text' as const, text }],
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 50, output_tokens: 15 },
        };
      }
      this.sonnetCalls.push({ model: req.model });
      return {
        content: [{ type: 'text' as const, text: this.nextText }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 100, output_tokens: 25 },
      };
    },
  };
}

/** Deterministic zero-vector embedding client (recall doesn't matter here). */
class StubEmbeddingClient implements Pick<EmbeddingClient, 'embed' | 'embedBatch'> {
  async embed(): Promise<number[]> {
    return new Array(1536).fill(0);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(1536).fill(0));
  }
}

d('generateSalesReply (live pg, stub Claude)', () => {
  let db: Database;
  let claudeStub: StubAnthropic;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);

    claudeStub = new StubAnthropic();
    __setClaudeClientForTests(claudeStub);
    __setEmbeddingClientForTests(new StubEmbeddingClient() as unknown as EmbeddingClient);
  });

  afterEach(() => {
    __setClaudeClientForTests(null);
    __setEmbeddingClientForTests(null);
  });

  async function seedLead(
    opts: { phone?: string | null; productLine?: 'scooter' | 'car' } = {},
  ): Promise<{ customerId: string; leadId: string }> {
    const c = await insertCustomer(db, {
      fullName: 'Marie Curie',
      phone: opts.phone === undefined ? '+33612345678' : opts.phone,
      email: null,
      civility: null,
      vehicle: null,
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: c.id,
        source: 'website',
        productLine: opts.productLine ?? 'scooter',
        status: 'qualifying',
        score: 80,
      })
      .returning();
    return { customerId: c.id, leadId: lead!.id };
  }

  // -------------------------------------------------------------------------
  // reply — clean Sonnet draft + sentry pass → outcome:'reply'
  // -------------------------------------------------------------------------
  it('returns outcome:reply with the cleaned draft (voice channel)', async () => {
    const { leadId, customerId } = await seedLead();
    claudeStub.nextText = "Pour un prix juste, j'ai besoin de la marque de votre trottinette.";

    const result = await generateSalesReply({
      db,
      leadId,
      channel: 'voice',
      content: "C'est combien ?",
      agentRole: 'sales-agent',
      agentInstance: 'voice-sess-1',
    });

    expect(result.outcome).toBe('reply');
    if (result.outcome !== 'reply') throw new Error('expected reply');
    expect(result.replyText).toBe(
      "Pour un prix juste, j'ai besoin de la marque de votre trottinette.",
    );
    expect(result.customerId).toBe(customerId);
    expect(result.leadId).toBe(leadId);
    // Sonnet called once; sentry (Haiku) called once.
    expect(claudeStub.sonnetCalls).toHaveLength(1);
    expect(claudeStub.sentryCalls.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // reply — LLM wrapping artifacts are cleaned before returning
  // -------------------------------------------------------------------------
  it('cleans wrapping quotes in the returned replyText', async () => {
    const { leadId } = await seedLead();
    claudeStub.nextText = '"Bonjour, je peux vous aider ?"';

    const result = await generateSalesReply({
      db,
      leadId,
      channel: 'voice',
      content: 'allô',
      agentRole: 'sales-agent',
      agentInstance: 'voice-sess-2',
    });

    expect(result).toMatchObject({ outcome: 'reply', replyText: 'Bonjour, je peux vous aider ?' });
  });

  // -------------------------------------------------------------------------
  // skip — empty inbound transcript → outcome:'skip'
  // -------------------------------------------------------------------------
  it('returns outcome:skip on empty inbound, with no LLM call', async () => {
    const { leadId } = await seedLead();
    const result = await generateSalesReply({
      db,
      leadId,
      channel: 'voice',
      content: '   ',
      agentRole: 'sales-agent',
      agentInstance: 'voice-sess-3',
    });
    expect(result).toEqual({ outcome: 'skip', reason: 'empty-inbound' });
    expect(claudeStub.sonnetCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // skip — no contact address (customer phone null) → outcome:'skip'
  // -------------------------------------------------------------------------
  it('returns outcome:skip when the customer has no address for the channel', async () => {
    const { leadId } = await seedLead({ phone: null });
    const result = await generateSalesReply({
      db,
      leadId,
      channel: 'voice',
      content: 'bonjour',
      agentRole: 'sales-agent',
      agentInstance: 'voice-sess-4',
    });
    expect(result).toEqual({ outcome: 'skip', reason: 'no-contact-address' });
    expect(claudeStub.sonnetCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // error — empty after cleaning → outcome:'error'
  // -------------------------------------------------------------------------
  it('returns outcome:error when the LLM reply is empty after cleaning', async () => {
    const { leadId } = await seedLead();
    claudeStub.nextText = '```\n   \n```';
    const result = await generateSalesReply({
      db,
      leadId,
      channel: 'voice',
      content: 'bonjour',
      agentRole: 'sales-agent',
      agentInstance: 'voice-sess-5',
    });
    expect(result).toEqual({ outcome: 'error', error: 'empty-llm-reply' });
  });

  // -------------------------------------------------------------------------
  // error — reply too long → outcome:'error'
  // -------------------------------------------------------------------------
  it('returns outcome:error when the LLM reply exceeds the char cap', async () => {
    const { leadId } = await seedLead();
    claudeStub.nextText = 'A'.repeat(1600);
    const result = await generateSalesReply({
      db,
      leadId,
      channel: 'voice',
      content: 'bonjour',
      agentRole: 'sales-agent',
      agentInstance: 'voice-sess-6',
    });
    expect(result.outcome).toBe('error');
    if (result.outcome !== 'error') throw new Error('expected error');
    expect(result.error).toMatch(/reply-too-long/);
  });

  // -------------------------------------------------------------------------
  // blocked — hard server-rule violation → outcome:'blocked' + human action
  //
  // Gated on TEST_REDIS_URL: the block path emits COMPLIANCE.BLOCKED via
  // sendMessage (BullMQ-enqueued), same as the inline agent path.
  // -------------------------------------------------------------------------
  it.skipIf(!process.env.TEST_REDIS_URL)(
    'returns outcome:blocked + creates a human action on a compliance block',
    async () => {
      const prevRedisUrl = process.env.REDIS_URL;
      const prevPrefix = process.env.BULLMQ_PREFIX;
      process.env.REDIS_URL = process.env.TEST_REDIS_URL!;
      process.env.BULLMQ_PREFIX = `f16-test-replycore-block-${randomBytes(4).toString('hex')}`;
      __resetForTests();
      try {
        const { leadId } = await seedLead();
        // Hard rule fast-path: matches `contract-already-bound`.
        claudeStub.nextText = 'Votre contrat est validé.';

        const result = await generateSalesReply({
          db,
          leadId,
          channel: 'voice',
          content: 'On en est où ?',
          agentRole: 'sales-agent',
          agentInstance: 'voice-sess-7',
        });

        expect(result.outcome).toBe('blocked');
        if (result.outcome !== 'blocked') throw new Error('expected blocked');
        expect(typeof result.humanActionId).toBe('string');
        expect(Array.isArray(result.reasons)).toBe(true);

        // human_actions row created with severity 2 + intent COMPLIANCE_BLOCKED.
        const actions = await db
          .select()
          .from(humanActions)
          .where(eq(humanActions.intent, 'COMPLIANCE_BLOCKED'));
        expect(actions).toHaveLength(1);
        expect(actions[0]!.severity).toBe(2);
        expect(actions[0]!.id).toBe(result.humanActionId);
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
