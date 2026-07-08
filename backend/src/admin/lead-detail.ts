/**
 * Admin lead-detail endpoint (M14.T4).
 *
 *   GET /v1/admin/leads/:id
 *     Full per-lead view: lead row + customer summary (decrypted name +
 *     channel-bool flags, NOT the raw phone/email) + the last 200
 *     conversation turns oldest-first + every quote attempt for the lead
 *     + every human-action correlated to the lead.
 *
 * PII discipline: the admin operator is Ridaa/Achraf (trusted), but we
 * still keep the response tight — only the customer's first+last name
 * decrypts on the way out. Raw phone/email stay encrypted; we expose
 * boolean "has phone/email" flags so the UI can show channel availability
 * without leaking the address itself. If the operator needs to dial,
 * they go to HubSpot or the customer record directly (V0 of the customer
 * record stays out of scope for M14 — V1 expansion target).
 *
 * 404 on unknown leadId. 200 with empty arrays when the lead exists but
 * has no turns / quotes / actions yet.
 */
import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
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
import { logger } from '../logger.js';
import { FEED_ACTIONS, feedLabel } from './dashboard.js';

export interface AdminLeadDetailRouterOptions {
  db: Database;
  /** Max conversation turns returned in one response. Default 200. */
  maxTurns?: number;
}

export interface LeadDetailResponse {
  lead: {
    id: string;
    status: string;
    source: string;
    sourceId: string | null;
    productLine: string;
    score: number | null;
    hubspotDealId: string | null;
    createdAt: string;
    scoredAt: string | null;
    updatedAt: string;
    /** Booked phone callback still pending (redesign 2026-07-08). */
    callbackDueAt: string | null;
    callbackState: string | null;
  };
  customer: {
    id: string;
    displayName: string | null;
    civility: string | null;
    hasPhone: boolean;
    hasEmail: boolean;
    vehicle: Record<string, unknown> | null;
    driver: Record<string, unknown> | null;
    createdAt: string;
  } | null;
  turns: Array<{
    id: string;
    channel: string;
    direction: 'inbound' | 'outbound';
    agentRole: string | null;
    agentInstance: string | null;
    content: string;
    occurredAt: string;
  }>;
  quotes: Array<{
    id: string;
    status: string;
    product: string;
    productVariant: string;
    monthlyPremiumEur: number | null;
    comptantDueEur: number | null;
    maxanceDevisNumber: string | null;
    requestedAt: string;
    readyAt: string | null;
    deliveredAt: string | null;
  }>;
  humanActions: Array<{
    id: string;
    intent: string;
    severity: number;
    status: string;
    summary: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  /**
   * Plain-French audit events about this lead (status changes, calls,
   * callbacks, compliance) — merged client-side with turns + quotes into
   * the unified timeline (redesign 2026-07-08).
   */
  events: Array<{
    id: string;
    at: string;
    action: string;
    label: string;
  }>;
}

export function buildAdminLeadDetailRouter(opts: AdminLeadDetailRouterOptions): Hono {
  const app = new Hono();
  const maxTurns = opts.maxTurns ?? 200;

  app.get('/v1/admin/leads/:id', async (c) => {
    const leadId = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
      return c.json({ error: 'invalid_lead_id' }, 400);
    }

    const [lead] = await opts.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return c.json({ error: 'lead_not_found' }, 404);
    }

    // Customer summary — null when the lead hasn't been matched yet (intake
    // race). Decrypt fullName best-effort: a junk cipher logs + returns null
    // rather than 500ing the whole detail view.
    let customer: LeadDetailResponse['customer'] = null;
    if (lead.customerId) {
      const [c0] = await opts.db
        .select()
        .from(customers)
        .where(eq(customers.id, lead.customerId))
        .limit(1);
      if (c0) {
        let displayName: string | null = null;
        try {
          displayName = decryptPII(c0.fullName);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), customerId: c0.id },
            'admin/lead-detail: fullName decrypt failed (returning null)',
          );
        }
        customer = {
          id: c0.id,
          displayName,
          civility: c0.civility ?? null,
          hasPhone: Boolean(c0.phone),
          hasEmail: Boolean(c0.email),
          vehicle: (c0.vehicle as Record<string, unknown> | null) ?? null,
          driver: (c0.driver as Record<string, unknown> | null) ?? null,
          createdAt: c0.createdAt.toISOString(),
        };
      }
    }

    // Conversation turns — oldest first so the UI renders the thread top→
    // bottom without re-reversing. Cap at maxTurns; if the conversation is
    // longer than that, V1 enhancement is "load older" pagination.
    const turnRows = lead.customerId
      ? await opts.db
          .select()
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.customerId, lead.customerId),
              eq(conversationTurns.leadId, lead.id),
            ),
          )
          .orderBy(asc(conversationTurns.occurredAt))
          .limit(maxTurns)
      : [];

    // Quote attempts — every row for this lead, newest first so the
    // operator sees the latest first.
    const quoteRows = await opts.db
      .select()
      .from(quotes)
      .where(eq(quotes.leadId, lead.id))
      .orderBy(desc(quotes.requestedAt));

    // Human actions — by correlation_id = leadId. Same correlation contract
    // every agent uses when creating actions about a lead (sales-agent
    // compliance blocks, engagement-agent dormant escalation, etc.).
    const actionRows = await opts.db
      .select()
      .from(humanActions)
      .where(eq(humanActions.correlationId, lead.id))
      .orderBy(desc(humanActions.createdAt));

    // Audit events about this lead (or its customer) — the timeline's
    // "what the system did" entries: status changes, calls, callbacks,
    // compliance flags. Same allowlist + FR labels as the dashboard feed.
    const eventTargets = [
      and(eq(auditLog.targetType, 'lead'), eq(auditLog.targetId, lead.id)),
      ...(lead.customerId
        ? [and(eq(auditLog.targetType, 'customer'), eq(auditLog.targetId, lead.customerId))]
        : []),
    ];
    const eventRows = await opts.db
      .select({
        id: auditLog.id,
        at: auditLog.occurredAt,
        action: auditLog.action,
        meta: auditLog.meta,
        after: auditLog.after,
      })
      .from(auditLog)
      .where(and(inArray(auditLog.action, [...FEED_ACTIONS]), or(...eventTargets)))
      .orderBy(asc(auditLog.occurredAt))
      .limit(200);

    const body: LeadDetailResponse = {
      lead: {
        id: lead.id,
        status: lead.status,
        source: lead.source,
        sourceId: lead.sourceId ?? null,
        productLine: lead.productLine,
        score: lead.score,
        hubspotDealId: lead.hubspotDealId ?? null,
        createdAt: lead.createdAt.toISOString(),
        scoredAt: lead.scoredAt ? lead.scoredAt.toISOString() : null,
        updatedAt: lead.updatedAt.toISOString(),
        callbackDueAt: lead.callbackDueAt ? lead.callbackDueAt.toISOString() : null,
        callbackState: lead.callbackState ?? null,
      },
      customer,
      turns: turnRows.map((t) => ({
        id: t.id,
        channel: t.channel,
        direction: t.direction,
        agentRole: t.agentRole,
        agentInstance: t.agentInstance,
        content: t.content,
        occurredAt: t.occurredAt.toISOString(),
      })),
      quotes: quoteRows.map((q) => ({
        id: q.id,
        status: q.status,
        product: q.product,
        productVariant: q.productVariant,
        monthlyPremiumEur: q.monthlyPremium !== null ? Number(q.monthlyPremium) : null,
        comptantDueEur: q.comptantDue !== null ? Number(q.comptantDue) : null,
        maxanceDevisNumber: q.maxanceDevisNumber ?? null,
        requestedAt: q.requestedAt.toISOString(),
        readyAt: q.readyAt ? q.readyAt.toISOString() : null,
        deliveredAt: q.deliveredAt ? q.deliveredAt.toISOString() : null,
      })),
      humanActions: actionRows.map((a) => ({
        id: a.id,
        intent: a.intent,
        severity: a.severity,
        status: a.status,
        summary: a.summary,
        createdAt: a.createdAt.toISOString(),
        resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
      })),
      events: eventRows.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        action: e.action,
        // Name intentionally omitted — the page already shows the customer;
        // "client" reads fine inside their own timeline.
        label: feedLabel(
          e.action,
          null,
          (e.meta ?? null) as Record<string, unknown> | null,
          (e.after ?? null) as Record<string, unknown> | null,
        ),
      })),
    };

    return c.json(body, 200);
  });

  return app;
}
