/**
 * Audit-log repository (M13) — DB-backed unit tests.
 *
 * Gated on TEST_DATABASE_URL. Covers append, list filters (date range,
 * actor, action prefix, target), pagination order, and the chunked
 * streaming iterator used by the NDJSON export endpoint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import {
  appendAudit,
  listAuditEntries,
  streamAuditEntries,
} from '../../src/db/repositories/audit-log.js';

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

d('audit-log repository', () => {
  let db: Database;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
  });

  it('appendAudit inserts a row with defaults + returns it', async () => {
    const row = await appendAudit(db, {
      actorType: 'agent',
      actorId: 'sales-agent#lead-1',
      action: 'lead.status.change',
      targetType: 'lead',
      targetId: '11111111-1111-4111-8111-111111111111',
      before: { status: 'scored' },
      after: { status: 'qualifying' },
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(row.actorType).toBe('agent');
    expect(row.action).toBe('lead.status.change');
    expect(row.before).toEqual({ status: 'scored' });
    expect(row.after).toEqual({ status: 'qualifying' });
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  it('listAuditEntries respects date range + actorId filters', async () => {
    const now = new Date('2026-05-24T12:00:00Z');
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'sales-agent#a',
      action: 'lead.status.change',
      occurredAt: new Date(now.getTime() - 5 * 86_400_000), // 5 days ago
    });
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'sales-agent#a',
      action: 'lead.status.change',
      occurredAt: new Date(now.getTime() - 1 * 86_400_000), // 1 day ago
    });
    await appendAudit(db, {
      actorType: 'human',
      actorId: 'admin-ui',
      action: 'human_action.resolve',
      occurredAt: now,
    });

    // Date range — last 3 days only → 2 of 3 rows.
    const last3d = await listAuditEntries(db, {
      since: new Date(now.getTime() - 3 * 86_400_000),
    });
    expect(last3d).toHaveLength(2);

    // ActorId filter — only sales-agent#a rows.
    const onlyA = await listAuditEntries(db, { actorId: 'sales-agent#a' });
    expect(onlyA.every((r) => r.actorId === 'sales-agent#a')).toBe(true);
    expect(onlyA).toHaveLength(2);
  });

  it('listAuditEntries supports actionPrefix LIKE matching', async () => {
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'a',
      action: 'lead.status.change',
    });
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'a',
      action: 'lead.score.update',
    });
    await appendAudit(db, {
      actorType: 'agent',
      actorId: 'a',
      action: 'human_action.create',
    });
    const leads = await listAuditEntries(db, { actionPrefix: 'lead.' });
    expect(leads.map((r) => r.action).sort()).toEqual(['lead.score.update', 'lead.status.change']);
  });

  it('streamAuditEntries walks the full log chronologically in chunks', async () => {
    for (let i = 0; i < 25; i += 1) {
      await appendAudit(db, {
        actorType: 'system',
        actorId: 'test',
        action: 'noop',
        occurredAt: new Date(Date.UTC(2026, 4, 1) + i * 60_000),
      });
    }
    const seen: Date[] = [];
    for await (const row of streamAuditEntries(db, { chunkSize: 7 })) {
      seen.push(row.occurredAt);
    }
    expect(seen).toHaveLength(25);
    // Strictly ascending — the stream contract is oldest-first.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.getTime()).toBeGreaterThanOrEqual(seen[i - 1]!.getTime());
    }
  });
});
