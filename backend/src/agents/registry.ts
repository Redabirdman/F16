/**
 * Agent registry (M3.T7) — the runtime supervisor for long-running agent
 * classes (Sales Agent, Maxance Operator, Lead Scorer, …).
 *
 * Responsibilities:
 *   1. Catalog of known agent CLASSES (factories registered at module load).
 *   2. Lifecycle for INSTANCES — spawn, kill, killAll, heartbeat.
 *   3. Shadow the runtime in the `agents_state` table for admin visibility.
 *
 * The in-memory map is the source of truth for "what is alive right now". The
 * agents_state row is a strictly-after side effect: every state transition
 * here is reflected back to pg, but a desync (process crash mid-spawn, db
 * blip mid-update) never wedges the registry. Re-spawning a (role, instanceId)
 * after such a desync simply upserts the row with the new lifecycle.
 *
 * Multi-process note:
 *   The map is per-process. Two backend processes that both register the
 *   same class can each spawn 'X#singleton' — agents_state will whichever
 *   wrote last. That's a known limitation; the topology either elects a
 *   primary (M14) or partitions instanceIds by process. M3 scope is single
 *   process.
 *
 * Test boundary:
 *   `__resetAgentRegistryForTests()` wipes the maps. It does NOT call stop()
 *   on running instances — tests that spawn must kill before resetting.
 */
import { eq, and, sql } from 'drizzle-orm';
import type { BaseAgent } from './base.js';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { agentsState } from '../db/schema/agents-state.js';

/**
 * Factory that, given common dependencies, constructs an agent instance.
 * Subclasses of BaseAgent register their factory under their role name.
 *
 * Example:
 *   registerAgentClass('test-echo', (cfg) => new TestEchoAgent(cfg));
 */
export interface AgentClassFactory<A extends BaseAgent = BaseAgent> {
  (cfg: { instanceId: string; db: Database; meta?: Record<string, unknown> }): A;
}

const _classes = new Map<string, AgentClassFactory>();
const _instances = new Map<string, BaseAgent>(); // key = `${role}#${instanceId}`

function key(role: string, instanceId: string): string {
  return `${role}#${instanceId}`;
}

export function registerAgentClass<A extends BaseAgent>(
  role: string,
  factory: AgentClassFactory<A>,
): void {
  if (_classes.has(role)) {
    throw new Error(`Agent class for role ${role} already registered`);
  }
  _classes.set(role, factory as AgentClassFactory);
}

export function listAgentClasses(): string[] {
  return [..._classes.keys()].sort();
}

export function listRunning(): Array<{ role: string; instanceId: string; agent: BaseAgent }> {
  return [..._instances.entries()].map(([k, agent]) => {
    const [role, instanceId] = k.split('#') as [string, string];
    return { role, instanceId, agent };
  });
}

export function getInstance(role: string, instanceId: string): BaseAgent | undefined {
  return _instances.get(key(role, instanceId));
}

/**
 * Spawn an instance of a registered agent class.
 *
 * Sequence:
 *   1. Validate role is registered and (role, instanceId) is not already live.
 *   2. Construct the instance via the factory.
 *   3. Upsert agents_state with status='starting' (overwriting any prior
 *      'crashed'/'stopped' row for the same key — the latest spawn wins).
 *   4. Await agent.start(). On success, update status='running'.
 *   5. On any failure during steps 2–4 the in-memory entry is rolled back,
 *      the row is updated to status='crashed' with the error message, and
 *      the original error is re-thrown.
 *
 * Note: step 3's upsert runs BEFORE start(), so a row with status='starting'
 * is briefly visible to readers. That's intentional — admin polls reflecting
 * "agent X is starting" is more useful than "we hide it until ready".
 */
export async function spawn(args: {
  role: string;
  instanceId: string;
  db: Database;
  meta?: Record<string, unknown>;
}): Promise<BaseAgent> {
  const factory = _classes.get(args.role);
  if (!factory) throw new Error(`Unknown agent role: ${args.role}`);

  const k = key(args.role, args.instanceId);
  if (_instances.has(k)) {
    throw new Error(`Agent ${k} already running`);
  }

  const agent = factory({
    instanceId: args.instanceId,
    db: args.db,
    ...(args.meta !== undefined ? { meta: args.meta } : {}),
  });
  // Tentatively register so a concurrent spawn() with the same key fails
  // fast on the second check above. We unregister on failure below.
  _instances.set(k, agent);

  try {
    await args.db
      .insert(agentsState)
      .values({
        role: args.role,
        instanceId: args.instanceId,
        model: agent.model,
        queue: agent.queue,
        status: 'starting',
        meta: agent.meta as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [agentsState.role, agentsState.instanceId],
        set: {
          model: agent.model,
          queue: agent.queue,
          status: 'starting',
          startedAt: new Date(),
          stoppedAt: null,
          error: null,
          lastHeartbeatAt: new Date(),
          meta: agent.meta as Record<string, unknown>,
        },
      });

    await agent.start();

    await args.db
      .update(agentsState)
      .set({ status: 'running', lastHeartbeatAt: new Date() })
      .where(and(eq(agentsState.role, args.role), eq(agentsState.instanceId, args.instanceId)));

    logger.info(
      { role: args.role, instanceId: args.instanceId, model: agent.model, queue: agent.queue },
      'agent.spawn ok',
    );
    return agent;
  } catch (err) {
    _instances.delete(k);
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      // Best-effort: mark the row crashed so admin sees what happened. If the
      // upsert above never landed (db blip), this update is a no-op.
      await args.db
        .update(agentsState)
        .set({ status: 'crashed', stoppedAt: new Date(), error: errMsg })
        .where(and(eq(agentsState.role, args.role), eq(agentsState.instanceId, args.instanceId)));
    } catch (cleanupErr) {
      logger.error(
        {
          role: args.role,
          instanceId: args.instanceId,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        },
        'agent.spawn.cleanup-failed',
      );
    }
    logger.error(
      { role: args.role, instanceId: args.instanceId, err: errMsg },
      'agent.spawn failed',
    );
    throw err;
  }
}

/**
 * Kill (stop) an instance. Idempotent — a no-op if the (role, instanceId) is
 * not currently registered. agents_state is moved to 'stopped' regardless,
 * so calling kill() on an already-stopped instance is safe (the row is
 * already 'stopped' or doesn't exist — the update simply matches no rows).
 *
 * If agent.stop() throws, the in-memory entry is still removed and the row
 * is still marked stopped — the registry cannot stay in a half-running state.
 * The original error is re-thrown.
 */
export async function kill(args: {
  role: string;
  instanceId: string;
  db: Database;
}): Promise<void> {
  const k = key(args.role, args.instanceId);
  const agent = _instances.get(k);
  if (!agent) return; // already gone

  await args.db
    .update(agentsState)
    .set({ status: 'stopping' })
    .where(and(eq(agentsState.role, args.role), eq(agentsState.instanceId, args.instanceId)));

  try {
    await agent.stop();
  } finally {
    _instances.delete(k);
    await args.db
      .update(agentsState)
      .set({ status: 'stopped', stoppedAt: new Date(), lastHeartbeatAt: new Date() })
      .where(and(eq(agentsState.role, args.role), eq(agentsState.instanceId, args.instanceId)));
    logger.info({ role: args.role, instanceId: args.instanceId }, 'agent.kill ok');
  }
}

/**
 * Kill every running instance. Used by graceful shutdown. Failures during
 * individual stops are logged but do not stop the loop — every agent that
 * can be stopped should be.
 */
export async function killAll(db: Database): Promise<void> {
  const all = listRunning();
  for (const { role, instanceId } of all) {
    try {
      await kill({ role, instanceId, db });
    } catch (err) {
      logger.error(
        {
          role,
          instanceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'agent.killAll.instance-failed',
      );
    }
  }
}

/**
 * Refresh the heartbeat for one instance. Agents (or a sidecar timer) call
 * this periodically while alive so admin can detect stale 'running' rows.
 * No-op if no row matches — the registry treats agents_state as a shadow.
 */
export async function heartbeat(args: {
  role: string;
  instanceId: string;
  db: Database;
}): Promise<void> {
  await args.db
    .update(agentsState)
    .set({ lastHeartbeatAt: new Date() })
    .where(and(eq(agentsState.role, args.role), eq(agentsState.instanceId, args.instanceId)));
}

/**
 * Adjust the runtime priority of an instance (M15.T2). Persisted in
 * `agents_state.meta.priority` as a small integer 0 (highest) to 9
 * (lowest). The in-memory `BaseAgent` instance also reflects the
 * change via `agent.meta.priority` so any future queue/concurrency
 * logic can read it without round-tripping to pg.
 *
 * Migration-free: we use the existing meta jsonb column rather than
 * adding a dedicated priority column. Reads stay normal Drizzle; writes
 * merge the new key into existing meta via Postgres' jsonb concat.
 *
 * No-op when (role, instanceId) is not registered — same shadow semantics
 * as the other lifecycle helpers. Returns the new priority on success or
 * null on no-op.
 */
export async function setPriority(args: {
  role: string;
  instanceId: string;
  db: Database;
  priority: number;
}): Promise<number | null> {
  if (!Number.isInteger(args.priority) || args.priority < 0 || args.priority > 9) {
    throw new Error(`setPriority: priority must be an integer 0..9, got ${args.priority}`);
  }
  const k = key(args.role, args.instanceId);
  const inMemory = _instances.get(k);
  if (inMemory) {
    (inMemory as unknown as { meta: Record<string, unknown> }).meta = {
      ...inMemory.meta,
      priority: args.priority,
    };
  }
  // jsonb merge — preserves any other meta keys (e.g. leadId).
  const res = await args.db.execute(
    sql`UPDATE agents_state
        SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('priority', ${args.priority}::int)
        WHERE role = ${args.role} AND instance_id = ${args.instanceId}
        RETURNING (meta ->> 'priority')::int AS new_priority`,
  );
  const row = (res as unknown as Array<{ new_priority: number }>)[0];
  if (!row) {
    logger.warn(
      { role: args.role, instanceId: args.instanceId },
      'setPriority: no agents_state row matched',
    );
    return null;
  }
  logger.info(
    { role: args.role, instanceId: args.instanceId, priority: args.priority },
    'agent.priority.set',
  );
  return row.new_priority;
}

/**
 * Test-only: clear the registry maps. Does NOT call stop() on running agents
 * — callers that spawned anything are responsible for killing it first.
 * Safe to call from afterEach without worrying about pg state.
 */
export function __resetAgentRegistryForTests(): void {
  _classes.clear();
  _instances.clear();
}
