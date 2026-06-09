/**
 * Admin prompt editor endpoints (M14.T6) — DB-backed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { auditLog } from '../../src/db/schema/index.js';
import { buildAdminPromptsRouter } from '../../src/admin/prompts.js';
import {
  registerPrompt,
  resolvePrompt,
  __resetRegistryForTests,
} from '../../src/prompts/registry.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

d('admin prompts endpoints', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminPromptsRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE prompt_overrides`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    __resetRegistryForTests();
    registerPrompt({
      key: 'sales-agent.system',
      label: 'Sales Agent — système',
      agentRole: 'sales-agent',
      description: 'Prompt système du Sales Agent.',
      getDefault: () => 'DEFAULT SALES PROMPT',
    });
    app = buildAdminPromptsRouter({ db });
  });
  afterEach(() => __resetRegistryForTests());

  it('lists registered prompts with default + not-overridden', async () => {
    const res = await app.request('/v1/admin/prompts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: Array<{ key: string; default: string; isOverridden: boolean }>;
    };
    const p = body.prompts.find((x) => x.key === 'sales-agent.system');
    expect(p?.default).toBe('DEFAULT SALES PROMPT');
    expect(p?.isOverridden).toBe(false);
  });

  it('PUT sets an override → list shows it, resolvePrompt returns it, audit row written', async () => {
    const put = await app.request('/v1/admin/prompts/sales-agent.system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'NOUVEAU PROMPT' }),
    });
    expect(put.status).toBe(200);

    const list = (await (await app.request('/v1/admin/prompts')).json()) as {
      prompts: Array<{ key: string; override: string | null; isOverridden: boolean }>;
    };
    const p = list.prompts.find((x) => x.key === 'sales-agent.system');
    expect(p?.isOverridden).toBe(true);
    expect(p?.override).toBe('NOUVEAU PROMPT');

    // The resolver returns the new content (cache was busted on save).
    expect(await resolvePrompt(db, 'sales-agent.system', () => 'DEFAULT SALES PROMPT')).toBe(
      'NOUVEAU PROMPT',
    );

    const audits = await db.select().from(auditLog);
    expect(
      audits.some((a) => a.action === 'prompt.override.set' && a.targetId === 'sales-agent.system'),
    ).toBe(true);
  });

  it('DELETE resets to default', async () => {
    await app.request('/v1/admin/prompts/sales-agent.system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'X' }),
    });
    const del = await app.request('/v1/admin/prompts/sales-agent.system', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await resolvePrompt(db, 'sales-agent.system', () => 'DEFAULT SALES PROMPT')).toBe(
      'DEFAULT SALES PROMPT',
    );
  });

  it('rejects unknown key (404) and empty content (400)', async () => {
    const unknown = await app.request('/v1/admin/prompts/nope.nope', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(unknown.status).toBe(404);

    const empty = await app.request('/v1/admin/prompts/sales-agent.system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '   ' }),
    });
    expect(empty.status).toBe(400);
  });
});
