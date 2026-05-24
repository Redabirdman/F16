/**
 * Admin lead-detail endpoint (M14.T4 V1) — DB-backed integration test.
 *
 * Seeds a customer + lead + a few conversation turns + a human action,
 * then hits GET /v1/admin/leads/:id and verifies the response shape.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { createAction } from '../../src/db/repositories/human-actions.js';
import { conversationTurns, leads } from '../../src/db/schema/index.js';
import { buildAdminLeadDetailRouter } from '../../src/admin/lead-detail.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

d('GET /v1/admin/leads/:id', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminLeadDetailRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    app = buildAdminLeadDetailRouter({ db });
  });

  it('returns 404 on unknown lead', async () => {
    const res = await app.request('/v1/admin/leads/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 400 on a non-UUID id', async () => {
    const res = await app.request('/v1/admin/leads/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns the full lead bundle including turns and human actions', async () => {
    const cust = await insertCustomer(db, {
      fullName: 'Marie Curie',
      phone: '+33611111111',
      email: 'marie@example.com',
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: cust.id,
        source: 'website',
        productLine: 'scooter',
        status: 'qualifying',
        score: 80,
      })
      .returning();
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      leadId: lead!.id,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      agentInstance: `lead-${lead!.id}`,
      content: 'Bonjour Marie, voici votre devis…',
      occurredAt: new Date(Date.UTC(2026, 4, 24, 10, 0)),
    });
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      leadId: lead!.id,
      channel: 'whatsapp',
      direction: 'inbound',
      content: 'Merci, je regarde.',
      occurredAt: new Date(Date.UTC(2026, 4, 24, 10, 5)),
    });
    await createAction(db, {
      createdByAgent: 'sales-agent#lead-1',
      intent: 'COMPLIANCE_BLOCKED',
      severity: 2,
      summary: 'Brouillon bloqué par la sentinelle.',
      options: [{ id: 'approve', label: 'OK', kind: 'approve' }],
      correlationId: lead!.id,
    });

    const res = await app.request(`/v1/admin/leads/${lead!.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lead: { id: string; status: string };
      customer: { displayName: string; hasPhone: boolean; hasEmail: boolean } | null;
      turns: Array<{ direction: string; content: string }>;
      humanActions: Array<{ intent: string }>;
    };
    expect(body.lead.status).toBe('qualifying');
    expect(body.customer?.displayName).toBe('Marie Curie');
    expect(body.customer?.hasPhone).toBe(true);
    expect(body.customer?.hasEmail).toBe(true);
    // Turns oldest-first.
    expect(body.turns).toHaveLength(2);
    expect(body.turns[0]?.direction).toBe('outbound');
    expect(body.turns[1]?.direction).toBe('inbound');
    // Human action correlated to this lead.
    expect(body.humanActions).toHaveLength(1);
    expect(body.humanActions[0]?.intent).toBe('COMPLIANCE_BLOCKED');
  });
});
