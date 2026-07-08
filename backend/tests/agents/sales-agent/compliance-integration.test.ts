/**
 * Sales Agent + Compliance Sentry integration tests (M6.T4).
 *
 * Exercises the full path: BullMQ enqueue → agent worker pickup → Sentry
 * (Haiku stub) → send / self-correct / block-and-escalate. Gated on
 * TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY (same gate as
 * the other M3+ integration tests).
 *
 * ADVISORY restructure (2026-07-07, commits 1bca9f3 + 666f685): only hard
 * server rules and CRITICAL LLM verdicts (the 6-family red-line list) hold a
 * message pre-send. A refused draft gets ONE self-correction rewrite
 * (re-judged; sent if clean, audit `compliance.self-corrected`); only a
 * rewrite that is STILL refused escalates to a human action. Minor LLM
 * reservations send + audit `compliance.flagged`.
 *
 * The Claude stub dispatches on model: Sonnet returns the Sales Agent's
 * draft/rewrite (`sonnetTexts` queue); Haiku returns the canned sentry
 * verdict (`sentryTexts` queue, default = pass).
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
  auditLog,
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
  timeoutMs = Number(process.env.TEST_WAITFOR_MS) || 15_000,
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
  /** Qualification-extractor Haiku calls — tracked separately so they don't inflate the sentry count. */
  public extractorCalls: Array<{ model: string }> = [];
  /** Queue of texts the Sonnet (Sales LLM) stub returns. Single fallback when empty. */
  public sonnetTexts: string[] = [];
  public sonnetDefault = 'Bonjour, je peux vous aider.';
  /** Queue of texts the Haiku (Sentry) stub returns. Default pass when empty. */
  public sentryTexts: string[] = [];
  public sentryDefault = '{"verdict":"pass","reasons":[]}';
  public messages = {
    create: async (req: { model: string; system?: unknown; messages?: unknown }) => {
      if (req.model.includes('haiku')) {
        // The qualification extractor also runs on Haiku (WhatsApp turns). Keep
        // it OUT of the sentry count and return an empty extraction (no-op) so
        // these compliance tests measure only the Sentry's Haiku calls.
        const blob = JSON.stringify(req.system ?? '') + JSON.stringify(req.messages ?? '');
        if (blob.includes('ÉTAT DÉJÀ COLLECTÉ') || blob.includes('extrais des champs structurés')) {
          this.extractorCalls.push({ model: req.model });
          return {
            content: [{ type: 'text' as const, text: '{}' }],
            stop_reason: 'end_turn' as const,
            usage: { input_tokens: 20, output_tokens: 3 },
          };
        }
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
    await db.execute(sql`TRUNCATE TABLE audit_log`);

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
  // Test 2 — hard server rule, rewrite ALSO refused → still blocks.
  //   Draft 1 hits `contract-already-bound` (critical family 1); the ONE
  //   self-correction rewrite hits `insurance-active` (same family) — so the
  //   message is held, a human action is created and COMPLIANCE.BLOCKED is
  //   emitted. Both attempts fast-path on hard rules: NO Haiku call.
  //   A follow-up clean turn then sends (blocked state doesn't linger).
  // -------------------------------------------------------------------------
  it('test 2 (hard red line ×2): refused draft + refused rewrite → no send, human_actions row, COMPLIANCE.BLOCKED emitted', async () => {
    const { customerId, leadId, instanceId } = await seedAndSpawn();
    // Attempt 1: hard rule `contract-already-bound`.
    claudeStub.sonnetTexts.push('Votre contrat est validé.');
    // Self-correction rewrite: STILL a hard red line (`insurance-active`).
    claudeStub.sonnetTexts.push('Bonne nouvelle : vous êtes désormais couvert !');

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
    // Sales LLM called TWICE (draft + self-correction rewrite); sentry Haiku
    // never consulted — both attempts fast-pathed on hard server rules.
    expect(claudeStub.sonnetCalls).toHaveLength(2);
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

    // A refused rewrite is NOT a self-correction success — no audit row.
    const corrected = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'compliance.self-corrected'));
    expect(corrected).toHaveLength(0);

    // Blocked state doesn't linger: a later clean draft sends normally.
    claudeStub.sonnetTexts.push('Bonjour, je peux vous aider ?');
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
      const [r2] = await db.select().from(agentMessages).where(eq(agentMessages.id, msg2));
      return Boolean(r2 && r2.result);
    });
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([{ type: 'text', text: 'Bonjour, je peux vous aider ?' }]);
    // Still exactly one human_action — from the first (blocked) turn.
    expect(await db.select().from(humanActions)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 3 — self-correction: server-clean draft, LLM sentry returns a
  //   CRITICAL block (family 2: personalized price invented with no devis)
  //   → ONE rewrite with the refusal reasons as feedback → re-judged clean
  //   → the REWRITE sends + `compliance.self-corrected` audit row. No human
  //   action, no COMPLIANCE.BLOCKED.
  // -------------------------------------------------------------------------
  it('test 3 (self-correction): critical LLM block → rewrite re-judged clean → rewrite sends + audit', async () => {
    const { customerId, leadId, instanceId } = await seedAndSpawn();
    // Attempt 1: personalized price with NO devis in context — soft server
    // hit (exact-price-no-devis) so Haiku IS consulted, and it blocks critical.
    claudeStub.sonnetTexts.push('Votre prime sera exactement de 12,34 € par mois.');
    claudeStub.sentryTexts.push(
      '{"verdict":"block","severity":"critical","reasons":["prix personnalisé inventé sans aucun devis"]}',
    );
    // Self-correction rewrite: clean. Its re-judge uses the default pass
    // (sentryTexts queue is empty by then).
    claudeStub.sonnetTexts.push('Je reviens vers vous très vite avec un devis personnalisé.');

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
          content: 'Combien ça coûte ?',
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

    // The REWRITE (not the refused draft) went out through the channel.
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([
      { type: 'text', text: 'Je reviens vers vous très vite avec un devis personnalisé.' },
    ]);
    // Sonnet: draft + rewrite. Haiku: initial judge + re-judge of the rewrite.
    expect(claudeStub.sonnetCalls).toHaveLength(2);
    expect(claudeStub.haikuCalls).toHaveLength(2);

    // Handler reports a normal send (no `blocked` key on the reply path).
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msgId));
    const result = row!.result as Record<string, unknown>;
    expect(result['sent']).toBe(true);
    expect(result['blocked']).toBeUndefined();

    // Self-healing is invisible to management: no human action, no BLOCKED emit.
    expect(await db.select().from(humanActions)).toHaveLength(0);
    const blocked = await db
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.intent, 'COMPLIANCE.BLOCKED'),
          eq(agentMessages.correlationId, leadId),
        ),
      );
    expect(blocked).toHaveLength(0);

    // ...but leaves the `compliance.self-corrected` audit trail.
    const corrected = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'compliance.self-corrected'));
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.actorId).toContain('sales-agent');
    expect(corrected[0]!.targetId).toBe(leadId);
    const meta = corrected[0]!.meta as {
      refusedReasons: string[];
      refusedDraft: string;
      sentDraft: string;
    };
    expect(meta.refusedReasons).toEqual(['prix personnalisé inventé sans aucun devis']);
    expect(meta.refusedDraft).toContain('12,34');
    expect(meta.sentDraft).toBe('Je reviens vers vous très vite avec un devis personnalisé.');
  });

  // -------------------------------------------------------------------------
  // Test 4 — advisory: LLM sentry blocks with severity=minor (not on the
  //   6-family critical list) → the ORIGINAL draft sends anyway, no rewrite,
  //   no human action — just a `compliance.flagged` audit row for review.
  // -------------------------------------------------------------------------
  it('test 4 (advisory minor): sentry minor concern → message sends + compliance.flagged audit, no escalation', async () => {
    const { customerId, leadId, instanceId } = await seedAndSpawn();
    // Server-clean draft; the sentry has a reservation but it's minor
    // (approximation on dossier state — explicitly minor in the rubric).
    claudeStub.sonnetTexts.push(
      'Vos deux devis sont déjà partis, je vous les renvoie tout de suite.',
    );
    claudeStub.sentryTexts.push(
      '{"verdict":"block","severity":"minor","reasons":["approximation sur l\'état d\'envoi des devis"]}',
    );

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
          content: 'Vous pouvez me renvoyer les devis ?',
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

    // The original draft sent — minor concerns never hold the message.
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.body).toEqual([
      { type: 'text', text: 'Vos deux devis sont déjà partis, je vous les renvoie tout de suite.' },
    ]);
    // No self-correction rewrite: ONE Sonnet call, ONE Haiku judge.
    expect(claudeStub.sonnetCalls).toHaveLength(1);
    expect(claudeStub.haikuCalls).toHaveLength(1);

    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, msgId));
    const result = row!.result as Record<string, unknown>;
    expect(result['sent']).toBe(true);
    expect(result['blocked']).toBeUndefined();

    // Nothing reaches management…
    expect(await db.select().from(humanActions)).toHaveLength(0);
    const blocked = await db
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.intent, 'COMPLIANCE.BLOCKED'),
          eq(agentMessages.correlationId, leadId),
        ),
      );
    expect(blocked).toHaveLength(0);

    // …but the advisory audit trail is there for after-the-fact review.
    const flagged = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'compliance.flagged'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.targetId).toBe(leadId);
    const meta = flagged[0]!.meta as { reasons: string[]; draft: string };
    expect(meta.reasons).toEqual(["approximation sur l'état d'envoi des devis"]);
    expect(meta.draft).toContain('Vos deux devis sont déjà partis');
  });
});
