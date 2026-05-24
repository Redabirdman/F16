/**
 * human_actions repository — the human-in-the-loop queue.
 *
 * Lifecycle:
 *   createAction → status='pending'
 *   resolveAction → status='resolved' + resolution jsonb + resolvedAt/by/source
 *   escalate → escalatedAt set; status unchanged (the escalator worker may
 *              flip it to 'expired' later if SLA is breached past tolerance).
 *
 * Idempotency:
 *   resolveAction is idempotent — calling it twice on an already-resolved
 *   row returns the existing row unchanged. The admin UI and the WhatsApp
 *   bot may both submit a resolution near-simultaneously; the first write
 *   wins and the second is a no-op.
 *
 * Realtime fan-out is delivered by the SQL trigger on insert + status
 * update (channel `human_actions_channel`).
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { humanActions } from '../schema/index.js';
import type {
  HumanAction,
  HumanActionOption,
  HumanActionResolution,
} from '../schema/agent-runtime.js';
import { appendAudit } from './audit-log.js';

export interface CreateHumanActionInput {
  createdByAgent: string;
  intent: string;
  severity: 1 | 2 | 3;
  summary: string;
  options: HumanActionOption[];
  correlationId?: string | null;
  dueAt?: Date | null;
}

export async function createAction(
  db: Database,
  input: CreateHumanActionInput,
): Promise<HumanAction> {
  const [row] = await db
    .insert(humanActions)
    .values({
      createdByAgent: input.createdByAgent,
      intent: input.intent,
      severity: input.severity,
      summary: input.summary,
      options: input.options,
      correlationId: input.correlationId ?? null,
      dueAt: input.dueAt ?? null,
      // status defaults to 'pending' in the DB.
    })
    .returning();

  if (!row) throw new Error('createAction: insert returned no row');

  // M13 — audit write. Best-effort: if the audit table is unavailable we'd
  // rather still surface the human action than 500 the caller's primary
  // flow. Log and continue. Audit columns are deliberately bounded — no
  // freeform PII (summary is operator-authored + may contain customer
  // names; we redact at export, not here, to preserve forensic fidelity).
  try {
    await appendAudit(db, {
      actorType: 'agent',
      actorId: input.createdByAgent,
      action: 'human_action.create',
      targetType: 'human_action',
      targetId: row.id,
      after: {
        intent: input.intent,
        severity: input.severity,
        summary: input.summary,
        optionCount: input.options.length,
      },
      ...(input.correlationId ? { meta: { correlationId: input.correlationId } } : {}),
    });
  } catch {
    // swallow — audit failures are non-blocking by design
  }
  return row;
}

export interface ResolveOptions {
  chosenOption: HumanActionOption;
  notes?: string;
  by: string;
  source: 'admin' | 'whatsapp';
}

/**
 * Idempotent resolve: if the row is already resolved, returns it unchanged.
 * Otherwise flips status='resolved' + persists the resolution payload.
 *
 * Implemented as a conditional UPDATE (`WHERE status = 'pending'`) returning
 * the row; on a no-op we fall back to a fresh SELECT so the caller always
 * sees the canonical post-state.
 */
export async function resolveAction(
  db: Database,
  id: string,
  opts: ResolveOptions,
): Promise<HumanAction> {
  const resolution: HumanActionResolution = {
    chosenOptionId: opts.chosenOption.id,
    by: opts.by,
    source: opts.source,
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
  };

  const [updated] = await db
    .update(humanActions)
    .set({
      status: 'resolved',
      resolution,
      resolvedAt: sql`now()`,
      resolvedBy: opts.by,
      resolvedSource: opts.source,
    })
    .where(and(eq(humanActions.id, id), eq(humanActions.status, 'pending')))
    .returning();

  if (updated) {
    // M13 — audit write on the actual state transition. The WAHA + admin
    // paths each ALSO append their own caller-level audit row (with the
    // resolver phone / 'admin-ui' as actorId); this row captures the
    // pending → resolved transition itself from the repository's POV.
    try {
      await appendAudit(db, {
        actorType:
          opts.source === 'admin' ? 'human' : opts.source === 'whatsapp' ? 'human' : 'system',
        actorId: opts.by,
        action: 'human_action.transition',
        targetType: 'human_action',
        targetId: id,
        before: { status: 'pending' },
        after: {
          status: 'resolved',
          chosenOptionId: opts.chosenOption.id,
          source: opts.source,
        },
      });
    } catch {
      // non-blocking
    }
    return updated;
  }

  // Already resolved (or cancelled / expired) — return current row.
  const [existing] = await db.select().from(humanActions).where(eq(humanActions.id, id)).limit(1);

  if (!existing) throw new Error(`resolveAction: action ${id} not found`);
  return existing;
}

export interface ListPendingOptions {
  /** Restrict to a specific severity tier (1 = critical, 2 = standard, 3 = info). */
  severity?: 1 | 2 | 3;
  /** Max rows to return (default 100). */
  limit?: number;
}

/**
 * Single-row lookup by primary key. Returns null on miss (no-throw — the
 * caller decides whether a missing row is recoverable, e.g. the reporter
 * agent treats it as "row was deleted between dispatch and consume").
 */
export async function getActionById(db: Database, id: string): Promise<HumanAction | null> {
  const [row] = await db.select().from(humanActions).where(eq(humanActions.id, id)).limit(1);
  return row ?? null;
}

/**
 * Inbox query — pending items ordered severity-first then oldest-first
 * (critical-and-stale bubbles to the top).
 */
export async function listPending(
  db: Database,
  opts: ListPendingOptions = {},
): Promise<HumanAction[]> {
  const limit = opts.limit ?? 100;

  const where =
    opts.severity !== undefined
      ? and(eq(humanActions.status, 'pending'), eq(humanActions.severity, opts.severity))
      : eq(humanActions.status, 'pending');

  return db
    .select()
    .from(humanActions)
    .where(where)
    .orderBy(asc(humanActions.severity), asc(humanActions.createdAt))
    .limit(limit);
}

/** Mark `escalatedAt = now()` — the escalator worker uses this to bump
 *  unresolved items that have crossed their `dueAt` deadline. Status is
 *  left intact (the workflow may choose to flip it to 'expired' later). */
export async function escalate(db: Database, id: string): Promise<void> {
  await db
    .update(humanActions)
    .set({ escalatedAt: sql`now()` })
    .where(eq(humanActions.id, id));
}

// Suppress unused-import lint warnings — `desc` is used elsewhere in the
// repo family and kept available for future read paths.
void desc;
