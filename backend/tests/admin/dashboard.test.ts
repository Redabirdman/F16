/**
 * Admin dashboard KPIs (M14.T3) — DB-backed integration test.
 *
 * Seeds a small mix of leads + quotes + conversation turns + a pending
 * human action and verifies the aggregated shape.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { conversationTurns, leads, quotes } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { createAction } from '../../src/db/repositories/human-actions.js';
import { buildAdminDashboardRouter } from '../../src/admin/dashboard.js';

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

d('GET /v1/admin/dashboard/kpis', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminDashboardRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE quotes RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    app = buildAdminDashboardRouter({ db });
  });

  it('returns zeroes on an empty database', async () => {
    const res = await app.request('/v1/admin/dashboard/kpis');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      leads: { totalLast24h: number };
      humanActions: { pendingTotal: number };
      conversation: { inboundLast24h: number; outboundLast24h: number };
      quotes: { totalLast24h: number };
    };
    expect(body.leads.totalLast24h).toBe(0);
    expect(body.humanActions.pendingTotal).toBe(0);
    expect(body.conversation.inboundLast24h).toBe(0);
    expect(body.conversation.outboundLast24h).toBe(0);
    expect(body.quotes.totalLast24h).toBe(0);
    // Redesign 2026-07-08: continuous 14-day series even when empty.
    const extended = body as unknown as {
      timeseries: Array<{ day: string; inbound: number }>;
      agentActivity: Array<{ role: string; count: number }>;
    };
    expect(extended.timeseries).toHaveLength(14);
    expect(extended.timeseries.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.day))).toBe(true);
  });

  it('aggregates counts correctly across all dimensions', async () => {
    const cust = await insertCustomer(db, { fullName: 'Marie', phone: '+33611111111' });
    // 2 leads in the last 24h, one older than 24h.
    await db.insert(leads).values({
      customerId: cust.id,
      source: 'website',
      productLine: 'scooter',
      status: 'qualifying',
      score: 80,
    });
    await db.insert(leads).values({
      customerId: cust.id,
      source: 'website',
      productLine: 'car',
      status: 'quoting',
      score: 70,
    });
    await db.insert(leads).values({
      customerId: cust.id,
      source: 'website',
      productLine: 'scooter',
      status: 'closed_won',
      score: 100,
      createdAt: new Date(Date.now() - 48 * 3600_000),
    });

    // 3 turns: 2 inbound, 1 outbound, all in the last 24h.
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      channel: 'whatsapp',
      direction: 'inbound',
      content: 'hello',
    });
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      channel: 'whatsapp',
      direction: 'inbound',
      content: 'hello again',
    });
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      content: 'bonjour',
    });

    // One pending critical action.
    await createAction(db, {
      createdByAgent: 'sales-agent#x',
      intent: 'COMPLIANCE_BLOCKED',
      severity: 1,
      summary: 'critical',
      options: [{ id: 'a', label: 'a', kind: 'approve' }],
    });

    // One quote in the last 24h.
    await db.insert(quotes).values({
      customerId: cust.id,
      product: 'scooter',
      productVariant: 'std',
      status: 'requested',
      sessionId: 'sess-1',
    });

    const res = await app.request('/v1/admin/dashboard/kpis');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      leads: { totalLast24h: number; byStatusAllTime: Record<string, number> };
      humanActions: {
        pendingTotal: number;
        pendingBySeverity: { critical: number; standard: number; info: number };
      };
      conversation: { inboundLast24h: number; outboundLast24h: number };
      quotes: { totalLast24h: number; byStatusAllTime: Record<string, number> };
    };
    expect(body.leads.totalLast24h).toBe(2);
    expect(body.leads.byStatusAllTime.qualifying).toBe(1);
    expect(body.leads.byStatusAllTime.quoting).toBe(1);
    expect(body.leads.byStatusAllTime.closed_won).toBe(1);
    expect(body.humanActions.pendingTotal).toBe(1);
    expect(body.humanActions.pendingBySeverity.critical).toBe(1);
    expect(body.conversation.inboundLast24h).toBe(2);
    expect(body.conversation.outboundLast24h).toBe(1);
    expect(body.quotes.totalLast24h).toBe(1);
    expect(body.quotes.byStatusAllTime.requested).toBe(1);

    // Redesign 2026-07-08: today's bucket carries the seeded traffic and the
    // agents donut sees the outbound sales-agent turn.
    const extended = body as unknown as {
      timeseries: Array<{
        day: string;
        inbound: number;
        outbound: number;
        quotesRequested: number;
      }>;
      agentActivity: Array<{ role: string; count: number }>;
    };
    expect(extended.timeseries).toHaveLength(14);
    const today = extended.timeseries[extended.timeseries.length - 1]!;
    expect(today.inbound).toBe(2);
    expect(today.outbound).toBe(1);
    expect(today.quotesRequested).toBe(1);
    const sales = extended.agentActivity.find((a) => a.role === 'sales-agent');
    expect(sales?.count).toBe(1);
  });
});
