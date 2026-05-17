/**
 * agent_messages repository — the inter-agent bus.
 *
 * Two-phase lifecycle:
 *   1. enqueue() — caller publishes an intent + payload addressed to a role.
 *      The INSERT trigger fires NOTIFY on `agent_messages_channel`, waking
 *      any listening worker. Idle workers can also `claimNext()` on a poll.
 *   2. claimNext() — atomically marks the highest-priority oldest pending
 *      row for the given role as consumed (FOR UPDATE SKIP LOCKED), returns
 *      it to the worker. Concurrent workers never grab the same row.
 *
 * Result vs error:
 *   markResult() and markError() are terminal — both write the outcome
 *   onto the already-consumed row. The workflow layer (M3) decides whether
 *   to retry by enqueuing a fresh message; this repo never resurrects a
 *   consumed row.
 *
 * Why SKIP LOCKED:
 *   The naive "SELECT ... FOR UPDATE" would serialize all consumers behind
 *   the same row. SKIP LOCKED lets each consumer skip rows already locked
 *   by a peer, so N workers process N distinct rows concurrently with zero
 *   coordination. Standard pg-job-queue pattern.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { agentMessages } from '../schema/index.js';
import type { AgentMessage, NewAgentMessage } from '../schema/agent-runtime.js';

/**
 * Insert a fresh message. The DB-side trigger fires NOTIFY immediately;
 * listeners receive `{ id, to_role, to_instance, intent, correlation_id,
 * priority, created_at }` on `agent_messages_channel`.
 */
export async function enqueue(db: Database, msg: NewAgentMessage): Promise<AgentMessage> {
  const [row] = await db.insert(agentMessages).values(msg).returning();
  if (!row) throw new Error('enqueue: insert returned no row');
  return row;
}

/**
 * Atomically claim the next pending message for `toRole`. Uses FOR UPDATE
 * SKIP LOCKED so concurrent consumers never grab the same row. Returns
 * null when the queue is empty.
 *
 * Ordering: priority ASC (0 = critical first), then created_at ASC
 * (oldest within a priority class).
 *
 * `consumedBy` defaults to `${toRole}` if no consumer id is supplied;
 * pass the worker's instance id ("scoring-3") to disambiguate in audits.
 */
export async function claimNext(
  db: Database,
  toRole: string,
  consumedBy?: string,
): Promise<AgentMessage | null> {
  const consumer = consumedBy ?? toRole;

  // Drizzle doesn't model SKIP LOCKED in its query builder, so we drop to
  // raw SQL. The subquery LIMIT 1 + FOR UPDATE SKIP LOCKED is the
  // canonical Postgres job-queue claim pattern.
  const result = (await db.execute(sql`
    UPDATE agent_messages
       SET consumed_at = now(),
           consumed_by = ${consumer}
     WHERE id = (
       SELECT id
         FROM agent_messages
        WHERE to_role = ${toRole}
          AND consumed_at IS NULL
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING
      id,
      from_role        AS "fromRole",
      from_instance    AS "fromInstance",
      to_role          AS "toRole",
      to_instance      AS "toInstance",
      intent,
      payload,
      correlation_id   AS "correlationId",
      requires_human   AS "requiresHuman",
      priority,
      created_at       AS "createdAt",
      consumed_at      AS "consumedAt",
      consumed_by      AS "consumedBy",
      result,
      error
  `)) as unknown as AgentMessage[];

  return result[0] ?? null;
}

/** Write a success result onto a consumed row. Does not unconsume. */
export async function markResult(
  db: Database,
  id: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    UPDATE agent_messages
       SET result = ${JSON.stringify(result)}::jsonb,
           error  = NULL
     WHERE id = ${id}
  `);
}

/** Write a failure onto a consumed row. The workflow layer decides retry. */
export async function markError(db: Database, id: string, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE agent_messages
       SET error  = ${error},
           result = NULL
     WHERE id = ${id}
  `);
}

/**
 * Atomically claim THIS specific row IF it matches `toRole` and is still
 * unconsumed. Returns the claimed row, or null when:
 *   - the id doesn't exist
 *   - the row's to_role doesn't match the claimer (defensive — protects
 *     against a misrouted BullMQ job from leaking into the wrong worker)
 *   - the row was already consumed by someone else
 *
 * Used by the dispatcher: BullMQ delivers messageIds, this UPDATE makes
 * row-claim atomic. Falls under the same SKIP-LOCKED rationale as claimNext
 * but targets a known id instead of "next available".
 */
export async function claimSpecific(
  db: Database,
  messageId: string,
  claimerRole: string,
): Promise<AgentMessage | null> {
  const result = (await db.execute(sql`
    UPDATE agent_messages
       SET consumed_at = now(),
           consumed_by = ${claimerRole}
     WHERE id = ${messageId}
       AND consumed_at IS NULL
       AND to_role = ${claimerRole}
    RETURNING
      id,
      from_role        AS "fromRole",
      from_instance    AS "fromInstance",
      to_role          AS "toRole",
      to_instance      AS "toInstance",
      intent,
      payload,
      correlation_id   AS "correlationId",
      requires_human   AS "requiresHuman",
      priority,
      created_at       AS "createdAt",
      consumed_at      AS "consumedAt",
      consumed_by      AS "consumedBy",
      result,
      error
  `)) as unknown as AgentMessage[];

  return result[0] ?? null;
}

/** Fetch a row by id (read-only). Returns null if not found. */
export async function getById(db: Database, messageId: string): Promise<AgentMessage | null> {
  const result = (await db.execute(sql`
    SELECT
      id,
      from_role        AS "fromRole",
      from_instance    AS "fromInstance",
      to_role          AS "toRole",
      to_instance      AS "toInstance",
      intent,
      payload,
      correlation_id   AS "correlationId",
      requires_human   AS "requiresHuman",
      priority,
      created_at       AS "createdAt",
      consumed_at      AS "consumedAt",
      consumed_by      AS "consumedBy",
      result,
      error
      FROM agent_messages
     WHERE id = ${messageId}
  `)) as unknown as AgentMessage[];

  return result[0] ?? null;
}
