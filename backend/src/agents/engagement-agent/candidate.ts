/**
 * Candidate query for the Customer Engagement Agent (M11).
 *
 * Finds leads that MIGHT need a re-engagement nudge: status is eligible and
 * the most-recent conversation turn (any direction) is older than the
 * shortest cadence threshold (24h). Per-lead "which step + does quiet-hours
 * allow it + is anti-spam clear" decisions happen inside the agent for two
 * reasons:
 *
 *   1. The query stays a single fast SQL pass (`leads JOIN LATERAL (max
 *      occurredAt)`), no per-row branching in SQL.
 *   2. The scheduler can re-enqueue ticks cheaply; the agent is where every
 *      gate (quiet hours, anti-spam, cadence step) is enforced authoritatively.
 *
 * The returned IDs are upper-bounded — leads with no conversation turns at
 * all are EXCLUDED (no inbound/outbound = no "last activity" anchor, so the
 * 24h clock cannot have started). The Lead Scorer's welcome is logged as an
 * outbound turn by the Sales Agent, so a freshly-welcomed lead with no
 * customer reply still surfaces here after 24h.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';

/**
 * Lead lifecycle statuses the agent re-engages. Locked design:
 *   scored, qualifying, quoting, negotiating.
 * Explicitly NOT re-engaged: new (never welcomed), closed_won, closed_lost,
 * dormant (already escalated), awaiting_payment (different cadence).
 */
export const ELIGIBLE_LEAD_STATUSES = ['scored', 'qualifying', 'quoting', 'negotiating'] as const;

/** Shortest cadence threshold — 24h. Above this we WANT the agent to evaluate. */
const SHORTEST_THRESHOLD_HOURS = 24;

export interface EngagementCandidate {
  leadId: string;
  /** Most-recent conversation_turns.occurred_at for this lead. */
  lastActivityAt: Date;
}

/**
 * Find leads potentially due for a re-engagement evaluation.
 *
 * `now` is injectable so tests can pin a deterministic moment; production
 * defaults to `new Date()`.
 *
 * `limit` caps how many candidates a single tick processes (default 200) so
 * an unexpected backlog doesn't flood the queue in one pass — the next tick
 * picks up the rest.
 */
export async function findEngagementCandidates(
  db: Database,
  opts: { now?: Date; limit?: number } = {},
): Promise<EngagementCandidate[]> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const limit = opts.limit ?? 200;
  // Inlined the eligible statuses as a SQL ANY() — drizzle-orm doesn't expose
  // a typed `inArray` for raw sql tags here, and the list is fixed-cardinality.
  const statusList = ELIGIBLE_LEAD_STATUSES.map((s) => `'${s}'`).join(',');
  const rows = await db.execute(
    sql.raw(`
    SELECT l.id AS lead_id,
           latest.occurred_at AS last_activity_at
      FROM leads l
      JOIN LATERAL (
        SELECT MAX(occurred_at) AS occurred_at
          FROM conversation_turns
         WHERE lead_id = l.id
      ) AS latest ON TRUE
     WHERE l.status IN (${statusList})
       AND latest.occurred_at IS NOT NULL
       AND latest.occurred_at <= TIMESTAMPTZ '${nowIso}' - INTERVAL '${SHORTEST_THRESHOLD_HOURS} hours'
     ORDER BY latest.occurred_at ASC
     LIMIT ${limit}
  `),
  );
  // pg driver returns snake_case keys for raw SQL — keep the mapping explicit.
  return (rows as unknown as Array<{ lead_id: string; last_activity_at: string | Date }>).map(
    (r) => ({
      leadId: r.lead_id,
      lastActivityAt:
        r.last_activity_at instanceof Date ? r.last_activity_at : new Date(r.last_activity_at),
    }),
  );
}
