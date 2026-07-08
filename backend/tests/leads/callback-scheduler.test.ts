/**
 * Paid-lead callback scheduler tests (M12).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL (the emit goes through BullMQ).
 * Drives `runCallbackTick` directly for determinism.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages, leads } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';
import { runCallbackTick, runFollowupTick } from '../../src/leads/callback-scheduler.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const d = describe.skipIf(!(pgUrl && redisUrl));

let savedPiiKey: string | undefined;
let savedRedisUrl: string | undefined;
let savedPrefix: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY)
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
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

d('runCallbackTick (live)', () => {
  let db: Database;

  beforeEach(async () => {
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    __resetForTests();
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
  });
  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  async function seedLead(opts: {
    phone: string | null;
    dueAt: Date;
    state: 'pending';
  }): Promise<{ leadId: string; customerId: string }> {
    const customer = await insertCustomer(db, {
      fullName: 'Prospect',
      phone: opts.phone,
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'meta',
        productLine: 'scooter',
        status: 'new',
        preferredChannel: 'call',
        preferredTime: 'maintenant',
        callbackDueAt: opts.dueAt,
        callbackState: opts.state,
      })
      .returning();
    return { leadId: lead!.id, customerId: customer.id };
  }

  it('dispatches a due callback → VOICE.CALL_SCHEDULED + state dispatched', async () => {
    // Seed the already-normalized E.164 the webbook path stores (ingestLead
    // normalizes before insertCustomer; insertCustomer itself stores as-given).
    const { leadId, customerId } = await seedLead({
      phone: '+33612345678',
      dueAt: new Date(Date.now() - 60_000),
      state: 'pending',
    });

    const res = await runCallbackTick(db);
    expect(res.emitted).toBe(1);

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.callbackState).toBe('dispatched');

    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.intent).toBe('VOICE.CALL_SCHEDULED');
    expect(msgs[0]!.toRole).toBe('voice-operator');
    const payload = msgs[0]!.payload as { customerId: string; toNumber: string };
    expect(payload.customerId).toBe(customerId);
    expect(payload.toNumber).toBe('+33612345678');
  });

  it('leaves a not-yet-due callback pending', async () => {
    const { leadId } = await seedLead({
      phone: '0612345678',
      dueAt: new Date(Date.now() + 3600_000),
      state: 'pending',
    });
    const res = await runCallbackTick(db);
    expect(res.emitted).toBe(0);
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.callbackState).toBe('pending');
  });

  it('cancels a due callback when the customer has no phone', async () => {
    const { leadId } = await seedLead({
      phone: null,
      dueAt: new Date(Date.now() - 60_000),
      state: 'pending',
    });
    const res = await runCallbackTick(db);
    expect(res.cancelled).toBe(1);
    expect(res.emitted).toBe(0);
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.callbackState).toBe('cancelled');
  });

  it('is idempotent — a second tick emits nothing', async () => {
    await seedLead({ phone: '0612345678', dueAt: new Date(Date.now() - 60_000), state: 'pending' });
    await runCallbackTick(db);
    const second = await runCallbackTick(db);
    expect(second.emitted).toBe(0);
  });

  // ----- timed MESSAGE follow-ups (2026-07-08, « reparlez-moi dans 10 min ») -

  let followupPhoneSeq = 0;
  async function seedFollowupLead(opts: {
    dueAt: Date;
    topic?: string;
  }): Promise<{ leadId: string; customerId: string }> {
    // Unique phone per seeded customer — customers_phone_hash_uniq.
    followupPhoneSeq += 1;
    const customer = await insertCustomer(db, {
      fullName: 'Prospect Followup',
      phone: `+3369876${String(4000 + followupPhoneSeq)}`,
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'meta',
        productLine: 'scooter',
        status: 'qualifying',
        followupDueAt: opts.dueAt,
        followupState: 'pending',
        followupTopic: opts.topic ?? null,
      })
      .returning();
    return { leadId: lead!.id, customerId: customer.id };
  }

  it('dispatches a due follow-up → CUSTOMER.FOLLOWUP_DUE to the sales agent', async () => {
    const { leadId, customerId } = await seedFollowupLead({
      dueAt: new Date(Date.now() - 30_000),
      topic: 'reprendre la qualification',
    });

    const res = await runFollowupTick(db);
    expect(res.emitted).toBe(1);

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.followupState).toBe('dispatched');

    const msgs = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.intent).toBe('CUSTOMER.FOLLOWUP_DUE');
    expect(msgs[0]!.toRole).toBe('sales-agent');
    const payload = msgs[0]!.payload as {
      customerId: string;
      cascadeName: string;
      leadId: string;
      topic?: string;
    };
    expect(payload.customerId).toBe(customerId);
    expect(payload.cascadeName).toBe('timed-followup');
    expect(payload.leadId).toBe(leadId);
    expect(payload.topic).toBe('reprendre la qualification');
  });

  it('leaves a not-yet-due follow-up pending and is idempotent when due', async () => {
    const { leadId } = await seedFollowupLead({ dueAt: new Date(Date.now() + 3600_000) });
    const res = await runFollowupTick(db);
    expect(res.emitted).toBe(0);
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.followupState).toBe('pending');

    await seedFollowupLead({ dueAt: new Date(Date.now() - 30_000) });
    await runFollowupTick(db);
    const second = await runFollowupTick(db);
    expect(second.emitted).toBe(0);
  });
});
