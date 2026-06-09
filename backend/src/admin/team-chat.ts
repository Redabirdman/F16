/**
 * Admin team-chat (M14.T10).
 *
 *   GET  /v1/admin/team-chat?limit=  — operator timeline: human-action requests +
 *        their resolutions (admin/WhatsApp) + admin messages sent to the group.
 *   POST /v1/admin/team-chat/send    — post a free-text message to the WhatsApp
 *        operator group (the same group the Reporter Agent posts to).
 *
 * Read-side derives from what we already persist (`human_actions` + `audit_log`),
 * so there's no new ingestion. The send path uses the WAHA client + audits the
 * message (which then appears as a `sent` entry in the timeline).
 */
import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { humanActions, auditLog } from '../db/schema/index.js';
import { appendAudit } from '../db/repositories/audit-log.js';

/** Minimal structural WAHA sender — the real WahaClient satisfies it; tests stub it. */
export interface GroupSender {
  sendText(input: { chatId: string; text: string }): Promise<unknown>;
}

export interface AdminTeamChatRouterOptions {
  db: Database;
  /** WAHA client used to post to the group. Omit → send returns 503. */
  waha?: GroupSender;
  /** Operator group chat id (HUMAN_ACTION_GROUP_CHAT_ID). Omit → send returns 503. */
  groupChatId?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SENT_ACTION = 'team_chat.message.sent';

type Entry =
  | {
      kind: 'request';
      at: string;
      id: string;
      intent: string;
      severity: number;
      summary: string;
      correlationId: string | null;
    }
  | {
      kind: 'resolved';
      at: string;
      id: string;
      choice: string | null;
      by: string | null;
      source: string | null;
    }
  | { kind: 'sent'; at: string; text: string };

export function buildAdminTeamChatRouter(opts: AdminTeamChatRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/team-chat', async (c) => {
    const rawLimit = Number(c.req.query('limit'));
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const [actions, sentRows] = await Promise.all([
      opts.db.select().from(humanActions).orderBy(desc(humanActions.createdAt)).limit(limit),
      opts.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, SENT_ACTION))
        .orderBy(desc(auditLog.occurredAt))
        .limit(limit),
    ]);

    const entries: Entry[] = [];
    for (const a of actions) {
      entries.push({
        kind: 'request',
        at: a.createdAt.toISOString(),
        id: a.id,
        intent: a.intent,
        severity: a.severity,
        summary: a.summary,
        correlationId: a.correlationId,
      });
      if (a.resolvedAt) {
        entries.push({
          kind: 'resolved',
          at: a.resolvedAt.toISOString(),
          id: a.id,
          choice: a.resolution?.chosenOptionId ?? null,
          by: a.resolvedBy,
          source: a.resolvedSource,
        });
      }
    }
    for (const s of sentRows) {
      const after = s.after as { text?: string } | null;
      entries.push({ kind: 'sent', at: s.occurredAt.toISOString(), text: after?.text ?? '' });
    }

    entries.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
    return c.json({ generatedAt: new Date().toISOString(), entries: entries.slice(0, limit) });
  });

  app.post('/v1/admin/team-chat/send', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = (body.text ?? '').trim();
    if (!text) return c.json({ error: 'text required' }, 400);
    if (!opts.waha || !opts.groupChatId) {
      return c.json({ error: 'whatsapp_not_configured' }, 503);
    }
    await opts.waha.sendText({ chatId: opts.groupChatId, text });
    await appendAudit(opts.db, {
      actorType: 'human',
      actorId: 'admin',
      action: SENT_ACTION,
      targetType: 'whatsapp_group',
      targetId: opts.groupChatId,
      after: { text },
    });
    return c.json({ ok: true }, 200);
  });

  return app;
}
