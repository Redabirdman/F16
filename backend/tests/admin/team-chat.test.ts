/**
 * Admin team-chat (M14.T10) — DB-backed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { createAction, resolveAction } from '../../src/db/repositories/human-actions.js';
import { buildAdminTeamChatRouter } from '../../src/admin/team-chat.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

d('admin team-chat', () => {
  let db: Database;
  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
  });
  afterEach(() => vi.restoreAllMocks());

  async function seed(): Promise<void> {
    await createAction(db, {
      createdByAgent: 'engagement-agent#x',
      intent: 'LEAD_DORMANT',
      severity: 2,
      summary: 'Marie n’a plus répondu depuis 7 jours.',
      options: [
        { id: 'manual_followup', label: 'Reprendre contact', kind: 'approve' },
        { id: 'close_lost', label: 'Clôturer', kind: 'reject' },
      ],
    });
    const a2 = await createAction(db, {
      createdByAgent: 'ads-manager-agent#x',
      intent: 'CAMPAIGN_DRAFT',
      severity: 3,
      summary: 'Brouillon de campagne à valider.',
      options: [{ id: 'approve', label: 'Approuver', kind: 'approve' }],
    });
    await resolveAction(db, a2.id, {
      chosenOption: { id: 'approve', label: 'Approuver', kind: 'approve' },
      by: '+212650012403',
      source: 'whatsapp',
    });
  }

  it('builds a timeline of requests + resolutions', async () => {
    await seed();
    const app = buildAdminTeamChatRouter({ db });
    const res = await app.request('/v1/admin/team-chat');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ kind: string; intent?: string; choice?: string; source?: string }>;
    };
    const requests = body.entries.filter((e) => e.kind === 'request');
    const resolved = body.entries.filter((e) => e.kind === 'resolved');
    expect(requests).toHaveLength(2);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.choice).toBe('approve');
    expect(resolved[0]!.source).toBe('whatsapp');
  });

  it('send posts to the group via WAHA + audits + appears as a sent entry', async () => {
    const sendText = vi.fn(async () => ({ id: { _serialized: 'm1' } }));
    const app = buildAdminTeamChatRouter({
      db,
      waha: { sendText },
      groupChatId: '120363@g.us',
    });
    const send = await app.request('/v1/admin/team-chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Bonjour l’équipe' }),
    });
    expect(send.status).toBe(200);
    expect(sendText).toHaveBeenCalledWith({ chatId: '120363@g.us', text: 'Bonjour l’équipe' });

    const list = (await (await app.request('/v1/admin/team-chat')).json()) as {
      entries: Array<{ kind: string; text?: string }>;
    };
    const sent = list.entries.find((e) => e.kind === 'sent');
    expect(sent?.text).toBe('Bonjour l’équipe');
  });

  it('rejects empty text (400) and returns 503 when WAHA is not configured', async () => {
    const configured = buildAdminTeamChatRouter({
      db,
      waha: { sendText: vi.fn(async () => ({})) },
      groupChatId: '120363@g.us',
    });
    const empty = await configured.request('/v1/admin/team-chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  ' }),
    });
    expect(empty.status).toBe(400);

    const unconfigured = buildAdminTeamChatRouter({ db });
    const noWaha = await unconfigured.request('/v1/admin/team-chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(noWaha.status).toBe(503);
  });
});
