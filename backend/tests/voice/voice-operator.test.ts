/**
 * Voice Operator Agent tests (Asterisk ARI).
 *
 * DB-gated (TEST_DATABASE_URL + PII_ENCRYPTION_KEY) and Redis-gated
 * (TEST_REDIS_URL) — the agent's `send()` emits VOICE.CALL_STARTED /
 * VOICE.CALL_FAILED through the dispatcher (durable agent_messages row + BullMQ
 * enqueue) AND putSession() writes the session registry to Redis.
 *
 * We exercise `onMessage` directly via a Testable subclass (same seam as the
 * Engagement Agent suite) with a FAKE Asterisk client injected — no network.
 * Covers:
 *   - VOICE.CALL_SCHEDULED → originateCall called with the resolved phone +
 *     sessionId → VOICE.CALL_STARTED {callId, channelId} emitted + audit row +
 *     session stored in Redis (getSession resolves it)
 *   - originateCall throws → VOICE.CALL_FAILED emitted (with reason)
 *   - Asterisk client disabled (null) → VOICE.CALL_FAILED, no audit
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, auditLog, humanActions } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { __resetForTests, getRedis, shutdownQueues } from '../../src/queue/index.js';
import { VoiceOperatorAgent } from '../../src/agents/voice-operator/agent.js';
import { getSession, type RedisLike } from '../../src/voice/session-store.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../src/messaging/dispatcher.js';
import type { AsteriskAriClient, OriginateCallInput } from '../../src/voice/asterisk-client.js';

const pgUrl = process.env.TEST_DATABASE_URL;
// The whole suite needs Redis (send() → BullMQ + putSession). Gate on BOTH.
const d = describe.skipIf(!pgUrl || !process.env.TEST_REDIS_URL);

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

/** Fake Asterisk client capturing originate calls + a programmable outcome. */
class FakeAsteriskClient {
  public calls: OriginateCallInput[] = [];
  public nextChannelId = 'chan-1234.5';
  public throwReason: string | null = null;
  async originateCall(input: OriginateCallInput): Promise<{ channelId: string }> {
    this.calls.push(input);
    if (this.throwReason) throw new Error(this.throwReason);
    return { channelId: this.nextChannelId };
  }
}

class TestableVoiceOperator extends VoiceOperatorAgent {
  public handle(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    return (
      this as unknown as {
        onMessage: (e: AgentMessageEnvelope) => Promise<MessageHandlerResult>;
      }
    ).onMessage(envelope);
  }
}

function envelope(callId: string, customerId: string, toNumber: string): AgentMessageEnvelope {
  return {
    id: `msg-voice-${callId}`,
    intent: 'VOICE.CALL_SCHEDULED',
    toRole: 'voice-operator',
    toInstance: 'singleton',
    correlationId: callId,
    payload: { callId, customerId, toNumber, scheduledAt: new Date().toISOString() },
    priority: 5,
    createdAt: new Date(),
  } as unknown as AgentMessageEnvelope;
}

const CALL_ID = '44444444-4444-4444-8444-444444444444';

d('VoiceOperatorAgent.onMessage', () => {
  let db: Database;
  let prevRedisUrl: string | undefined;
  let prevPrefix: string | undefined;

  beforeAll(() => {
    prevRedisUrl = process.env.REDIS_URL;
    prevPrefix = process.env.BULLMQ_PREFIX;
    process.env.REDIS_URL = process.env.TEST_REDIS_URL!;
    process.env.BULLMQ_PREFIX = `f16-test-voice-op-${randomBytes(4).toString('hex')}`;
    __resetForTests();
  });

  afterAll(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
    if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prevRedisUrl;
    if (prevPrefix === undefined) delete process.env.BULLMQ_PREFIX;
    else process.env.BULLMQ_PREFIX = prevPrefix;
  });

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    // Drain any agent_messages the dispatcher enqueued to keep Redis clean
    // between cases (the prefix is unique per suite, so this is belt+braces).
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`).catch(() => {});
  });

  function newAgent(client: FakeAsteriskClient | null): TestableVoiceOperator {
    return new TestableVoiceOperator({
      role: 'voice-operator',
      instanceId: 'singleton',
      model: 'sonnet',
      queues: ['voice'],
      db,
      asteriskClient: client as unknown as AsteriskAriClient | null,
    });
  }

  async function seedCustomer(phone: string | null): Promise<string> {
    const c = await insertCustomer(db, {
      fullName: 'Jean Dupont',
      phone,
      email: null,
      civility: null,
      vehicle: null,
    });
    return c.id;
  }

  it('originates a call and emits VOICE.CALL_STARTED + audit + session on success', async () => {
    const customerId = await seedCustomer('+33611223344');
    const fake = new FakeAsteriskClient();
    const agent = newAgent(fake);

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33600000000'));
    expect(result).toMatchObject({ ok: true, result: { started: true } });

    // Resolved the DB phone (not the stale intent toNumber) + passed a sessionId.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.to).toBe('+33611223344');
    const sessionId = fake.calls[0]!.sessionId;
    expect(sessionId).toBeTruthy();

    // Session registry written — Pipecat resolves leadId/customerId from it.
    // leadId = the call's correlationId (CALL_ID here); customerId = the seed.
    const stored = await getSession(sessionId, getRedis() as unknown as RedisLike);
    expect(stored).toEqual({ leadId: CALL_ID, customerId });

    // VOICE.CALL_STARTED emitted with the channelId.
    const msgs = await db.select().from(agentMessages);
    const started = msgs.find((m) => m.intent === 'VOICE.CALL_STARTED');
    expect(started).toBeDefined();
    expect(started?.correlationId).toBe(CALL_ID);
    expect((started?.payload as { channelId: string }).channelId).toBe('chan-1234.5');
    expect((started?.payload as { callId: string }).callId).toBe(CALL_ID);

    // Audit row written — records the customerId, never the phone.
    const audits = await db.select().from(auditLog);
    const row = audits.find((a) => a.action === 'voice.call.originated');
    expect(row).toBeDefined();
    expect(row?.targetId).toBe(customerId);
    expect((row?.after as { channelId: string }).channelId).toBe('chan-1234.5');
    // PII guard: the audit must not contain the phone number anywhere.
    expect(JSON.stringify(row)).not.toContain('+33611223344');
  });

  it('falls back to the intent toNumber when the customer has no DB phone', async () => {
    const customerId = await seedCustomer(null);
    const fake = new FakeAsteriskClient();
    const agent = newAgent(fake);

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33655555555'));
    expect(result).toMatchObject({ ok: true, result: { started: true } });
    expect(fake.calls[0]!.to).toBe('+33655555555');
  });

  it('emits VOICE.CALL_FAILED with the reason when originateCall throws', async () => {
    const customerId = await seedCustomer('+33611223344');
    const fake = new FakeAsteriskClient();
    fake.throwReason = 'asterisk_originate_failed_503';
    const agent = newAgent(fake);

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33600000000'));
    // Handler returns ok (the message was handled; we don't retry a bad call).
    expect(result).toMatchObject({ ok: true, result: { failed: true } });

    const msgs = await db.select().from(agentMessages);
    const failed = msgs.find((m) => m.intent === 'VOICE.CALL_FAILED');
    expect(failed).toBeDefined();
    expect((failed?.payload as { reason: string }).reason).toBe('asterisk_originate_failed_503');

    const audits = await db.select().from(auditLog);
    expect(audits.find((a) => a.action === 'voice.call.failed')).toBeDefined();
  });

  it('escalates a real failure to a deduped human action + WA notify (2026-07-10)', async () => {
    const customerId = await seedCustomer('+33611223344');
    const fake = new FakeAsteriskClient();
    fake.throwReason = 'asterisk_originate_no_channel';
    const agent = newAgent(fake);

    await agent.handle(envelope(CALL_ID, customerId, '+33600000000'));

    // Human action: correlated on the CUSTOMER id (the retry executor dials
    // from it), English summary with the customer's name + plain diagnosis.
    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.intent).toBe('VOICE_CALL_FAILED');
    expect(actions[0]!.correlationId).toBe(customerId);
    expect(actions[0]!.summary).toContain('Jean Dupont');
    expect(actions[0]!.summary).toContain('invalid or unreachable');
    expect((actions[0]!.options as Array<{ id: string }>).map((o) => o.id)).toEqual([
      'retry',
      'ignore',
    ]);

    // WA-group bridge: HUMAN_ACTION.REQUESTED emitted for the reporter.
    const msgs = await db.select().from(agentMessages);
    const notify = msgs.find((m) => m.intent === 'HUMAN_ACTION.REQUESTED');
    expect(notify).toBeDefined();
    expect((notify?.payload as { humanActionId: string }).humanActionId).toBe(actions[0]!.id);

    // Second failure for the SAME customer (different callId + toNumber so the
    // per-number duplicate-call guard lets it through) → NO second action.
    const secondCallId = '55555555-5555-4555-8555-555555555555';
    await agent.handle(envelope(secondCallId, customerId, '+33600000001'));
    const after = await db.select().from(humanActions);
    expect(after).toHaveLength(1);
  });

  it('emits VOICE.CALL_FAILED (no audit) when the Asterisk client is disabled', async () => {
    const customerId = await seedCustomer('+33611223344');
    const agent = newAgent(null); // injected null = origination disabled

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33600000000'));
    expect(result).toMatchObject({
      ok: true,
      result: { failed: true, reason: 'asterisk_disabled_no_env' },
    });

    const msgs = await db.select().from(agentMessages);
    expect(msgs.find((m) => m.intent === 'VOICE.CALL_FAILED')).toBeDefined();
    // Config gap → no audit noise.
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it('ignores non-VOICE.CALL_SCHEDULED intents', async () => {
    const agent = newAgent(new FakeAsteriskClient());
    const env = {
      ...envelope(CALL_ID, '22222222-2222-4222-b222-222222222222', '+33600000000'),
      intent: 'VOICE.CALL_STARTED',
    } as AgentMessageEnvelope;
    const result = await agent.handle(env);
    expect(result).toMatchObject({ ok: true, result: { skipped: 'unhandled-intent' } });
  });
});
