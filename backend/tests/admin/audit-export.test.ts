/**
 * Audit export router (M13) — DB-backed integration tests.
 *
 * Boots the Hono router against a real DB, seeds a handful of rows,
 * exercises the JSON list + NDJSON stream + filter forwarding + PII
 * redaction toggle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { appendAudit } from '../../src/db/repositories/audit-log.js';
import { buildAdminAuditRouter } from '../../src/admin/audit-export.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

d('GET /v1/admin/audit + /export', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminAuditRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    app = buildAdminAuditRouter({ db });
  });

  it('returns a paginated JSON list newest-first', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendAudit(db, {
        actorType: 'agent',
        actorId: `agent-${i}`,
        action: 'lead.status.change',
        occurredAt: new Date(Date.UTC(2026, 4, 24, 10, i)),
      });
    }
    const res = await app.request('/v1/admin/audit?limit=3');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ actorId: string; occurredAt: string }>;
      pagination: { limit: number; offset: number; returned: number };
    };
    expect(body.rows).toHaveLength(3);
    // Newest first.
    expect(body.rows[0]?.actorId).toBe('agent-4');
    expect(body.pagination).toEqual({ limit: 3, offset: 0, returned: 3 });
  });

  it('filters by actionPrefix', async () => {
    await appendAudit(db, { actorType: 'agent', actorId: 'a', action: 'lead.status.change' });
    await appendAudit(db, { actorType: 'agent', actorId: 'b', action: 'human_action.create' });
    const res = await app.request('/v1/admin/audit?actionPrefix=lead.');
    const body = (await res.json()) as { rows: Array<{ action: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.action).toBe('lead.status.change');
  });

  it('streams the export as NDJSON, one row per line, oldest first', async () => {
    for (let i = 0; i < 3; i += 1) {
      await appendAudit(db, {
        actorType: 'system',
        actorId: 'system',
        action: 'noop',
        occurredAt: new Date(Date.UTC(2026, 4, 24, 8, i)),
      });
    }
    const res = await app.request('/v1/admin/audit/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/ndjson/);
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment/);
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as { occurredAt: string });
    // Oldest first.
    expect(new Date(parsed[0]!.occurredAt).getTime()).toBeLessThan(
      new Date(parsed[2]!.occurredAt).getTime(),
    );
  });

  it('redacts PII in jsonb fields when redactPii=true', async () => {
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'sales-agent#x',
      action: 'compliance.block',
      // Deliberately seed a phone-like value in meta to verify the redactor
      // runs across jsonb. Callers shouldn't put PII here, but on the export
      // boundary we defend-in-depth.
      meta: { sample: 'Tel: +33611111111 — Email: foo@bar.com' },
    });
    const redactedRes = await app.request('/v1/admin/audit/export?redactPii=true');
    const redactedText = await redactedRes.text();
    expect(redactedText).not.toContain('+33611111111');
    expect(redactedText).not.toContain('foo@bar.com');
    expect(redactedText).toMatch(/\[PHONE\]/);
    expect(redactedText).toMatch(/\[EMAIL\]/);

    const plainRes = await app.request('/v1/admin/audit/export');
    const plainText = await plainRes.text();
    expect(plainText).toContain('+33611111111');
  });
});
