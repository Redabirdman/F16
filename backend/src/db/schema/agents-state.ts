/**
 * agents_state — runtime registry visibility table (M3.T7, design §14).
 *
 * Tracks every (role, instance_id) the in-process registry has ever spawned.
 * The registry upserts on spawn() and updates the status column through the
 * starting → running → stopping → stopped (or → crashed) lifecycle. The admin
 * UI (M14) reads this to render "what is alive right now" without needing a
 * round trip to the worker processes.
 *
 * Heartbeat:
 *   `last_heartbeat_at` defaults to now() and is refreshed by heartbeat() at
 *   the registry layer. Agents that should be 'running' but whose heartbeat
 *   is stale are presumed crashed/wedged — the admin surfaces this. M3 ships
 *   only the column + update path; the periodic ping from BaseAgent is
 *   deferred to M14 when the admin actually consumes the signal.
 *
 * Primary key:
 *   (role, instance_id) — a singleton role has a fixed instanceId ('singleton'
 *   by convention) and so re-spawning it upserts the same row. Multi-instance
 *   roles (Sales Agent per lead, etc.) get distinct instanceIds.
 *
 * No FK to anything — `role` is the same open-ended namespace used in
 * agent_messages.to_role; a row here without a matching agent class registered
 * just means the class hasn't been registered yet (cold start, or a stale row
 * left over from a previous process). The registry treats agents_state as a
 * shadow of in-memory state, never as the source of truth.
 */
import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { agentStatusEnum } from './_enums.js';

export const agentsState = pgTable(
  'agents_state',
  {
    role: text('role').notNull(),
    instanceId: text('instance_id').notNull(),
    model: text('model').notNull(),
    queue: text('queue').notNull(),
    status: agentStatusEnum('status').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).defaultNow().notNull(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.role, t.instanceId] }),
    index('agents_state_status_idx').on(t.status),
    index('agents_state_role_idx').on(t.role),
    index('agents_state_last_heartbeat_idx').on(sql`${t.lastHeartbeatAt} DESC`),
  ],
);

export type AgentStateRow = typeof agentsState.$inferSelect;
export type NewAgentStateRow = typeof agentsState.$inferInsert;
