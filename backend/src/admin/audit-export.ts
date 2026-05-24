/**
 * Admin audit endpoints (M13).
 *
 * Two routes, same router:
 *
 *   GET /v1/admin/audit
 *     Paginated JSON for the admin UI's table view. Returns
 *     `{rows, pagination}`. Supports the filter set the UI exposes:
 *     since, until, actorId, actionPrefix, targetType, targetId, limit,
 *     offset. limit capped at 200 here (the export endpoint takes over
 *     past that).
 *
 *   GET /v1/admin/audit/export
 *     Streaming NDJSON download — one row per line, oldest first, suitable
 *     for ACPR forensic submission. Defaults to the full log; supports
 *     since/until/actorId/actionPrefix/targetType/targetId. Pass
 *     `redactPii=true` to run every freeform string field through the PII
 *     redactor before serialising (defense in depth — operators should
 *     already be putting only redacted data into audit rows).
 *
 * No CSV — NDJSON is the right shape for nested jsonb (before/after/meta),
 * and ACPR receivers (or our own re-importers) can ingest it line-at-a-
 * time. CSV here would flatten away the structure that makes the audit
 * useful in the first place.
 *
 * Auth: same posture as the rest of /v1/admin/* — open on the local network,
 * gated by Cloudflare Access if/when the admin goes internet-exposed.
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import {
  listAuditEntries,
  streamAuditEntries,
  type ListAuditOptions,
} from '../db/repositories/audit-log.js';
import { redactPII } from '../compliance/pii-redact.js';

export interface AdminAuditRouterOptions {
  db: Database;
}

/** Wire shape — one row in the JSON list response. Mirrors AuditLogEntry. */
export interface AuditRow {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  occurredAt: string;
}

const FilterSchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  actorId: z.string().optional(),
  actionPrefix: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ExportFilterSchema = FilterSchema.omit({ limit: true, offset: true }).extend({
  redactPii: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

export function buildAdminAuditRouter(opts: AdminAuditRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/audit', async (c) => {
    const parse = FilterSchema.safeParse({
      since: c.req.query('since'),
      until: c.req.query('until'),
      actorId: c.req.query('actorId'),
      actionPrefix: c.req.query('actionPrefix'),
      targetType: c.req.query('targetType'),
      targetId: c.req.query('targetId'),
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
    if (!parse.success) {
      return c.json({ error: 'invalid_query', issues: parse.error.issues }, 400);
    }
    const queryOpts: ListAuditOptions = {
      limit: parse.data.limit,
      offset: parse.data.offset,
      order: 'desc',
    };
    if (parse.data.since) queryOpts.since = new Date(parse.data.since);
    if (parse.data.until) queryOpts.until = new Date(parse.data.until);
    if (parse.data.actorId) queryOpts.actorId = parse.data.actorId;
    if (parse.data.actionPrefix) queryOpts.actionPrefix = parse.data.actionPrefix;
    if (parse.data.targetType) queryOpts.targetType = parse.data.targetType;
    if (parse.data.targetId) queryOpts.targetId = parse.data.targetId;
    const rows = await listAuditEntries(opts.db, queryOpts);
    return c.json(
      {
        rows: rows.map(toRow),
        pagination: {
          limit: parse.data.limit,
          offset: parse.data.offset,
          returned: rows.length,
        },
      },
      200,
    );
  });

  app.get('/v1/admin/audit/export', (c) => {
    const parse = ExportFilterSchema.safeParse({
      since: c.req.query('since'),
      until: c.req.query('until'),
      actorId: c.req.query('actorId'),
      actionPrefix: c.req.query('actionPrefix'),
      targetType: c.req.query('targetType'),
      targetId: c.req.query('targetId'),
      redactPii: c.req.query('redactPii'),
    });
    if (!parse.success) {
      return c.json({ error: 'invalid_query', issues: parse.error.issues }, 400);
    }
    const redact = parse.data.redactPii === true;
    const filterOpts: ListAuditOptions = {};
    if (parse.data.since) filterOpts.since = new Date(parse.data.since);
    if (parse.data.until) filterOpts.until = new Date(parse.data.until);
    if (parse.data.actorId) filterOpts.actorId = parse.data.actorId;
    if (parse.data.actionPrefix) filterOpts.actionPrefix = parse.data.actionPrefix;
    if (parse.data.targetType) filterOpts.targetType = parse.data.targetType;
    if (parse.data.targetId) filterOpts.targetId = parse.data.targetId;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="f16-audit-${stamp}.ndjson"`);
    return stream(c, async (s) => {
      for await (const row of streamAuditEntries(opts.db, filterOpts)) {
        const wireRow = toRow(row);
        const serialised = redact ? redactRow(wireRow) : wireRow;
        await s.write(`${JSON.stringify(serialised)}\n`);
      }
    });
  });

  return app;
}

function toRow(r: {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  occurredAt: Date;
}): AuditRow {
  return {
    id: r.id,
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    before: r.before,
    after: r.after,
    meta: r.meta,
    occurredAt: r.occurredAt.toISOString(),
  };
}

/**
 * Walk before/after/meta recursively and run every string leaf through the
 * PII redactor. Defense-in-depth — callers should already be sanitising
 * what they put into audit rows, but on the export boundary we'd rather
 * over-redact than ship a phone number to an external recipient.
 */
function redactRow(row: AuditRow): AuditRow {
  return {
    ...row,
    before: row.before ? (redactValue(row.before) as Record<string, unknown>) : null,
    after: row.after ? (redactValue(row.after) as Record<string, unknown>) : null,
    meta: row.meta ? (redactValue(row.meta) as Record<string, unknown>) : null,
  };
}

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactPII(v).text;
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = redactValue(val);
    }
    return out;
  }
  return v;
}
