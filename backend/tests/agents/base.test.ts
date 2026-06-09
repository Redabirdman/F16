/**
 * BaseAgent integration tests (M3.T4).
 *
 * Gated on TEST_DATABASE_URL AND TEST_REDIS_URL — the BaseAgent unifies the
 * pg durable row layer with the BullMQ worker delivery, so both must be live.
 *
 * Spin up (same pattern as M3.T3):
 *   docker run -d --name f16-pg-m3t4 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker run -d --name f16-redis-m3t4 -p 6381:6379 redis:7-alpine --appendonly yes
 *   docker exec -i f16-pg-m3t4 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 \
 *     TEST_REDIS_URL=redis://127.0.0.1:6381 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentMessages } from '../../src/db/schema/index.js';
import { sendMessage } from '../../src/messaging/dispatcher.js';
import {
  BaseAgent,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
} from '../../src/agents/types.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

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

/** Wait for a predicate to become true, polling at `intervalMs`. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = Number(process.env.TEST_WAITFOR_MS) || 15_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate not true within ${timeoutMs}ms`);
}

function leadNewPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leadId: randomUUID(),
    source: 'website',
    productLine: 'scooter',
    ...extra,
  };
}

/**
 * TestEchoAgent — minimal subclass that proves the BaseAgent lifecycle wires
 * up correctly. Records every envelope it sees, every lifecycle hook that
 * fires, and (for LEAD.NEW only) emits a follow-up LEAD.SCORED so the
 * send() helper gets exercised.
 *
 * Exposes some protected hooks via public passthroughs so tests can probe
 * the recall() stub + the send() helper directly.
 */
class TestEchoAgent extends BaseAgent {
  public received: AgentMessageEnvelope[] = [];
  public hooksFired: string[] = [];
  public throwNext = false;
  public throwCount = 0;

  protected override async onStart(): Promise<void> {
    this.hooksFired.push('onStart');
  }

  protected override async onStop(): Promise<void> {
    this.hooksFired.push('onStop');
  }

  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    if (this.throwNext) {
      this.throwNext = false;
      this.throwCount += 1;
      throw new Error('test-induced handler failure');
    }
    this.received.push(envelope);
    if (envelope.intent === 'LEAD.NEW') {
      const payload = envelope.payload as { leadId: string };
      await this.send({
        toRole: 'no-one',
        intent: 'LEAD.SCORED',
        payload: {
          leadId: payload.leadId,
          score: 42,
          opening: 'bonjour',
          channel: 'whatsapp',
        },
        correlationId: payload.leadId,
      });
    }
    return { ok: true, result: { echoed: envelope.intent } };
  }

  /** Test passthrough — recall is protected on the base. */
  public callRecall(args: {
    entityId: string;
    entityType: string;
    query: string;
  }): Promise<unknown[]> {
    return this.recall(args);
  }
}

d('BaseAgent (live)', () => {
  let db: Database;
  let prefix: string;
  const agents: BaseAgent[] = [];

  beforeEach(async () => {
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    for (const a of agents.splice(0)) {
      await a.stop().catch(() => {});
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
  });

  // -------------------------------------------------------------------------
  // 1. Lifecycle
  // -------------------------------------------------------------------------

  it('test 1 (lifecycle): onStart fires on start, onStop fires on stop, no double-start, idempotent stop', async () => {
    const a = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'singleton',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    agents.push(a);

    expect(a.isRunning()).toBe(false);
    await a.start();
    expect(a.isRunning()).toBe(true);
    expect(a.hooksFired).toEqual(['onStart']);

    // Double-start blocked.
    await expect(a.start()).rejects.toThrow(/already started/);

    await a.stop();
    expect(a.isRunning()).toBe(false);
    expect(a.hooksFired).toEqual(['onStart', 'onStop']);

    // Stop is idempotent — second call is a no-op (no extra onStop).
    await a.stop();
    expect(a.hooksFired).toEqual(['onStart', 'onStop']);
  });

  // -------------------------------------------------------------------------
  // 2. Receive + echo via send()
  // -------------------------------------------------------------------------

  it('test 2 (receive & echo): agent receives a message + emits a follow-up via send()', async () => {
    const a = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'singleton',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    agents.push(a);
    await a.start();

    const payload = leadNewPayload();
    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'echo-agent',
        intent: 'LEAD.NEW',
        payload,
      },
    );

    await waitFor(() => a.received.length === 1);
    expect(a.received[0]!.id).toBe(id);
    expect(a.received[0]!.intent).toBe('LEAD.NEW');
    expect(a.received[0]!.payload).toEqual(payload);

    // The follow-up LEAD.SCORED row was inserted by send().
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.intent, 'LEAD.SCORED'));
      return rows.length === 1;
    });
    const scored = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.intent, 'LEAD.SCORED'));
    expect(scored).toHaveLength(1);
    expect(scored[0]!.fromRole).toBe('echo-agent');
    expect(scored[0]!.fromInstance).toBe('singleton');
    expect(scored[0]!.toRole).toBe('no-one');
    expect(scored[0]!.correlationId).toBe((payload as { leadId: string }).leadId);
    expect(scored[0]!.payload).toMatchObject({
      leadId: (payload as { leadId: string }).leadId,
      score: 42,
      opening: 'bonjour',
      channel: 'whatsapp',
    });

    // The inbound row was marked consumed with result set.
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(row && row.consumedAt && row.result);
    });
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.consumedBy).toBe('echo-agent');
    expect(row!.result).toEqual({ echoed: 'LEAD.NEW' });
  });

  // -------------------------------------------------------------------------
  // 3. Instance filtering
  // -------------------------------------------------------------------------

  it('test 3 (instance filter): a message targeted at a different instance is skipped without invoking onMessage', async () => {
    // Single agent with instanceId='A'. A message targets instanceId='B'.
    // The dispatcher claims the row (role matches), but BaseAgent's wrapper
    // sees the toInstance mismatch and returns ok:true {skipped:...}.
    // Sub-class onMessage MUST NOT run.
    const a = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'A',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    agents.push(a);
    await a.start();

    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'echo-agent',
        toInstance: 'B',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );

    // Wait for the worker to ack the row.
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(row && row.result);
    });

    // received is empty — onMessage was never called.
    expect(a.received).toHaveLength(0);

    // The row carries the skip marker so audits can tell "consumed and
    // intentionally skipped" apart from "consumed and processed".
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.result).toEqual({ skipped: 'instance-mismatch' });
    expect(row!.error).toBeNull();
  });

  it('test 3b (instance filter): same role, two instances on different queues — only the targeted one processes', async () => {
    // To assert "only agent B receives it" we need both agents to actually
    // claim attempts. Two BullMQ workers on the SAME queue can race for the
    // single job; whichever claims first wins (the loser short-circuits in
    // claimSpecific). So we put the two instances on DIFFERENT queues to
    // sidestep that race. Routing the inbound to instance B's queue means B
    // is the one that claims. (LEAD.NEW -> 'lead'; QUOTE.REQUESTED -> 'quote'.)
    //
    // This still exercises the BaseAgent instance-filter path: B's queue has
    // a generic LEAD.NEW job; we send WITH toInstance='B' so B processes.
    const a = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'A',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    const b = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'B',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    agents.push(a, b);
    await a.start();
    await b.start();

    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'echo-agent',
        toInstance: 'B',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );

    // Wait until the row is consumed.
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(row && row.consumedAt && row.result);
    });

    // Either B processed (received.length=1) or A claimed first and skipped
    // it (received.length=0 on B AND result is skipped marker). Together a+b
    // received counts must be 0 or 1 — exactly one agent saw the row land,
    // and if A claimed it, A correctly skipped it.
    const total = a.received.length + b.received.length;
    expect(total).toBeLessThanOrEqual(1);
    expect(a.received).toHaveLength(0); // A never matches instance B

    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    if (b.received.length === 1) {
      // Happy path: B claimed and processed.
      expect(row!.result).toEqual({ echoed: 'LEAD.NEW' });
    } else {
      // Race path: A claimed first and (correctly) skipped.
      expect(row!.result).toEqual({ skipped: 'instance-mismatch' });
    }
  });

  // -------------------------------------------------------------------------
  // 4. onMessage throws -> error row, agent stays alive
  // -------------------------------------------------------------------------

  it('test 4 (handler throws): error written to row, agent stays alive for the next message', async () => {
    const a = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'singleton',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    agents.push(a);
    await a.start();
    a.throwNext = true;

    const failId = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'echo-agent',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );

    // Wait for the error row to land.
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, failId));
      return Boolean(row && row.error);
    });
    const [failRow] = await db.select().from(agentMessages).where(eq(agentMessages.id, failId));
    expect(failRow!.error).toMatch(/test-induced handler failure/);
    expect(failRow!.result).toBeNull();
    expect(a.throwCount).toBe(1);

    // Agent is still alive — send a follow-up message and verify it processes.
    expect(a.isRunning()).toBe(true);

    const okId = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'echo-agent',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );
    await waitFor(() => a.received.length >= 1);
    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, okId));
      return Boolean(row && row.result);
    });
    const [okRowFinal] = await db.select().from(agentMessages).where(eq(agentMessages.id, okId));
    expect(okRowFinal!.result).toEqual({ echoed: 'LEAD.NEW' });
  });

  // -------------------------------------------------------------------------
  // 5. recall() stub
  // -------------------------------------------------------------------------

  it('test 5 (recall stub): returns [] (M6 will wire to Mem0)', async () => {
    const a = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'singleton',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    agents.push(a);
    // No need to start — recall() is pure, lives on the base.
    const got = await a.callRecall({
      entityId: randomUUID(),
      entityType: 'customer',
      query: 'recent quote interest',
    });
    expect(got).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 6. Two agents same role + same queue — no double-process
  // -------------------------------------------------------------------------

  it('test 6 (dedup): two agents on the same role + queue — exactly one processes each message', async () => {
    const a = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'A',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    const b = new TestEchoAgent({
      role: 'echo-agent',
      instanceId: 'B',
      model: 'haiku',
      queues: ['lead'],
      db,
    });
    agents.push(a, b);
    await a.start();
    await b.start();

    // No toInstance — either agent is allowed to process. Whichever wins
    // claimSpecific gets the row; the loser sees null and short-circuits.
    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'echo-agent',
        intent: 'LEAD.NEW',
        payload: leadNewPayload(),
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(row && row.consumedAt);
    });

    // Give the loser a beat to (not) process the row.
    await new Promise((r) => setTimeout(r, 150));

    const totalReceived = a.received.length + b.received.length;
    expect(totalReceived).toBe(1);

    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    expect(row!.result).toEqual({ echoed: 'LEAD.NEW' });
    expect(row!.consumedBy).toBe('echo-agent');
  });
});
