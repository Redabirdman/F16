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
import { sql, and, eq, gte, inArray, isNotNull, desc } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import {
  auditLog,
  conversationTurns,
  customers,
  humanActions,
  leads,
  quotes,
} from '../db/schema/index.js';
import { decryptPII } from '../db/crypto.js';

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
    /** Devis really delivered (a Maxance DR number exists), last 24 h. */
    devisDeliveredLast24h: number;
  };
  /** Voice-call operations (2026-07-07, Ridaa: "how many calls done, what is
   *  scheduled — at a glance"). */
  calls: {
    placedLast24h: number;
    scheduledUpcoming: number;
  };
  /** Booked callbacks still to come — name + due time, newest-first. */
  upcomingCallbacks: Array<{
    leadId: string;
    customerName: string;
    dueAt: string;
  }>;
  /** Plain-French recent activity, linked to leads where possible. */
  recentActivity: Array<{
    at: string;
    label: string;
    leadId?: string;
  }>;
}

/** Audit actions surfaced in the human feed, with FR label builders. */
const FEED_ACTIONS = [
  'lead.status.change',
  'voice.call.originated',
  'voice.callback.booked',
  'voice.call.requested',
  'compliance.flagged',
  'compliance.self-corrected',
  'human_action.create',
] as const;

function feedLabel(
  action: string,
  name: string | null,
  meta: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string {
  const who = name ?? 'client';
  switch (action) {
    case 'lead.status.change': {
      const to = (after?.['status'] as string | undefined) ?? '?';
      return `Lead ${who} → ${to}`;
    }
    case 'voice.call.originated':
      return `📞 Appel sortant passé (${who})`;
    case 'voice.callback.booked': {
      const due = meta?.['dueAt'] as string | undefined;
      const dueFr = due
        ? new Date(due).toLocaleString('fr-FR', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Paris',
          })
        : '?';
      return `📅 Rappel programmé ${dueFr} (${who})`;
    }
    case 'voice.call.requested':
      return `📞 Appel demandé par le client (${who})`;
    case 'compliance.flagged':
      return `⚠️ Message envoyé avec réserve conformité (${who})`;
    case 'compliance.self-corrected':
      return `♻️ Réponse auto-corrigée par l'agent (${who})`;
    case 'human_action.create':
      return `🟡 Escalade créée${name ? ` (${who})` : ''}`;
    default:
      return action;
  }
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
      devisDeliveredRow,
      callsPlacedRow,
      upcomingCallbackRows,
      feedRows,
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
      // Devis with a real Maxance DR number in the window = actually delivered.
      opts.db
        .select({ n: sql<number>`count(*)::int` })
        .from(quotes)
        .where(and(gte(quotes.requestedAt, since24h), isNotNull(quotes.maxanceDevisNumber))),
      // Outbound calls placed (audited on successful origination).
      opts.db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'voice.call.originated'), gte(auditLog.occurredAt, since24h)),
        ),
      // Booked callbacks still to come (name decrypted below).
      opts.db
        .select({
          leadId: leads.id,
          dueAt: leads.callbackDueAt,
          nameCipher: customers.fullName,
        })
        .from(leads)
        .innerJoin(customers, eq(customers.id, leads.customerId))
        .where(and(eq(leads.callbackState, 'pending'), isNotNull(leads.callbackDueAt)))
        .orderBy(leads.callbackDueAt)
        .limit(10),
      // Human-readable recent activity (allowlisted audit actions).
      opts.db
        .select({
          at: auditLog.occurredAt,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          meta: auditLog.meta,
          after: auditLog.after,
        })
        .from(auditLog)
        .where(inArray(auditLog.action, [...FEED_ACTIONS]))
        .orderBy(desc(auditLog.occurredAt))
        .limit(25),
    ]);

    // Resolve customer names for the feed (lead targets → lead→customer;
    // customer targets → customer). Batched, decrypt best-effort.
    const leadIds = new Set<string>();
    const customerIds = new Set<string>();
    for (const r of feedRows) {
      if (r.targetType === 'lead' && r.targetId) leadIds.add(r.targetId);
      if (r.targetType === 'customer' && r.targetId) customerIds.add(r.targetId);
    }
    const leadNameRows =
      leadIds.size > 0
        ? await opts.db
            .select({ id: leads.id, nameCipher: customers.fullName })
            .from(leads)
            .innerJoin(customers, eq(customers.id, leads.customerId))
            .where(inArray(leads.id, [...leadIds]))
        : [];
    const customerNameRows =
      customerIds.size > 0
        ? await opts.db
            .select({ id: customers.id, nameCipher: customers.fullName })
            .from(customers)
            .where(inArray(customers.id, [...customerIds]))
        : [];
    const safeName = (cipher: string | null): string | null => {
      if (!cipher) return null;
      try {
        return decryptPII(cipher);
      } catch {
        return null;
      }
    };
    const nameByLead = new Map(leadNameRows.map((r) => [r.id, safeName(r.nameCipher)]));
    const nameByCustomer = new Map(customerNameRows.map((r) => [r.id, safeName(r.nameCipher)]));

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
        devisDeliveredLast24h: devisDeliveredRow[0]?.n ?? 0,
      },
      calls: {
        placedLast24h: callsPlacedRow[0]?.n ?? 0,
        scheduledUpcoming: upcomingCallbackRows.length,
      },
      upcomingCallbacks: upcomingCallbackRows
        .filter((r) => r.dueAt !== null)
        .map((r) => ({
          leadId: r.leadId,
          customerName: safeName(r.nameCipher) ?? 'Client',
          dueAt: (r.dueAt as Date).toISOString(),
        })),
      recentActivity: feedRows.map((r) => {
        const name =
          r.targetType === 'lead' && r.targetId
            ? (nameByLead.get(r.targetId) ?? null)
            : r.targetType === 'customer' && r.targetId
              ? (nameByCustomer.get(r.targetId) ?? null)
              : null;
        return {
          at: r.at.toISOString(),
          label: feedLabel(
            r.action,
            name,
            (r.meta ?? null) as Record<string, unknown> | null,
            (r.after ?? null) as Record<string, unknown> | null,
          ),
          ...(r.targetType === 'lead' && r.targetId ? { leadId: r.targetId } : {}),
        };
      }),
    };
    return c.json(body, 200);
  });

  return app;
}
