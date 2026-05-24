/**
 * Admin agents endpoints (M15.T2 — backend side).
 *
 *   GET  /v1/admin/agents
 *     List rows from agents_state, newest-started-first. Includes
 *     lifecycle status, model, queue, priority (from meta), last
 *     heartbeat, started_at, stopped_at.
 *
 *   POST /v1/admin/agents/:role/:instanceId/kill
 *     Stops the running instance (calls registry.kill). Idempotent —
 *     killing an already-stopped instance returns 200 with {alreadyStopped}.
 *     Writes an `agents.kill` audit row.
 *
 *   POST /v1/admin/agents/:role/:instanceId/priority
 *     Body: {priority: 0..9}. Calls registry.setPriority. Writes an
 *     `agents.priority.set` audit row.
 *
 * The kill path here is hand-deferred: the registry's `kill()` calls
 * `agent.stop()` which closes the BullMQ workers. The PostgreSQL
 * `agents_state.status` row flips to `stopped` automatically. If the
 * same role+instance is spawned again later (process restart, manual
 * respawn) the registry upserts cleanly.
 */
import { Hono } from 'hono';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { agentsState } from '../db/schema/index.js';
import { kill, setPriority, getInstance } from '../agents/registry.js';
import { appendAudit } from '../db/repositories/audit-log.js';
import { logger } from '../logger.js';

export interface AdminAgentsRouterOptions {
  db: Database;
}

export interface AgentStateRow {
  role: string;
  instanceId: string;
  model: string;
  queue: string;
  status: string;
  priority: number | null;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  error: string | null;
  inMemory: boolean;
}

const PrioritySchema = z.object({
  priority: z.number().int().min(0).max(9),
  by: z.string().optional(),
});

export function buildAdminAgentsRouter(opts: AdminAgentsRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/agents', async (c) => {
    const rows = await opts.db.select().from(agentsState).orderBy(desc(agentsState.startedAt));
    const mapped: AgentStateRow[] = rows.map((r) => {
      const meta = (r.meta as { priority?: number } | null) ?? {};
      const live = getInstance(r.role, r.instanceId);
      return {
        role: r.role,
        instanceId: r.instanceId,
        model: r.model,
        queue: r.queue,
        status: r.status,
        priority: typeof meta.priority === 'number' ? meta.priority : null,
        startedAt: r.startedAt.toISOString(),
        lastHeartbeatAt: r.lastHeartbeatAt.toISOString(),
        stoppedAt: r.stoppedAt ? r.stoppedAt.toISOString() : null,
        error: r.error ?? null,
        inMemory: live !== undefined,
      };
    });
    return c.json({ rows: mapped }, 200);
  });

  app.post('/v1/admin/agents/:role/:instanceId/kill', async (c) => {
    const role = c.req.param('role');
    const instanceId = c.req.param('instanceId');
    const live = getInstance(role, instanceId);
    if (!live) {
      // No live instance — record an audit anyway so the forensic trail
      // shows the operator tried, then return 200 with the no-op flag.
      try {
        await appendAudit(opts.db, {
          actorType: 'human',
          actorId: 'admin-ui',
          action: 'agents.kill',
          targetType: 'agent',
          targetId: `${role}#${instanceId}`,
          meta: { result: 'noop', reason: 'not_in_memory' },
        });
      } catch {
        // non-blocking
      }
      return c.json({ ok: true, alreadyStopped: true }, 200);
    }
    try {
      await kill({ role, instanceId, db: opts.db });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), role, instanceId },
        'admin/agents: kill threw',
      );
      return c.json(
        { error: 'kill_failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
    try {
      await appendAudit(opts.db, {
        actorType: 'human',
        actorId: 'admin-ui',
        action: 'agents.kill',
        targetType: 'agent',
        targetId: `${role}#${instanceId}`,
        meta: { result: 'stopped' },
      });
    } catch {
      // non-blocking
    }
    return c.json({ ok: true, alreadyStopped: false }, 200);
  });

  app.post('/v1/admin/agents/:role/:instanceId/priority', async (c) => {
    const role = c.req.param('role');
    const instanceId = c.req.param('instanceId');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json_body' }, 400);
    }
    const parse = PrioritySchema.safeParse(body);
    if (!parse.success) {
      return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    }
    let newPriority: number | null;
    try {
      newPriority = await setPriority({
        role,
        instanceId,
        db: opts.db,
        priority: parse.data.priority,
      });
    } catch (err) {
      return c.json(
        { error: 'set_priority_failed', detail: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    if (newPriority === null) {
      return c.json({ error: 'agent_not_found' }, 404);
    }
    try {
      await appendAudit(opts.db, {
        actorType: 'human',
        actorId: parse.data.by ?? 'admin-ui',
        action: 'agents.priority.set',
        targetType: 'agent',
        targetId: `${role}#${instanceId}`,
        after: { priority: newPriority },
      });
    } catch {
      // non-blocking
    }
    return c.json({ ok: true, priority: newPriority }, 200);
  });

  return app;
}
