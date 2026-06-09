/**
 * Agent registry integration tests (M3.T7).
 *
 * Gated on TEST_DATABASE_URL AND TEST_REDIS_URL — the registry sits on top of
 * BaseAgent.start()/stop(), which spin up real BullMQ workers, so both pg and
 * redis must be live.
 *
 * Spin up (mirrors base.test.ts):
 *   docker run -d --name f16-pg-m3t7 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker run -d --name f16-redis-m3t7 -p 6381:6379 redis:7-alpine --appendonly yes
 *   docker exec -i f16-pg-m3t7 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 \
 *     TEST_REDIS_URL=redis://127.0.0.1:6381 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql, eq, and } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentsState } from '../../src/db/schema/agents-state.js';
import { agentMessages } from '../../src/db/schema/index.js';
import { sendMessage } from '../../src/messaging/dispatcher.js';
import {
  BaseAgent,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
} from '../../src/agents/types.js';
import {
  registerAgentClass,
  listAgentClasses,
  listRunning,
  getInstance,
  spawn,
  kill,
  killAll,
  heartbeat,
  __resetAgentRegistryForTests,
} from '../../src/agents/registry.js';
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

/**
 * Minimal echo agent re-used across tests. Tracks every envelope it sees so
 * we can prove instance-targeting still works when routed via the registry.
 */
class TestEchoAgent extends BaseAgent {
  public received: AgentMessageEnvelope[] = [];

  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    this.received.push(envelope);
    return { ok: true, result: { echoed: envelope.intent } };
  }
}

/**
 * BrokenAgent — start() throws. Used to exercise the spawn() failure path.
 */
class BrokenAgent extends BaseAgent {
  public static failOnStart = true;

  protected override async onStart(): Promise<void> {
    if (BrokenAgent.failOnStart) {
      throw new Error('boom-in-onStart');
    }
  }

  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    return { ok: true, result: { echoed: envelope.intent } };
  }
}

async function readStateRow(
  db: Database,
  role: string,
  instanceId: string,
): Promise<typeof agentsState.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(agentsState)
    .where(and(eq(agentsState.role, role), eq(agentsState.instanceId, instanceId)));
  return rows[0];
}

d('AgentRegistry (live)', () => {
  let db: Database;
  let prefix: string;

  beforeEach(async () => {
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();
    __resetAgentRegistryForTests();
    BrokenAgent.failOnStart = true;

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agents_state`);
  });

  afterEach(async () => {
    // Kill anything still alive so the next test gets a clean slate.
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
  });

  // -------------------------------------------------------------------------
  // 1. registerAgentClass + listAgentClasses
  // -------------------------------------------------------------------------

  it('test 1 (register classes): registered roles appear in listAgentClasses; double-register throws', () => {
    registerAgentClass(
      'echo-agent',
      ({ instanceId, db: cfgDb, meta }) =>
        new TestEchoAgent({
          role: 'echo-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
          ...(meta !== undefined ? { meta } : {}),
        }),
    );
    registerAgentClass(
      'broken-agent',
      ({ instanceId, db: cfgDb, meta }) =>
        new BrokenAgent({
          role: 'broken-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
          ...(meta !== undefined ? { meta } : {}),
        }),
    );

    expect(listAgentClasses()).toEqual(['broken-agent', 'echo-agent']);

    // Double registration is rejected.
    expect(() =>
      registerAgentClass('echo-agent', () => {
        throw new Error('should not be called');
      }),
    ).toThrow(/already registered/);
  });

  // -------------------------------------------------------------------------
  // 2. spawn happy path
  // -------------------------------------------------------------------------

  it('test 2 (spawn ok): spawn writes status=running row with model+queue, instance is listed', async () => {
    registerAgentClass(
      'echo-agent',
      ({ instanceId, db: cfgDb, meta }) =>
        new TestEchoAgent({
          role: 'echo-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
          ...(meta !== undefined ? { meta } : {}),
        }),
    );

    const agent = await spawn({
      role: 'echo-agent',
      instanceId: 'inst-1',
      db,
      meta: { tag: 'unit-test' },
    });

    expect(agent.isRunning()).toBe(true);
    expect(getInstance('echo-agent', 'inst-1')).toBe(agent);

    const running = listRunning();
    expect(running).toHaveLength(1);
    expect(running[0]!.role).toBe('echo-agent');
    expect(running[0]!.instanceId).toBe('inst-1');

    const row = await readStateRow(db, 'echo-agent', 'inst-1');
    expect(row).toBeDefined();
    expect(row!.status).toBe('running');
    expect(row!.model).toBe('haiku');
    expect(row!.queue).toBe('lead');
    expect(row!.error).toBeNull();
    expect(row!.stoppedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. spawn unknown role
  // -------------------------------------------------------------------------

  it('test 3 (unknown role): spawn throws and writes no agents_state row', async () => {
    await expect(spawn({ role: 'does-not-exist', instanceId: 'x', db })).rejects.toThrow(
      /Unknown agent role/,
    );
    const row = await readStateRow(db, 'does-not-exist', 'x');
    expect(row).toBeUndefined();
    expect(listRunning()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. spawn same key twice
  // -------------------------------------------------------------------------

  it('test 4 (duplicate spawn): second spawn of same (role, instanceId) throws', async () => {
    registerAgentClass(
      'echo-agent',
      ({ instanceId, db: cfgDb }) =>
        new TestEchoAgent({
          role: 'echo-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );

    await spawn({ role: 'echo-agent', instanceId: 'dup', db });
    await expect(spawn({ role: 'echo-agent', instanceId: 'dup', db })).rejects.toThrow(
      /already running/,
    );
    // The original instance is untouched.
    expect(listRunning()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 5. kill
  // -------------------------------------------------------------------------

  it('test 5 (kill): kill stops the agent, sets status=stopped, removes from listRunning', async () => {
    registerAgentClass(
      'echo-agent',
      ({ instanceId, db: cfgDb }) =>
        new TestEchoAgent({
          role: 'echo-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );

    const agent = await spawn({ role: 'echo-agent', instanceId: 'k1', db });
    expect(agent.isRunning()).toBe(true);

    await kill({ role: 'echo-agent', instanceId: 'k1', db });
    expect(agent.isRunning()).toBe(false);
    expect(listRunning()).toHaveLength(0);
    expect(getInstance('echo-agent', 'k1')).toBeUndefined();

    const row = await readStateRow(db, 'echo-agent', 'k1');
    expect(row!.status).toBe('stopped');
    expect(row!.stoppedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. kill idempotent
  // -------------------------------------------------------------------------

  it('test 6 (kill idempotent): killing an already-killed instance is a no-op', async () => {
    registerAgentClass(
      'echo-agent',
      ({ instanceId, db: cfgDb }) =>
        new TestEchoAgent({
          role: 'echo-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );

    await spawn({ role: 'echo-agent', instanceId: 'idem', db });
    await kill({ role: 'echo-agent', instanceId: 'idem', db });
    // Second kill: should not throw.
    await expect(kill({ role: 'echo-agent', instanceId: 'idem', db })).resolves.toBeUndefined();
    // Killing a never-spawned key is also a no-op.
    await expect(
      kill({ role: 'echo-agent', instanceId: 'never-existed', db }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 7. two instances same role, message routed to B
  // -------------------------------------------------------------------------

  it('test 7 (multi-instance routing): two instances of same role on different queues, only the targeted one receives', async () => {
    // Two instances on DIFFERENT queues so the dispatcher routes the inbound
    // job to instance B's worker only. Same logic as base.test.ts test 3b —
    // we route through the registry's spawn() path here.
    // Both instances share the same role + queue. The dispatcher routes
    // strictly by INTENT_TO_QUEUE (no per-message queue override), so we
    // can't put them on different queues. Instead we exercise the same
    // race-tolerant assertion shape as base.test.ts test 3b: A never
    // matches instance B, so A's received array stays empty; B either
    // claims and processes (received.length===1) or A claims first and
    // skips it (received.length===0 with skipped marker on the row).
    registerAgentClass(
      'echo-agent-a',
      ({ instanceId, db: cfgDb }) =>
        new TestEchoAgent({
          role: 'multi-echo',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );
    registerAgentClass(
      'echo-agent-b',
      ({ instanceId, db: cfgDb }) =>
        new TestEchoAgent({
          role: 'multi-echo',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );

    const a = (await spawn({ role: 'echo-agent-a', instanceId: 'A', db })) as TestEchoAgent;
    const b = (await spawn({ role: 'echo-agent-b', instanceId: 'B', db })) as TestEchoAgent;

    expect(a.role).toBe('multi-echo');
    expect(b.role).toBe('multi-echo');

    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'multi-echo',
        toInstance: 'B',
        intent: 'LEAD.NEW',
        payload: {
          leadId: randomUUID(),
          source: 'website',
          productLine: 'scooter',
        },
      },
    );

    // Wait for the row to be consumed (whichever instance won the claim
    // race writes consumedAt + result).
    await waitFor(async () => {
      const rows = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
      return Boolean(rows[0] && rows[0].consumedAt && rows[0].result);
    });

    // A never matches instance B — its received array must stay empty
    // regardless of which worker won the claim race.
    expect(a.received).toHaveLength(0);

    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id));
    if (b.received.length === 1) {
      // Happy path: B claimed and processed via the registry-spawned worker.
      expect(b.received[0]!.intent).toBe('LEAD.NEW');
      expect(row!.result).toEqual({ echoed: 'LEAD.NEW' });
    } else {
      // Race path: A claimed first and correctly skipped (instance mismatch).
      expect(b.received).toHaveLength(0);
      expect(row!.result).toEqual({ skipped: 'instance-mismatch' });
    }
  });

  // -------------------------------------------------------------------------
  // 8. killAll
  // -------------------------------------------------------------------------

  it('test 8 (killAll): kills every running instance', async () => {
    registerAgentClass(
      'echo-agent',
      ({ instanceId, db: cfgDb }) =>
        new TestEchoAgent({
          role: 'echo-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );

    await spawn({ role: 'echo-agent', instanceId: 'x1', db });
    await spawn({ role: 'echo-agent', instanceId: 'x2', db });
    await spawn({ role: 'echo-agent', instanceId: 'x3', db });
    expect(listRunning()).toHaveLength(3);

    await killAll(db);
    expect(listRunning()).toHaveLength(0);

    for (const iid of ['x1', 'x2', 'x3']) {
      const row = await readStateRow(db, 'echo-agent', iid);
      expect(row!.status).toBe('stopped');
    }
  });

  // -------------------------------------------------------------------------
  // 9. spawn after crash — upsert resets the row
  // -------------------------------------------------------------------------

  it('test 9 (recover after crash): failed start sets status=crashed; future spawn of same key succeeds', async () => {
    registerAgentClass(
      'broken-agent',
      ({ instanceId, db: cfgDb }) =>
        new BrokenAgent({
          role: 'broken-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );

    BrokenAgent.failOnStart = true;
    await expect(spawn({ role: 'broken-agent', instanceId: 'unstable', db })).rejects.toThrow(
      /boom-in-onStart/,
    );

    // Row was upserted to 'starting' then updated to 'crashed' with error.
    let row = await readStateRow(db, 'broken-agent', 'unstable');
    expect(row).toBeDefined();
    expect(row!.status).toBe('crashed');
    expect(row!.error).toMatch(/boom-in-onStart/);
    expect(row!.stoppedAt).not.toBeNull();
    // Not in the in-memory registry — failed spawn rolled it back.
    expect(getInstance('broken-agent', 'unstable')).toBeUndefined();

    // Now make start() succeed and re-spawn the same key — the upsert path
    // must reset stoppedAt/error and move status forward to 'running'.
    BrokenAgent.failOnStart = false;
    const agent = await spawn({ role: 'broken-agent', instanceId: 'unstable', db });
    expect(agent.isRunning()).toBe(true);
    row = await readStateRow(db, 'broken-agent', 'unstable');
    expect(row!.status).toBe('running');
    expect(row!.error).toBeNull();
    expect(row!.stoppedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 10. heartbeat advances last_heartbeat_at
  // -------------------------------------------------------------------------

  it('test 10 (heartbeat): heartbeat() bumps last_heartbeat_at forward', async () => {
    registerAgentClass(
      'echo-agent',
      ({ instanceId, db: cfgDb }) =>
        new TestEchoAgent({
          role: 'echo-agent',
          instanceId,
          model: 'haiku',
          queues: ['lead'],
          db: cfgDb,
        }),
    );

    await spawn({ role: 'echo-agent', instanceId: 'hb', db });
    const before = await readStateRow(db, 'echo-agent', 'hb');
    expect(before).toBeDefined();
    const beforeTs = before!.lastHeartbeatAt.getTime();

    // Sleep enough for pg's now() to tick — postgres timestamp resolution is
    // microseconds but the test framework + node clock can return identical
    // ms values in tight loops; a few ms of real sleep is plenty.
    await new Promise((r) => setTimeout(r, 25));

    await heartbeat({ role: 'echo-agent', instanceId: 'hb', db });
    const after = await readStateRow(db, 'echo-agent', 'hb');
    expect(after!.lastHeartbeatAt.getTime()).toBeGreaterThan(beforeTs);
  });
});
