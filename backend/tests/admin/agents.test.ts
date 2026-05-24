/**
 * Admin agents endpoints (M15.T2) — DB-backed integration tests.
 *
 * Covers list (mapping from agents_state), kill (idempotent), and
 * setPriority (validation + audit write).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { agentsState, auditLog } from '../../src/db/schema/index.js';
import { buildAdminAgentsRouter } from '../../src/admin/agents.js';

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

d('admin/agents', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminAgentsRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE agents_state RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    app = buildAdminAgentsRouter({ db });
  });

  async function seedAgent(opts: {
    role: string;
    instanceId: string;
    status?: 'running' | 'stopped' | 'crashed';
    priority?: number;
  }): Promise<void> {
    await db.insert(agentsState).values({
      role: opts.role,
      instanceId: opts.instanceId,
      model: 'haiku',
      queue: 'test',
      status: opts.status ?? 'running',
      meta: opts.priority !== undefined ? { priority: opts.priority } : null,
    });
  }

  it('lists running agents with priority pulled from meta', async () => {
    await seedAgent({ role: 'sales-agent', instanceId: 'lead-1', priority: 3 });
    await seedAgent({ role: 'engagement-agent', instanceId: 'singleton' });
    const res = await app.request('/v1/admin/agents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ role: string; priority: number | null; inMemory: boolean }>;
    };
    expect(body.rows).toHaveLength(2);
    const sales = body.rows.find((r) => r.role === 'sales-agent');
    expect(sales?.priority).toBe(3);
    expect(sales?.inMemory).toBe(false); // not registered in this test process
    const engagement = body.rows.find((r) => r.role === 'engagement-agent');
    expect(engagement?.priority).toBeNull();
  });

  it('returns alreadyStopped:true when killing an agent not in memory', async () => {
    await seedAgent({ role: 'maxance-operator', instanceId: 'singleton', status: 'stopped' });
    const res = await app.request('/v1/admin/agents/maxance-operator/singleton/kill', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; alreadyStopped: boolean };
    expect(body.alreadyStopped).toBe(true);
    // Audit row still written.
    const audits = await db.select().from(auditLog);
    const killAudit = audits.find((a) => a.action === 'agents.kill');
    expect(killAudit).toBeDefined();
  });

  it('rejects invalid priority bodies with 400', async () => {
    await seedAgent({ role: 'sales-agent', instanceId: 'lead-1' });
    const res = await app.request('/v1/admin/agents/sales-agent/lead-1/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 99 }),
    });
    expect(res.status).toBe(400);
  });

  it('updates priority and writes an audit row', async () => {
    await seedAgent({ role: 'sales-agent', instanceId: 'lead-1', priority: 5 });
    const res = await app.request('/v1/admin/agents/sales-agent/lead-1/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 1, by: 'ridaa' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; priority: number };
    expect(body.priority).toBe(1);
    // Persisted in meta.
    const [row] = await db
      .select()
      .from(agentsState)
      .where(sql`role = 'sales-agent' AND instance_id = 'lead-1'`);
    expect((row?.meta as { priority: number }).priority).toBe(1);
    // Audit row.
    const audits = await db.select().from(auditLog);
    const priorityAudit = audits.find((a) => a.action === 'agents.priority.set');
    expect(priorityAudit).toBeDefined();
    expect(priorityAudit?.actorId).toBe('ridaa');
  });

  it('returns 404 when setting priority on an unknown agent', async () => {
    const res = await app.request('/v1/admin/agents/nope/none/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
