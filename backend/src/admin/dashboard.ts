/**
 * Admin dashboard KPIs (M14.T3).
 *
 *   GET /v1/admin/dashboard/kpis
 *     Aggregates the at-a-glance numbers Ridaa + Achraf check on a
 *     normal day:
 *       - leads in the last 24h (count + by-status split)
 *       - pending human actions (count + by-severity split)
 *       - last-24h conversation turns (inbound vs outbound count)
 *       - quotes in the last 24h (count + by-status split)
 *       - leads currently in each pipeline status (snapshot)
 *
 * Single endpoint that runs every aggregation in one round-trip rather
 * than 5 cards each fetching their own. Cheaper request shape and the
 * dashboard always renders consistent numbers across cards.
 *
 * All queries are pure COUNT aggregates over indexed columns. The
 * conversation_turns + agent_messages tables can get large; we always
 * scope by occurred_at >= now() - interval '24 hours' so the planner uses
 * the existing time-based indexes.
 */
import { Hono } from 'hono';
import { sql, and, eq, gte } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { conversationTurns, humanActions, leads, quotes } from '../db/schema/index.js';

export interface AdminDashboardRouterOptions {
  db: Database;
}

export interface DashboardKpis {
  generatedAt: string;
  leads: {
    totalLast24h: number;
    byStatusAllTime: Record<string, number>;
  };
  humanActions: {
    pendingTotal: number;
    pendingBySeverity: { critical: number; standard: number; info: number };
  };
  conversation: {
    inboundLast24h: number;
    outboundLast24h: number;
  };
  quotes: {
    totalLast24h: number;
    byStatusAllTime: Record<string, number>;
  };
}

export function buildAdminDashboardRouter(opts: AdminDashboardRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/dashboard/kpis', async (c) => {
    const since24h = new Date(Date.now() - 24 * 3600_000);

    // Run all aggregates in parallel — they're independent reads.
    const [
      leadsLast24h,
      leadsByStatusRows,
      pendingActionRows,
      turnsInRow,
      turnsOutRow,
      quotesLast24h,
      quotesByStatusRows,
    ] = await Promise.all([
      opts.db
        .select({ n: sql<number>`count(*)::int` })
        .from(leads)
        .where(gte(leads.createdAt, since24h)),
      opts.db
        .select({
          status: leads.status,
          n: sql<number>`count(*)::int`,
        })
        .from(leads)
        .groupBy(leads.status),
      opts.db
        .select({
          severity: humanActions.severity,
          n: sql<number>`count(*)::int`,
        })
        .from(humanActions)
        .where(eq(humanActions.status, 'pending'))
        .groupBy(humanActions.severity),
      opts.db
        .select({ n: sql<number>`count(*)::int` })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.direction, 'inbound'),
            gte(conversationTurns.occurredAt, since24h),
          ),
        ),
      opts.db
        .select({ n: sql<number>`count(*)::int` })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.direction, 'outbound'),
            gte(conversationTurns.occurredAt, since24h),
          ),
        ),
      opts.db
        .select({ n: sql<number>`count(*)::int` })
        .from(quotes)
        .where(gte(quotes.requestedAt, since24h)),
      opts.db
        .select({
          status: quotes.status,
          n: sql<number>`count(*)::int`,
        })
        .from(quotes)
        .groupBy(quotes.status),
    ]);

    const leadsByStatus: Record<string, number> = {};
    for (const r of leadsByStatusRows) leadsByStatus[r.status] = r.n;

    const pendingBySeverity = { critical: 0, standard: 0, info: 0 };
    for (const r of pendingActionRows) {
      if (r.severity === 1) pendingBySeverity.critical = r.n;
      else if (r.severity === 2) pendingBySeverity.standard = r.n;
      else if (r.severity === 3) pendingBySeverity.info = r.n;
    }
    const pendingTotal =
      pendingBySeverity.critical + pendingBySeverity.standard + pendingBySeverity.info;

    const quotesByStatus: Record<string, number> = {};
    for (const r of quotesByStatusRows) quotesByStatus[r.status] = r.n;

    const body: DashboardKpis = {
      generatedAt: new Date().toISOString(),
      leads: {
        totalLast24h: leadsLast24h[0]?.n ?? 0,
        byStatusAllTime: leadsByStatus,
      },
      humanActions: {
        pendingTotal,
        pendingBySeverity,
      },
      conversation: {
        inboundLast24h: turnsInRow[0]?.n ?? 0,
        outboundLast24h: turnsOutRow[0]?.n ?? 0,
      },
      quotes: {
        totalLast24h: quotesLast24h[0]?.n ?? 0,
        byStatusAllTime: quotesByStatus,
      },
    };
    return c.json(body, 200);
  });

  return app;
}
