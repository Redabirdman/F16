/**
 * Admin prompt editor endpoints (M14.T6).
 *
 *   GET    /v1/admin/prompts          — list every registered prompt + its override
 *   PUT    /v1/admin/prompts/:key     — set an override (audited, cache-busted)
 *   DELETE /v1/admin/prompts/:key     — reset to the code default (audited)
 *
 * Behind the admin bearer auth (mounted in index.ts). Editing a prompt takes
 * effect on the agent's NEXT message (resolvePrompt reads the override). Every
 * change writes audit_log.
 */
import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { listPromptDefs, getPromptDef, bustPromptCache } from '../prompts/registry.js';
import {
  listOverrides,
  upsertOverride,
  deleteOverride,
} from '../db/repositories/prompt-overrides.js';
import { appendAudit } from '../db/repositories/audit-log.js';

export interface AdminPromptsRouterOptions {
  db: Database;
}

export function buildAdminPromptsRouter(opts: AdminPromptsRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/prompts', async (c) => {
    const defs = listPromptDefs();
    const overrides = new Map((await listOverrides(opts.db)).map((o) => [o.key, o]));
    return c.json({
      prompts: defs.map((d) => {
        const o = overrides.get(d.key);
        return {
          key: d.key,
          label: d.label,
          agentRole: d.agentRole,
          description: d.description,
          default: d.getDefault(),
          override: o?.content ?? null,
          isOverridden: Boolean(o),
          updatedAt: o ? o.updatedAt.toISOString() : null,
          updatedBy: o?.updatedBy ?? null,
        };
      }),
    });
  });

  app.put('/v1/admin/prompts/:key', async (c) => {
    const key = c.req.param('key');
    if (!getPromptDef(key)) return c.json({ error: 'unknown prompt key' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    const content = (body.content ?? '').trim();
    if (!content) return c.json({ error: 'content required' }, 400);

    await upsertOverride(opts.db, key, content, 'admin');
    bustPromptCache();
    await appendAudit(opts.db, {
      actorType: 'human',
      actorId: 'admin',
      action: 'prompt.override.set',
      targetType: 'prompt',
      targetId: key,
      after: { length: content.length },
    });
    return c.json({ ok: true, key }, 200);
  });

  app.delete('/v1/admin/prompts/:key', async (c) => {
    const key = c.req.param('key');
    if (!getPromptDef(key)) return c.json({ error: 'unknown prompt key' }, 404);
    const removed = await deleteOverride(opts.db, key);
    bustPromptCache();
    await appendAudit(opts.db, {
      actorType: 'human',
      actorId: 'admin',
      action: 'prompt.override.reset',
      targetType: 'prompt',
      targetId: key,
      after: { removed },
    });
    return c.json({ ok: true, key, removed }, 200);
  });

  return app;
}
