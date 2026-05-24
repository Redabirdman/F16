/**
 * `audit_log` repository (M13) — append-only forensic ledger.
 *
 * Single insert path so every caller — agents, admin endpoints, the
 * compliance sentry, future config-change UIs — writes rows with the
 * same shape. ACPR forensic export depends on the shape being stable.
 *
 * The schema is already migration-shipped (see
 * `src/db/schema/agent-runtime.ts` § audit_log). This module adds:
 *
 *   1. `appendAudit({...})` — typed insert.
 *   2. `listAuditEntries({...})` — paginated query with the filters the
 *      admin UI + the export endpoint need (date range, actor, target,
 *      action prefix, severity-free).
 *   3. `streamAuditEntries(...)` — async iterator over a chunked LIMIT/
 *      OFFSET walk for the NDJSON export endpoint. Bounded memory even
 *      on a full-year ACPR dump.
 *
 * PII discipline: audit_log content is operator/regulator-visible. Callers
 * MUST NOT put decrypted PII (full name, email, phone) into `before`/`after`/
 * `meta` jsonb fields. The export endpoint runs the redactor over freeform
 * strings as a defense-in-depth, but the primary contract is "don't put PII
 * in the first place".
 *
 * Append-only: there is no `update` or `delete` here on purpose. Even bad
 * data stays — it's an audit trail.
 */
import { and, asc, desc, eq, gte, like, lte } from 'drizzle-orm';
import type { Database } from '../index.js';
import { auditLog } from '../schema/index.js';
import type { AuditLogEntry } from '../schema/agent-runtime.js';

/** Caller-supplied row shape. Mirrors the schema minus auto-set columns. */
export interface AppendAuditInput {
  /** 'agent' | 'human' | 'system'. Stable string — not an enum at the DB. */
  actorType: 'agent' | 'human' | 'system';
  /** Agent `role#instance`, human user id (V1: phone or 'ridaa'/'achraf'), or 'system'. */
  actorId: string;
  /** Action namespace, e.g. 'lead.status.change', 'human_action.resolve', 'compliance.block'. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  /** Override the timestamp (defaults to DB now()). Useful for backfills + tests. */
  occurredAt?: Date;
}

/**
 * Append a single audit row. Throws on driver/connection errors; callers
 * should NOT wrap in try/catch unless they're prepared to lose the audit
 * row — the right behaviour for almost every site is to let the operation
 * fail loud so the caller's own retry policy gets engaged.
 *
 * Best-effort callers (e.g. an agent that wants the audit but shouldn't
 * fail its primary action on an audit-write blip) should wrap in their own
 * try/catch and downgrade to a warning.
 */
export async function appendAudit(db: Database, input: AppendAuditInput): Promise<AuditLogEntry> {
  const [row] = await db
    .insert(auditLog)
    .values({
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      meta: input.meta ?? null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    })
    .returning();
  if (!row) throw new Error('appendAudit: insert returned no row');
  return row;
}

export interface ListAuditOptions {
  since?: Date;
  until?: Date;
  actorId?: string;
  /** SQL LIKE prefix match — e.g. 'human_action.' captures every human-action action. */
  actionPrefix?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
  /** Sort newest-first (default) or oldest-first (export friendlier). */
  order?: 'desc' | 'asc';
}

/**
 * Paginated query. Filters AND together; pass none for a global tail.
 * Default limit 100, max 1000 (caller still needs to chunk for big dumps —
 * use `streamAuditEntries` for that).
 */
export async function listAuditEntries(
  db: Database,
  opts: ListAuditOptions = {},
): Promise<AuditLogEntry[]> {
  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = opts.offset ?? 0;
  const conditions = [];
  if (opts.since) conditions.push(gte(auditLog.occurredAt, opts.since));
  if (opts.until) conditions.push(lte(auditLog.occurredAt, opts.until));
  if (opts.actorId) conditions.push(eq(auditLog.actorId, opts.actorId));
  if (opts.actionPrefix) conditions.push(like(auditLog.action, `${opts.actionPrefix}%`));
  if (opts.targetType) conditions.push(eq(auditLog.targetType, opts.targetType));
  if (opts.targetId) conditions.push(eq(auditLog.targetId, opts.targetId));
  const order = opts.order ?? 'desc';
  return db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(order === 'desc' ? desc(auditLog.occurredAt) : asc(auditLog.occurredAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Async iterator over a chunked walk of the audit log. Defaults to a
 * 500-row chunk size — small enough to stay well under any reasonable
 * memory budget, large enough to keep round-trips reasonable on a multi-
 * thousand-row export.
 *
 * Always iterates oldest-first (forensic exports are read chronologically).
 * `since` defaults to epoch and `until` to now() so an unparameterised call
 * dumps the entire log.
 */
export async function* streamAuditEntries(
  db: Database,
  opts: Omit<ListAuditOptions, 'order' | 'limit' | 'offset'> & { chunkSize?: number } = {},
): AsyncIterableIterator<AuditLogEntry> {
  const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? 500, 2000));
  let offset = 0;
  for (;;) {
    const rows = await listAuditEntries(db, {
      ...opts,
      order: 'asc',
      limit: chunkSize,
      offset,
    });
    if (rows.length === 0) return;
    for (const r of rows) yield r;
    if (rows.length < chunkSize) return;
    offset += chunkSize;
  }
}
