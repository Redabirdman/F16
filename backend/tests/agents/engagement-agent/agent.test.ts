/**
 * EngagementAgent — DB-backed unit tests (M11).
 *
 * Same shape as the Sales Agent suite: live pg, stub WhatsApp channel, stub
 * Claude client (so Haiku nudge gen runs offline), no Redis (we exercise
 * `onMessage` via a test subclass instead of going through BullMQ).
 *
 * Covers the cadence ladder, quiet hours, anti-spam, the 7d escalation +
 * dormant flip, the no-turns-yet skip, and ineligible-status filtering.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import {
  agentMessages,
  conversationTurns,
  humanActions,
  leads,
} from '../../../src/db/schema/index.js';
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
import { EngagementAgent } from '../../../src/agents/engagement-agent/agent.js';
import type {
  AgentMessageEnvelope,
  MessageHandlerResult,
} from '../../../src/messaging/dispatcher.js';

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
      acceptedAt: new Date('2026-05-24T12:00:00.000Z'),
      raw: { stub: true },
    };
  }
}

class StubAnthropic {
  public nextText = 'Bonjour Marie, avez-vous eu le temps de réfléchir au devis ?';
  public messages = {
    create: async () => ({
      content: [{ type: 'text' as const, text: this.nextText }],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 80, output_tokens: 20 },
    }),
  };
}

class TestableEngagementAgent extends EngagementAgent {
  public handle(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    return (
      this as unknown as {
        onMessage: (e: AgentMessageEnvelope) => Promise<MessageHandlerResult>;
      }
    ).onMessage(envelope);
  }
}

/**
 * Pin BOTH `Date.now()` and the no-arg `new Date()` constructor to a fixed
 * instant, then run `fn`, then restore. The engagement agent reads the clock
 * via `new Date()` (not `Date.now()`), so overriding `Date.now` alone leaks the
 * real wall-clock into the agent — making the quiet-hours / anti-spam skip
 * tests pass or fail depending on the real day/time the suite happens to run.
 * This wrapper makes those tests deterministic. `new Date(arg)` is preserved.
 */
async function withFixedClock(instant: Date, fn: () => Promise<void>): Promise<void> {
  const RealDate = Date;
  const fixedMs = instant.getTime();

  class FixedDate extends RealDate {
    constructor(...args: any[]) {
      // No-arg construction → the pinned instant; explicit args pass through
      // unchanged. We branch on arity so trailing `undefined`s never sneak in
      // (which would otherwise yield an Invalid Date for the y/m/d... form).

      switch (args.length) {
        case 0:
          super(fixedMs);
          break;
        case 1:
          super(args[0]);
          break;
        case 2:
          super(args[0], args[1]);
          break;
        case 3:
          super(args[0], args[1], args[2]);
          break;
        case 4:
          super(args[0], args[1], args[2], args[3]);
          break;
        case 5:
          super(args[0], args[1], args[2], args[3], args[4]);
          break;
        case 6:
          super(args[0], args[1], args[2], args[3], args[4], args[5]);
          break;
        default:
          super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
      }
    }
    static override now(): number {
      return fixedMs;
    }
  }

  (globalThis as any).Date = FixedDate;
  try {
    await fn();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}

function envelope(leadId: string): AgentMessageEnvelope {
  return {
    id: 'msg-engagement-test-1',
    intent: 'ENGAGEMENT.TICK',
    toRole: 'engagement-agent',
    toInstance: 'singleton',
    correlationId: leadId,
    payload: { leadId },
    priority: 6,
    createdAt: new Date(),
  } as unknown as AgentMessageEnvelope;
}

d('EngagementAgent.onMessage', () => {
  let db: Database;
  let wa: StubChannel;
  let claudeStub: StubAnthropic;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);

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

  /** Seed a lead in `qualifying` with one outbound welcome turn at hoursAgo. */
  async function seed(opts: {
    welcomeHoursAgo: number;
    status?: 'scored' | 'qualifying' | 'quoting' | 'negotiating' | 'new' | 'dormant';
    extraTurns?: Array<{
      direction: 'inbound' | 'outbound';
      hoursAgo: number;
      agentRole?: string | null;
      content?: string;
    }>;
    firstName?: string;
    productLine?: 'scooter' | 'car';
  }): Promise<{ leadId: string; customerId: string }> {
    const cust = await insertCustomer(db, {
      fullName: opts.firstName ? `${opts.firstName} Test` : 'Marie Test',
      phone: '+33611111111',
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: cust.id,
        source: 'website',
        productLine: opts.productLine ?? 'scooter',
        status: opts.status ?? 'qualifying',
        score: 80,
      })
      .returning();
    const welcomeAt = new Date(Date.now() - opts.welcomeHoursAgo * 3600_000);
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      leadId: lead!.id,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      agentInstance: `lead-${lead!.id}`,
      content: 'Bonjour Marie, voici votre devis…',
      occurredAt: welcomeAt,
    });
    for (const t of opts.extraTurns ?? []) {
      await db.insert(conversationTurns).values({
        customerId: cust.id,
        leadId: lead!.id,
        channel: 'whatsapp',
        direction: t.direction,
        agentRole: t.agentRole ?? (t.direction === 'outbound' ? 'sales-agent' : null),
        agentInstance:
          t.direction === 'outbound'
            ? t.agentRole === 'engagement-agent'
              ? 'singleton'
              : `lead-${lead!.id}`
            : null,
        content: t.content ?? 'msg',
        occurredAt: new Date(Date.now() - t.hoursAgo * 3600_000),
      });
    }
    return { leadId: lead!.id, customerId: cust.id };
  }

  function newAgent(): TestableEngagementAgent {
    return new TestableEngagementAgent({
      role: 'engagement-agent',
      instanceId: 'singleton',
      model: 'haiku',
      queues: ['engagement'],
      db,
    });
  }

  it('skips when the lead is in an ineligible status', async () => {
    const { leadId } = await seed({ welcomeHoursAgo: 30, status: 'dormant' });
    const result = await newAgent().handle(envelope(leadId));
    expect(result).toMatchObject({
      ok: true,
      result: { skipped: 'lead-status-ineligible', status: 'dormant' },
    });
    expect(wa.sends).toHaveLength(0);
  });

  it('skips when the lead has no conversation turns yet', async () => {
    const cust = await insertCustomer(db, { fullName: 'Untouched', phone: '+33611111111' });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: cust.id,
        source: 'website',
        productLine: 'scooter',
        status: 'qualifying',
        score: 70,
      })
      .returning();
    const result = await newAgent().handle(envelope(lead!.id));
    expect(result).toMatchObject({
      ok: true,
      result: { skipped: 'no-conversation-turns-yet' },
    });
  });

  it('skips when threshold (24h) not reached at step 0', async () => {
    const { leadId } = await seed({ welcomeHoursAgo: 5 });
    const result = await newAgent().handle(envelope(leadId));
    expect(result.ok).toBe(true);
    expect((result as { ok: true; result: { skipped?: string } }).result.skipped).toBe(
      'threshold-not-reached',
    );
    expect(wa.sends).toHaveLength(0);
  });

  it('sends nudge 1 at step 0 when >= 24h have elapsed (weekday daytime)', async () => {
    // Pick a deterministic Tuesday 14:00 Paris. The agent reads the clock via
    // `new Date()`, so pin the WHOLE Date constructor (withFixedClock) — the
    // old Date.now-only override leaked the real wall-clock into the
    // quiet-hours gate and failed this test on weekends (first bit 2026-07-04,
    // a Saturday).
    // 2026-05-19 14:00 Paris = 12:00 UTC (CEST UTC+2). Tuesday.
    const fixed = new Date('2026-05-19T12:00:00Z');
    const cust = await insertCustomer(db, { fullName: 'Marie Test', phone: '+33611111111' });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: cust.id,
        source: 'website',
        productLine: 'scooter',
        status: 'qualifying',
        score: 80,
      })
      .returning();
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      leadId: lead!.id,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      agentInstance: `lead-${lead!.id}`,
      content: 'welcome',
      occurredAt: new Date(fixed.getTime() - 30 * 3600_000),
    });
    await withFixedClock(fixed, async () => {
      const result = await newAgent().handle(envelope(lead!.id));
      expect(result).toMatchObject({
        ok: true,
        result: { sent: true, cadenceStep: 1, channel: 'whatsapp' },
      });
      expect(wa.sends).toHaveLength(1);
      // The outbound turn must be attributed to the engagement-agent so the
      // NEXT tick can detect step=1 and apply the 72h threshold.
      const turns = await db
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.customerId, cust.id));
      const nudgeTurn = turns.find((t) => t.agentRole === 'engagement-agent');
      expect(nudgeTurn).toBeDefined();
      expect(nudgeTurn?.direction).toBe('outbound');
    });
  });

  it('skips on quiet hours (Saturday) even when threshold is reached', async () => {
    // 2026-05-23T12:00:00Z = Saturday 14:00 Paris. The agent reads the clock
    // via `new Date()`, so we pin the whole Date constructor (not just
    // Date.now) to make this deterministic regardless of the real run day.
    const fixed = new Date('2026-05-23T12:00:00Z');
    const fixedMs = fixed.getTime();
    await withFixedClock(fixed, async () => {
      await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
      const cust = await insertCustomer(db, { fullName: 'Marie', phone: '+33611111111' });
      const [lead] = await db
        .insert(leads)
        .values({
          customerId: cust.id,
          source: 'website',
          productLine: 'scooter',
          status: 'qualifying',
          score: 80,
        })
        .returning();
      await db.insert(conversationTurns).values({
        customerId: cust.id,
        leadId: lead!.id,
        channel: 'whatsapp',
        direction: 'outbound',
        agentRole: 'sales-agent',
        content: 'welcome',
        occurredAt: new Date(fixedMs - 30 * 3600_000),
      });
      const result = await newAgent().handle(envelope(lead!.id));
      expect(result).toMatchObject({
        ok: true,
        result: { skipped: 'quiet-hours' },
      });
      expect(wa.sends).toHaveLength(0);
    });
  });

  it('suppresses the nudge when a sales-agent reply happened within the threshold', async () => {
    const fixed = new Date('2026-05-19T12:00:00Z'); // Tuesday 14:00 Paris
    const fixedMs = fixed.getTime();
    // Pin the whole Date constructor: the agent reads `new Date()` for "now",
    // so overriding Date.now alone leaks the real wall-clock and the anti-spam
    // window (outbound 2h ago) appears days old → the skip never fires.
    await withFixedClock(fixed, async () => {
      await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
      const cust = await insertCustomer(db, { fullName: 'Marie', phone: '+33611111111' });
      const [lead] = await db
        .insert(leads)
        .values({
          customerId: cust.id,
          source: 'website',
          productLine: 'scooter',
          status: 'qualifying',
          score: 80,
        })
        .returning();
      // Inbound 30h ago (would normally trigger), but sales-agent replied 2h ago.
      await db.insert(conversationTurns).values({
        customerId: cust.id,
        leadId: lead!.id,
        channel: 'whatsapp',
        direction: 'inbound',
        content: 'On reparle plus tard',
        occurredAt: new Date(fixedMs - 30 * 3600_000),
      });
      await db.insert(conversationTurns).values({
        customerId: cust.id,
        leadId: lead!.id,
        channel: 'whatsapp',
        direction: 'outbound',
        agentRole: 'sales-agent',
        content: 'Pas de souci, je reste disponible',
        occurredAt: new Date(fixedMs - 2 * 3600_000),
      });
      const result = await newAgent().handle(envelope(lead!.id));
      expect(result.ok).toBe(true);
      // Anti-spam fires because last activity is the outbound 2h ago, well
      // under the 24h threshold for step 0.
      const tagged = result as { ok: true; result: { skipped?: string } };
      expect(['threshold-not-reached', 'anti-spam-recent-outbound']).toContain(
        tagged.result.skipped,
      );
      expect(wa.sends).toHaveLength(0);
    });
  });

  it('escalates + marks dormant at step 2 after 7d (any weekday/weekend)', async () => {
    const { leadId, customerId } = await seed({
      welcomeHoursAgo: 7 * 24 + 5, // > 7d
      status: 'qualifying',
      extraTurns: [
        // Two engagement-agent nudges already sent, both >7d ago, so
        // step = 2 and the threshold elapsed.
        {
          direction: 'outbound',
          hoursAgo: 7 * 24 + 3,
          agentRole: 'engagement-agent',
          content: 'nudge 1',
        },
        {
          direction: 'outbound',
          hoursAgo: 7 * 24 + 1,
          agentRole: 'engagement-agent',
          content: 'nudge 2',
        },
      ],
    });
    const result = await newAgent().handle(envelope(leadId));
    expect(result).toMatchObject({
      ok: true,
      result: { escalated: true, leadStatus: 'dormant' },
    });
    // Lead row flipped.
    const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(row?.status).toBe('dormant');
    // human_action row created.
    const allActions = await db.select().from(humanActions);
    expect(allActions).toHaveLength(1);
    expect(allActions[0]?.intent).toBe('LEAD_DORMANT');
    // HUMAN_ACTION.REQUESTED emitted to the human-router queue.
    const msgs = await db.select().from(agentMessages);
    const requested = msgs.find(
      (m) => m.intent === 'HUMAN_ACTION.REQUESTED' && m.toRole === 'human-router',
    );
    expect(requested).toBeDefined();
    expect(requested?.correlationId).toBe(leadId);
    // The customer was NOT messaged on the escalation path.
    expect(wa.sends).toHaveLength(0);
    // Sanity: customerId is the one we seeded.
    expect(customerId).toBeDefined();
  });

  it('returns lead_not_found when the leadId does not exist', async () => {
    const result = await newAgent().handle(envelope('00000000-0000-4000-8000-000000000000'));
    expect(result).toEqual({ ok: false, error: 'lead_not_found' });
  });

  it('ignores envelopes with a non-ENGAGEMENT.TICK intent', async () => {
    const result = await newAgent().handle({
      ...envelope('00000000-0000-4000-8000-000000000000'),
      intent: 'QUOTE.REQUESTED',
    } as AgentMessageEnvelope);
    expect(result).toMatchObject({
      ok: true,
      result: { skipped: 'unhandled-intent', intent: 'QUOTE.REQUESTED' },
    });
  });
});
