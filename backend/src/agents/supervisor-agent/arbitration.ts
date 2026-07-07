/**
 * Cross-agent conflict arbitration (M15.T4).
 *
 * Periodic scan of `agent_messages` looking for back-and-forth loops on a
 * shared correlation_id. A loop is when two distinct fromRole values
 * alternate >= N times in a short window — the canonical pathology is
 * `agent A ↔ agent B` ping-ponging over a single lead/quote.
 *
 * V1 policy: conservative — flag, don't auto-kill.
 *   - When a loop is detected we create a single HUMAN_ACTION
 *     (`AGENT_LOOP_DETECTED`) that surfaces in /queue + the WA group.
 *   - We DO NOT kill either agent; a false-positive killing of a
 *     legitimate retry pattern is worse than a verbose log.
 *   - Idempotency: we tag the audit_log row with the (correlationId,
 *     window_start) so a subsequent tick that re-sees the same loop
 *     doesn't create a duplicate human action. Cheap dedup: skip when
 *     a `supervisor.arbitration.loop` audit row already exists for this
 *     (target, since) pair.
 *
 * Tuning knobs:
 *   - WINDOW_MIN: minutes back to look (default 30).
 *   - LOOP_MIN_TURNS: minimum alternations to count (default 5). Five
 *     turns gives us 3 from one side and 2 from the other (or vice
 *     versa) — enough to rule out a legitimate request/response/refine
 *     pattern.
 *   - LOOP_MAX_DISTINCT_AGENTS: a loop must involve exactly 2 distinct
 *     fromRole values (loops with 3+ agents are almost certainly real
 *     work, not loops).
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { agentMessages } from '../../db/schema/index.js';
import { appendAudit, listAuditEntries } from '../../db/repositories/audit-log.js';
import { createAction } from '../../db/repositories/human-actions.js';
import { notifyHumanAction } from '../human-notify.js';
import { logger } from '../../logger.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_WINDOW_MIN = 30;
const DEFAULT_LOOP_MIN_TURNS = 5;
const LOOP_DISTINCT_AGENTS = 2;

/**
 * A `channel.*` fromRole is an inbound CUSTOMER message relayed by a channel
 * adapter (channel.whatsapp, channel.intake …), not an autonomous agent. A
 * long back-and-forth between `channel.whatsapp` and `sales-agent` is just a
 * normal customer conversation, NOT an agent ping-pong loop — excluding these
 * pairs kills the AGENT_LOOP_DETECTED false-positive Achraf hit on 07-06.
 */
function isChannelRole(role: string): boolean {
  return role.startsWith('channel.');
}

/**
 * Service/driver agents that operate strict request→response protocols with
 * the sales-agent (QUOTE.REQUESTED → PREVIEW_READY → CONFIRM_REQUESTED →
 * READY/FAILED …). A busy quote — especially a two-devis comparison —
 * legitimately exchanges 5+ messages on one correlation within minutes, which tripped the
 * detector live on 2026-07-07 ("5 messages entre maxance-operator ↔
 * sales-agent"). These flows can stall but cannot ping-pong; stalls are the
 * followthrough watchdog's job (QUOTE_STUCK), not arbitration's.
 */
const SERVICE_ROLES: ReadonlySet<string> = new Set(['maxance-operator']);

export interface ArbitrationOptions {
  db: Database;
  /** Override the tick cadence (ms). Default 5 minutes. */
  intervalMs?: number;
  /** Override the lookback window (minutes). Default 30. */
  windowMin?: number;
  /** Override the minimum alternation count. Default 5. */
  loopMinTurns?: number;
}

export interface ArbitrationHandle {
  scheduler: NodeJS.Timeout;
  stop(): void;
  /** Test seam: run one tick synchronously. */
  tickOnce(): Promise<ArbitrationTickResult>;
}

export interface ArbitrationTickResult {
  scanned: number;
  flagged: number;
  skipped: number;
  durationMs: number;
}

/**
 * Start the arbitration scheduler. Caller owns the handle + MUST call
 * `stop()` on shutdown so the interval doesn't keep the event loop alive.
 *
 * First tick runs immediately so a freshly-booted process surfaces any
 * pre-existing loop without waiting `intervalMs`.
 */
export function startArbitration(opts: ArbitrationOptions): ArbitrationHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const windowMin = opts.windowMin ?? DEFAULT_WINDOW_MIN;
  const loopMinTurns = opts.loopMinTurns ?? DEFAULT_LOOP_MIN_TURNS;

  const tick = async (): Promise<ArbitrationTickResult> => {
    const t0 = Date.now();
    let scanned = 0;
    let flagged = 0;
    let skipped = 0;
    try {
      const since = new Date(Date.now() - windowMin * 60_000);
      const candidates = await findLoopCandidates(opts.db, { since, loopMinTurns });
      scanned = candidates.length;
      for (const c of candidates) {
        const wasFlagged = await flagLoop(opts.db, { ...c, since });
        if (wasFlagged) flagged += 1;
        else skipped += 1;
      }
      logger.info(
        { scanned, flagged, skipped, windowMin, durationMs: Date.now() - t0 },
        'arbitration: tick complete',
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'arbitration: tick failed',
      );
    }
    return { scanned, flagged, skipped, durationMs: Date.now() - t0 };
  };

  // First tick immediately (fire-and-forget) so a fresh deploy reports
  // existing loops without waiting `intervalMs`.
  void tick();
  const scheduler = setInterval(() => {
    void tick();
  }, intervalMs);

  let stopped = false;
  return {
    scheduler,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(scheduler);
    },
    tickOnce: tick,
  };
}

interface LoopCandidate {
  correlationId: string;
  totalTurns: number;
  distinctAgents: string[];
}

/**
 * Find correlation_ids that look like loops: same correlation_id, ≥ N
 * messages in the lookback window, AND exactly 2 distinct fromRole values.
 *
 * Implementation: GROUP BY correlation_id with HAVING count() >= N AND
 * count(distinct from_role) = 2.
 */
async function findLoopCandidates(
  db: Database,
  opts: { since: Date; loopMinTurns: number },
): Promise<LoopCandidate[]> {
  const rows = await db
    .select({
      correlationId: agentMessages.correlationId,
      totalTurns: sql<number>`count(*)::int`,
      distinctAgents: sql<string>`string_agg(distinct ${agentMessages.fromRole}, ',')`,
      agentCount: sql<number>`count(distinct ${agentMessages.fromRole})::int`,
    })
    .from(agentMessages)
    .where(
      and(
        gte(agentMessages.createdAt, opts.since),
        sql`${agentMessages.correlationId} IS NOT NULL`,
      ),
    )
    .groupBy(agentMessages.correlationId)
    .having(
      sql`count(*) >= ${opts.loopMinTurns} AND count(distinct ${agentMessages.fromRole}) = ${LOOP_DISTINCT_AGENTS}`,
    );

  return (
    rows
      .filter((r): r is typeof r & { correlationId: string } => r.correlationId !== null)
      .map((r) => ({
        correlationId: r.correlationId,
        totalTurns: r.totalTurns,
        distinctAgents: r.distinctAgents.split(',').sort(),
      }))
      // Drop customer conversations (channel adapter pairs) and service-driver
      // pairs (maxance-operator ↔ sales-agent request/response pipeline):
      // neither is an agent ping-pong loop. Only true peer agent↔agent pairs
      // are real loops.
      .filter((c) => !c.distinctAgents.some((r) => isChannelRole(r) || SERVICE_ROLES.has(r)))
  );
}

/**
 * Flag the loop via HUMAN_ACTION + audit row. Idempotent: skips when
 * we've already audit-flagged this correlationId in the same window.
 * Returns true iff a new flag was raised (false = dedup-skipped).
 */
async function flagLoop(
  db: Database,
  ctx: { correlationId: string; totalTurns: number; distinctAgents: string[]; since: Date },
): Promise<boolean> {
  // Dedup: have we already flagged this correlationId in this window?
  const recent = await listAuditEntries(db, {
    actionPrefix: 'supervisor.arbitration.loop',
    targetType: 'correlation',
    targetId: ctx.correlationId,
    since: ctx.since,
    limit: 1,
  });
  if (recent.length > 0) return false;

  const action = await createAction(db, {
    createdByAgent: 'supervisor-agent#singleton',
    correlationId: ctx.correlationId,
    intent: 'AGENT_LOOP_DETECTED',
    severity: 2,
    summary:
      `Boucle agent détectée sur ${ctx.correlationId.slice(0, 8)} : ` +
      `${ctx.totalTurns} messages entre ${ctx.distinctAgents.join(' ↔ ')} en moins de 30 min. ` +
      `Aucune action automatique. Vérifier et arbitrer.`,
    // English labels — these render verbatim in the management WA group.
    options: [
      { id: 'investigate', label: 'I will investigate', kind: 'approve' },
      { id: 'kill_first', label: `Stop ${ctx.distinctAgents[0] ?? 'A'}`, kind: 'reject' },
      { id: 'kill_second', label: `Stop ${ctx.distinctAgents[1] ?? 'B'}`, kind: 'reject' },
    ],
  });
  // A live agent loop is urgent — reach the WA group, not just the admin (H1).
  await notifyHumanAction(
    db,
    { id: action.id, severity: 2, summary: action.summary },
    { role: 'supervisor-agent', instanceId: 'singleton', correlationId: ctx.correlationId },
  );
  try {
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'supervisor-agent#singleton',
      action: 'supervisor.arbitration.loop',
      targetType: 'correlation',
      targetId: ctx.correlationId,
      meta: {
        totalTurns: ctx.totalTurns,
        distinctAgents: ctx.distinctAgents,
        humanActionId: action.id,
      },
    });
  } catch {
    // best-effort — human action already landed
  }
  logger.warn(
    {
      correlationId: ctx.correlationId,
      totalTurns: ctx.totalTurns,
      distinctAgents: ctx.distinctAgents,
      humanActionId: action.id,
    },
    'arbitration: loop flagged',
  );
  return true;
}

// Suppress unused-import lint warning — kept for the strategy-review
// hookup that mines arbitration findings cross-cycle.
void desc;
void eq;
