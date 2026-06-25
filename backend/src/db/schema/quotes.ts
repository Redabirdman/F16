/**
 * `quotes` + `maxance_actions` (design §9 + §14).
 *
 * One `quotes` row is a single Maxance quote session — the unit of work the
 * Maxance Operator (M8) drives end-to-end. Each granular UI step it performs
 * (set vehicle type, fill driver field, click submit, …) is logged as a
 * `maxance_actions` row carrying the action intent, screenshots, timings,
 * and result. The two together form a replayable audit trail.
 *
 * Cascade rules:
 *   - `quotes.customer_id` → cascade: the customer owns their quote history;
 *     a GDPR erasure of a customer wipes their quotes too.
 *   - `quotes.lead_id`     → set null: a single lead can spawn multiple quote
 *     attempts (e.g. retry after Maxance failure), and deleting a lead must
 *     not destroy the quote audit trail attached to the customer.
 *   - `maxance_actions.quote_id` → cascade: the action log is meaningless
 *     without its parent quote.
 *
 * Step ordering invariant:
 *   `(quote_id, step_index)` is UNIQUE. `step_index` is a 0-based monotonic
 *   counter per quote. The repository computes the next value atomically in
 *   the INSERT itself (`SELECT COALESCE(MAX(step_index), -1) + 1 ...`) so
 *   that concurrent appenders cannot collide — the unique index is the
 *   second line of defence.
 *
 * Numeric precision:
 *   `numeric(10, 2)` carries prices in € with cent precision up to 8 digits
 *   before the decimal point — comfortably above any plausible monthly
 *   premium or comptant fee for personal mobility insurance.
 *
 * No PII encryption: a quote contains product + price + a Maxance reference
 * number, none of which is PII. The customer linkage is by FK only; PII
 * resolution goes through the customers repo.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { productLineEnum, quoteStatusEnum } from './_enums.js';
import { customers } from './customers.js';
import { leads } from './leads.js';

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    customerId: uuid('customer_id')
      .references(() => customers.id, { onDelete: 'cascade' })
      .notNull(),
    // One lead can produce multiple quote attempts (retry, alt product). Set
    // null on lead delete so the quote outlives the lead lifecycle row.
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),

    product: productLineEnum('product').notNull(),
    // Open-ended within a product line: 'malus' | 'bonus' | 'pro' | … —
    // Maxance's UI exposes new variants behind feature flags faster than we
    // can ship enum migrations.
    productVariant: text('product_variant').notNull(),

    status: quoteStatusEnum('status').notNull().default('requested'),

    // Prices in €. Numeric for exactness (never use float for money).
    monthlyPremium: numeric('monthly_premium', { precision: 10, scale: 2 }),
    comptantDue: numeric('comptant_due', { precision: 10, scale: 2 }),

    // Maxance's own ref shown in their UI, e.g. "DR0000971882". Kept as
    // text — opaque to us, used for cross-referencing in their portal.
    maxanceDevisNumber: text('maxance_devis_number'),

    pdfUrl: text('pdf_url'),

    // --- M8.T7 closing (souscription) lifecycle ---
    // Deliberately `text` with a TS-level enum rather than a pg ENUM: the
    // closing flow is young and will grow states (e.g. payment-confirmed)
    // faster than we want to ship `ALTER TYPE ... ADD VALUE` migrations.
    // Happy path: none → requested → in_progress → pending_inspector →
    // contract_issued. Sad path: any → failed.
    subscriptionStatus: text('subscription_status', {
      enum: ['none', 'requested', 'in_progress', 'pending_inspector', 'contract_issued', 'failed'],
    })
      .notNull()
      .default('none'),
    // Maxance souscripteur/instance ref from the Paiement page (e.g. "T…").
    souscripteurRef: text('souscripteur_ref'),
    // "Comptant dû" shown on the Coordonnées bancaires page, €.
    montantComptant: numeric('montant_comptant', { precision: 10, scale: 2 }),
    // Comptant à régler breakdown read from the portal (frais de gestion /
    // commission / frais de dossier …) — opaque audit payload.
    fraisBreakdown: jsonb('frais_breakdown').$type<Record<string, unknown>>(),
    // Stripe payment link the customer pays the Assuryal frais through.
    stripePaymentLinkUrl: text('stripe_payment_link_url'),
    subscriptionRequestedAt: timestamp('subscription_requested_at', { withTimezone: true }),
    subscriptionCompletedAt: timestamp('subscription_completed_at', { withTimezone: true }),

    // Correlates this quote with the maxance_actions rows produced for it.
    // UNIQUE — exactly one quote per Maxance Operator session.
    sessionId: text('session_id').notNull(),

    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    rawFormData: jsonb('raw_form_data').$type<Record<string, unknown>>(),
    rawResponse: jsonb('raw_response').$type<Record<string, unknown>>(),
  },
  (t) => [
    // Customer detail page — list of quotes for one customer.
    index('quotes_customer_id_idx').on(t.customerId),
    // Lead detail page — list of quote attempts for one lead.
    index('quotes_lead_id_idx').on(t.leadId),
    // Pipeline view — filter quotes by status.
    index('quotes_status_idx').on(t.status),
    // Session correlation — one quote per Maxance session.
    uniqueIndex('quotes_session_id_uniq').on(t.sessionId),
    // Default ordering — newest quotes first.
    index('quotes_requested_at_idx').on(sql`${t.requestedAt} DESC`),
  ],
);

export const maxanceActions = pgTable(
  'maxance_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    quoteId: uuid('quote_id')
      .references(() => quotes.id, { onDelete: 'cascade' })
      .notNull(),

    // Denormalized from quotes.session_id so the Maxance Operator can stream
    // actions in by session without an extra join.
    sessionId: text('session_id').notNull(),

    // The natural-language intent issued to the Operator
    // (e.g. "Set vehicle type to 'Trottinette électrique'").
    actionText: text('action_text').notNull(),

    // 0-based monotonic per quote_id. See "Step ordering invariant" above.
    stepIndex: integer('step_index').notNull(),

    // Short label for grouping/metrics ("vehicle.set_type"). Optional.
    stepName: text('step_name'),

    screenshotBeforeUrl: text('screenshot_before_url'),
    screenshotAfterUrl: text('screenshot_after_url'),

    durationMs: integer('duration_ms'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Hard invariant — no two actions can share the same step in a quote.
    // Doubles as the per-quote-ordered-scan index (leading column = quote_id).
    uniqueIndex('maxance_actions_quote_step_uniq').on(t.quoteId, t.stepIndex),
    // Session-keyed lookups (Operator stream).
    index('maxance_actions_session_id_idx').on(t.sessionId),
    // Forensics view — most recent activity first.
    index('maxance_actions_occurred_at_idx').on(sql`${t.occurredAt} DESC`),
  ],
);

export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
export type MaxanceAction = typeof maxanceActions.$inferSelect;
export type NewMaxanceAction = typeof maxanceActions.$inferInsert;
