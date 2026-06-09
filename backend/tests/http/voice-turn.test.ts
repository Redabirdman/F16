/**
 * Voice turn HTTP transport tests (M10).
 *
 * Exercises `POST /v1/voice/turn` end-to-end through the Hono router: HMAC,
 * zod validation, and the outcome→response mapping (live / escalated). The
 * Sales brain runs for real against pg with a stubbed LLM (same seam as the
 * agent tests).
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY. The compliance→escalated
 * case is additionally gated on TEST_REDIS_URL because the block path emits a
 * COMPLIANCE.BLOCKED agent_message via BullMQ.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { leads } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';
import { __setClaudeClientForTests } from '../../src/llm/claude.js';
import { __setEmbeddingClientForTests, type EmbeddingClient } from '../../src/llm/embeddings.js';
import { buildVoiceRouter } from '../../src/http/voice.js';

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
 * Claude stub that distinguishes the Compliance Sentry from the sales DRAFT by
 * the SYSTEM PROMPT marker, not the model. On the VOICE path the sales draft
 * runs on Haiku AND the LLM sentry is skipped (rules-only), so bucketing by
 * `model.includes('haiku')` would misroute the single Haiku draft call to the
 * sentry branch and return the verdict JSON as the reply. The sentry is uniquely
 * identifiable by its system prompt ("Compliance Sentry").
 */
function systemText(req: { system?: unknown }): string {
  const sys = req.system;
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys
      .map((s) => (s && typeof s === 'object' && 'text' in s ? String(s.text) : ''))
      .join(' ');
  }
  return '';
}

class StubAnthropic {
  public nextText = 'Bonjour, je peux vous aider ?';
  public nextSentryText: string | null = null;
  public messages = {
    create: async (req: { model: string; system?: unknown }) => {
      if (systemText(req).includes('Compliance Sentry')) {
        const text = this.nextSentryText ?? '{"verdict":"pass","reasons":[]}';
        return {
          content: [{ type: 'text' as const, text }],
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 50, output_tokens: 15 },
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

class StubEmbeddingClient implements Pick<EmbeddingClient, 'embed' | 'embedBatch'> {
  async embed(): Promise<number[]> {
    return new Array(1536).fill(0);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(1536).fill(0));
  }
}

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

d('voice turn HTTP (live pg, stub Claude)', () => {
  let db: Database;
  let claudeStub: StubAnthropic;
  const SECRET = 'test-voice-secret';

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

  async function seedLead(): Promise<{ customerId: string; leadId: string }> {
    const c = await insertCustomer(db, {
      fullName: 'Marie Curie',
      phone: '+33612345678',
      email: null,
      civility: null,
      vehicle: null,
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: c.id,
        source: 'website',
        productLine: 'scooter',
        status: 'qualifying',
        score: 80,
      })
      .returning();
    return { customerId: c.id, leadId: lead!.id };
  }

  function buildApp(opts?: { hmacSecret?: string }) {
    return buildVoiceRouter({
      db,
      ...(opts?.hmacSecret !== undefined ? { hmacSecret: opts.hmacSecret } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // 1. Happy path — signed transcript → 200 { replyText, sessionState:'live' }
  // -------------------------------------------------------------------------
  it('test 1 (happy POST): valid signed transcript returns 200 live + reply text', async () => {
    const { leadId, customerId } = await seedLead();
    claudeStub.nextText = "D'accord, je note votre demande.";
    const app = buildApp({ hmacSecret: SECRET });
    const body = JSON.stringify({
      sessionId: 'sess-abc',
      leadId,
      customerId,
      transcript: "C'est combien pour ma trottinette ?",
    });
    const res = await app.request('/v1/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { replyText: string; sessionState: string };
    expect(j.sessionState).toBe('live');
    expect(j.replyText).toBe("D'accord, je note votre demande.");
  });

  // -------------------------------------------------------------------------
  // 2. HMAC disabled (dev mode) → 200 without a signature header
  // -------------------------------------------------------------------------
  it('test 2 (no secret configured): signature check skipped (dev mode)', async () => {
    const { leadId, customerId } = await seedLead();
    const app = buildApp(); // no secret
    const body = JSON.stringify({
      sessionId: 'sess-dev',
      leadId,
      customerId,
      transcript: 'bonjour',
    });
    const res = await app.request('/v1/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { sessionState: string };
    expect(j.sessionState).toBe('live');
  });

  // -------------------------------------------------------------------------
  // 3. Missing signature when secret configured → 401
  // -------------------------------------------------------------------------
  it('test 3 (missing signature): no header when secret required -> 401', async () => {
    const { leadId, customerId } = await seedLead();
    const app = buildApp({ hmacSecret: SECRET });
    const body = JSON.stringify({ sessionId: 's', leadId, customerId, transcript: 'hi' });
    const res = await app.request('/v1/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 4. Validation 400 — missing transcript (zod) and bad uuid
  // -------------------------------------------------------------------------
  it('test 4a (bad zod): missing transcript -> 400', async () => {
    const { leadId, customerId } = await seedLead();
    const app = buildApp({ hmacSecret: SECRET });
    const body = JSON.stringify({ sessionId: 's', leadId, customerId });
    const res = await app.request('/v1/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_payload' });
  });

  it('test 4b (bad uuid): non-uuid leadId -> 400', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = JSON.stringify({
      sessionId: 's',
      leadId: 'not-a-uuid',
      customerId: '11111111-1111-1111-1111-111111111111',
      transcript: 'hi',
    });
    const res = await app.request('/v1/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('test 4c (bad JSON): malformed body -> 400', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    const body = '{"sessionId": "s", "leadId"'; // truncated
    const res = await app.request('/v1/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 5. Resolution failure keeps the line alive — 200 live + repeat prompt
  //
  // Unknown leadId makes generateSalesReply throw (lead not found); the route
  // must NOT 5xx — it returns the "pouvez-vous répéter" prompt so Pipecat keeps
  // the caller engaged.
  // -------------------------------------------------------------------------
  it('test 5 (resolution failure): unknown leadId -> 200 live + repeat prompt', async () => {
    const app = buildApp({ hmacSecret: SECRET });
    // RFC-4122 valid UUIDs (variant nibble 8-b) that don't exist in the DB —
    // resolution throws "lead not found", which the route must absorb.
    const body = JSON.stringify({
      sessionId: 's',
      leadId: '22222222-2222-4222-a222-222222222222',
      customerId: '33333333-3333-4333-b333-333333333333',
      transcript: 'allô ?',
    });
    const res = await app.request('/v1/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { replyText: string; sessionState: string };
    expect(j.sessionState).toBe('live');
    expect(j.replyText).toBe('Pardon, pouvez-vous répéter ?');
  });

  // -------------------------------------------------------------------------
  // 6. Compliance block → 200 { sessionState:'escalated' } + escalation copy
  //
  // Gated on TEST_REDIS_URL (block path emits COMPLIANCE.BLOCKED via BullMQ).
  // -------------------------------------------------------------------------
  it.skipIf(!process.env.TEST_REDIS_URL)(
    'test 6 (compliance block): hard rule -> 200 escalated + escalation reply',
    async () => {
      const prevRedisUrl = process.env.REDIS_URL;
      const prevPrefix = process.env.BULLMQ_PREFIX;
      process.env.REDIS_URL = process.env.TEST_REDIS_URL!;
      process.env.BULLMQ_PREFIX = `f16-test-voice-block-${randomBytes(4).toString('hex')}`;
      __resetForTests();
      try {
        const { leadId, customerId } = await seedLead();
        // Hard rule fast-path: matches `contract-already-bound`.
        claudeStub.nextText = 'Votre contrat est validé.';
        const app = buildApp({ hmacSecret: SECRET });
        const body = JSON.stringify({
          sessionId: 'sess-block',
          leadId,
          customerId,
          transcript: 'On en est où ?',
        });
        const res = await app.request('/v1/voice/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-f16-signature': sign(body, SECRET) },
          body,
        });
        expect(res.status).toBe(200);
        const j = (await res.json()) as { replyText: string; sessionState: string };
        expect(j.sessionState).toBe('escalated');
        expect(j.replyText).toBe(
          'Je préfère vérifier ce point avec un conseiller, je vous fais rappeler très vite.',
        );
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
