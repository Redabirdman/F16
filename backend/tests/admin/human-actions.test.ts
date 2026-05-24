/**
 * Admin human-actions endpoints (M14.T5) — DB-backed integration tests.
 *
 * Verifies list filtering + the resolve flow (idempotent + emits
 * HUMAN_ACTION.RESOLVED + writes audit rows).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { createAction } from '../../src/db/repositories/human-actions.js';
import { buildAdminHumanActionsRouter } from '../../src/admin/human-actions.js';
import { agentMessages, auditLog, humanActions } from '../../src/db/schema/index.js';

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

d('GET /v1/admin/human-actions + POST /resolve', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminHumanActionsRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    app = buildAdminHumanActionsRouter({ db });
  });

  async function seedAction(): Promise<string> {
    const row = await createAction(db, {
      createdByAgent: 'sales-agent#lead-1',
      intent: 'APPROVE_REFUND',
      severity: 2,
      summary: 'Le client demande un remboursement.',
      options: [
        { id: 'approve', label: 'Approuver', kind: 'approve' },
        { id: 'reject', label: 'Refuser', kind: 'reject' },
      ],
      correlationId: 'lead-1',
    });
    return row.id;
  }

  it('lists pending actions', async () => {
    await seedAction();
    const res = await app.request('/v1/admin/human-actions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ status: string; intent: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.status).toBe('pending');
    expect(body.rows[0]?.intent).toBe('APPROVE_REFUND');
  });

  it('resolves an action and emits HUMAN_ACTION.RESOLVED', async () => {
    const id = await seedAction();
    const res = await app.request(`/v1/admin/human-actions/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenOptionId: 'approve', by: 'ridaa' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      row: { status: string; resolvedBy: string };
      alreadyResolved: boolean;
    };
    expect(body.alreadyResolved).toBe(false);
    expect(body.row.status).toBe('resolved');
    expect(body.row.resolvedBy).toBe('ridaa');

    // Row mutated.
    const [persisted] = await db
      .select()
      .from(humanActions)
      .where(sql`id = ${id}`);
    expect(persisted?.status).toBe('resolved');

    // HUMAN_ACTION.RESOLVED dispatched.
    const msgs = await db.select().from(agentMessages);
    const emitted = msgs.find((m) => m.intent === 'HUMAN_ACTION.RESOLVED');
    expect(emitted).toBeDefined();
    expect(emitted?.toRole).toBe('human-router');

    // Audit row appended for the admin-level resolve.
    const auditRows = await db.select().from(auditLog);
    const resolveAudit = auditRows.find((r) => r.action === 'human_action.resolve');
    expect(resolveAudit).toBeDefined();
    expect(resolveAudit?.actorType).toBe('human');
    expect(resolveAudit?.actorId).toBe('ridaa');
  });

  it('returns 409 + the row when resolving an already-resolved action', async () => {
    const id = await seedAction();
    // First resolve.
    await app.request(`/v1/admin/human-actions/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenOptionId: 'approve' }),
    });
    // Second resolve.
    const res = await app.request(`/v1/admin/human-actions/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenOptionId: 'reject' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { alreadyResolved: boolean; row: { status: string } };
    expect(body.alreadyResolved).toBe(true);
    expect(body.row.status).toBe('resolved');
  });

  it('returns 400 on unknown option id', async () => {
    const id = await seedAction();
    const res = await app.request(`/v1/admin/human-actions/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenOptionId: 'something-else' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_option_id');
  });

  it('returns 404 on unknown action id', async () => {
    const res = await app.request(
      `/v1/admin/human-actions/00000000-0000-4000-8000-000000000000/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chosenOptionId: 'approve' }),
      },
    );
    expect(res.status).toBe(404);
  });
});
