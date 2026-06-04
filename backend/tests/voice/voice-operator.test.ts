/**
 * Voice Operator Agent tests (M10).
 *
 * DB-gated (TEST_DATABASE_URL + PII_ENCRYPTION_KEY) and Redis-gated
 * (TEST_REDIS_URL) — the agent's `send()` emits VOICE.CALL_STARTED /
 * VOICE.CALL_FAILED through the dispatcher, which writes the durable
 * `agent_messages` row AND enqueues a BullMQ job, so Redis is required.
 *
 * We exercise `onMessage` directly via a Testable subclass (same seam as the
 * Engagement Agent suite) with a FAKE jambonz client injected — no network.
 * Covers:
 *   - VOICE.CALL_SCHEDULED → originateCall called with the resolved phone →
 *     VOICE.CALL_STARTED emitted + audit row written
 *   - originateCall throws → VOICE.CALL_FAILED emitted (with reason)
 *   - jambonz client disabled (null) → VOICE.CALL_FAILED, no audit
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, auditLog } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';
import { VoiceOperatorAgent } from '../../src/agents/voice-operator/agent.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../src/messaging/dispatcher.js';
import type { JambonzClient, OriginateCallInput } from '../../src/voice/jambonz-client.js';

const pgUrl = process.env.TEST_DATABASE_URL;
// The whole suite needs Redis (send() → BullMQ). Gate on BOTH.
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

/** Fake jambonz client capturing originate calls + a programmable outcome. */
class FakeJambonzClient {
  public calls: OriginateCallInput[] = [];
  public nextSid = 'jb-call-sid-1';
  public throwReason: string | null = null;
  async originateCall(input: OriginateCallInput): Promise<{ callSid: string }> {
    this.calls.push(input);
    if (this.throwReason) throw new Error(this.throwReason);
    return { callSid: this.nextSid };
  }
  get voiceWsUrl(): string {
    return 'ws://pipecat/voice/ws';
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
  });

  afterEach(async () => {
    // Drain any agent_messages the dispatcher enqueued to keep Redis clean
    // between cases (the prefix is unique per suite, so this is belt+braces).
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`).catch(() => {});
  });

  function newAgent(client: FakeJambonzClient | null): TestableVoiceOperator {
    return new TestableVoiceOperator({
      role: 'voice-operator',
      instanceId: 'singleton',
      model: 'sonnet',
      queues: ['voice'],
      db,
      jambonzClient: client as unknown as JambonzClient | null,
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

  it('originates a call and emits VOICE.CALL_STARTED + audit on success', async () => {
    const customerId = await seedCustomer('+33611223344');
    const fake = new FakeJambonzClient();
    const agent = newAgent(fake);

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33600000000'));
    expect(result).toMatchObject({ ok: true, result: { started: true } });

    // Resolved the DB phone (not the stale intent toNumber).
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.to).toBe('+33611223344');
    expect(fake.calls[0]!.metadata.callId).toBe(CALL_ID);
    expect(fake.calls[0]!.metadata.customerId).toBe(customerId);

    // VOICE.CALL_STARTED emitted.
    const msgs = await db.select().from(agentMessages);
    const started = msgs.find((m) => m.intent === 'VOICE.CALL_STARTED');
    expect(started).toBeDefined();
    expect(started?.correlationId).toBe(CALL_ID);
    expect((started?.payload as { customerId: string }).customerId).toBe(customerId);

    // Audit row written — records the customerId, never the phone.
    const audits = await db.select().from(auditLog);
    const row = audits.find((a) => a.action === 'voice.call.originated');
    expect(row).toBeDefined();
    expect(row?.targetId).toBe(customerId);
    expect((row?.after as { jambonzCallSid: string }).jambonzCallSid).toBe('jb-call-sid-1');
    // PII guard: the audit must not contain the phone number anywhere.
    expect(JSON.stringify(row)).not.toContain('+33611223344');
  });

  it('falls back to the intent toNumber when the customer has no DB phone', async () => {
    const customerId = await seedCustomer(null);
    const fake = new FakeJambonzClient();
    const agent = newAgent(fake);

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33655555555'));
    expect(result).toMatchObject({ ok: true, result: { started: true } });
    expect(fake.calls[0]!.to).toBe('+33655555555');
  });

  it('emits VOICE.CALL_FAILED with the reason when originateCall throws', async () => {
    const customerId = await seedCustomer('+33611223344');
    const fake = new FakeJambonzClient();
    fake.throwReason = 'jambonz_create_call_failed_503';
    const agent = newAgent(fake);

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33600000000'));
    // Handler returns ok (the message was handled; we don't retry a bad call).
    expect(result).toMatchObject({ ok: true, result: { failed: true } });

    const msgs = await db.select().from(agentMessages);
    const failed = msgs.find((m) => m.intent === 'VOICE.CALL_FAILED');
    expect(failed).toBeDefined();
    expect((failed?.payload as { reason: string }).reason).toBe('jambonz_create_call_failed_503');

    const audits = await db.select().from(auditLog);
    expect(audits.find((a) => a.action === 'voice.call.failed')).toBeDefined();
  });

  it('emits VOICE.CALL_FAILED (no audit) when the jambonz client is disabled', async () => {
    const customerId = await seedCustomer('+33611223344');
    const agent = newAgent(null); // injected null = origination disabled

    const result = await agent.handle(envelope(CALL_ID, customerId, '+33600000000'));
    expect(result).toMatchObject({
      ok: true,
      result: { failed: true, reason: 'jambonz_disabled_no_env' },
    });

    const msgs = await db.select().from(agentMessages);
    expect(msgs.find((m) => m.intent === 'VOICE.CALL_FAILED')).toBeDefined();
    // Config gap → no audit noise.
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it('ignores non-VOICE.CALL_SCHEDULED intents', async () => {
    const agent = newAgent(new FakeJambonzClient());
    const env = {
      ...envelope(CALL_ID, '22222222-2222-4222-b222-222222222222', '+33600000000'),
      intent: 'VOICE.CALL_STARTED',
    } as AgentMessageEnvelope;
    const result = await agent.handle(env);
    expect(result).toMatchObject({ ok: true, result: { skipped: 'unhandled-intent' } });
  });
});
