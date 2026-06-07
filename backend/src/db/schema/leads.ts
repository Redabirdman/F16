/**
 * `leads` — one row per lead acquisition event (design §M5).
 *
 * `customer_id` is nullable: a lead exists from the moment a form is
 * submitted, but matching/dedup against `customers` may happen seconds or
 * minutes later (or never, for junk submissions). The lead-intake flow
 * (M5) fills this in once the customer row is resolved or created.
 *
 * `raw_payload` is the unmodified webhook/form body (minus credential
 * fields like access_token). Retained for audit + replay during incidents.
 * Treated as semi-PII — the upstream channel webhooks redact secrets but
 * may still contain phone/email plaintext. Access guarded by the API
 * layer, not at the DB level (V1).
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  leadSourceEnum,
  leadStatusEnum,
  productLineEnum,
  leadPreferredChannelEnum,
  leadContactWindowEnum,
  leadCallbackStateEnum,
} from './_enums.js';
import { customers } from './customers.js';

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Set null on customer delete so the lead audit trail survives a
    // GDPR erasure (the lead itself contains no decryptable PII once the
    // customer is gone — `raw_payload` is the only residual surface).
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),

    source: leadSourceEnum('source').notNull(),
    sourceId: text('source_id'), // provider's lead ID (Meta lead-form id, etc.)
    productLine: productLineEnum('product_line').notNull(),
    status: leadStatusEnum('status').notNull().default('new'),
    score: integer('score'), // 0..100, set by the lead-scorer (M5); nullable until scored
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
    hubspotDealId: text('hubspot_deal_id'),

    // --- M12 paid-acquisition attribution + contact preferences -------------
    // The Meta `leadgen_id` from the webhook — unique per submission. Used to
    // dedup webhook re-deliveries (Meta retries on any non-2xx). Null for
    // non-Meta leads; Postgres treats NULLs as distinct so the unique index
    // does not collide across website/organic rows.
    metaLeadgenId: text('meta_leadgen_id'),
    // Full Meta attribution chain + form context (campaign/adset/ad/form ids +
    // names). jsonb so the funnel can attribute spend→revenue without new
    // columns, and so future website/Google attribution reuses the shape.
    attribution: jsonb('attribution').$type<Record<string, unknown>>(),
    // Captured on the paid lead form: how + when the prospect wants first
    // contact. `preferredChannel='call'` drives the callback scheduler below.
    preferredChannel: leadPreferredChannelEnum('preferred_channel'),
    preferredTime: leadContactWindowEnum('preferred_time'),
    // Scheduled-callback bookkeeping — only set when preferredChannel='call'.
    // The callback scheduler scans (callback_state='pending', callback_due_at<=now).
    callbackDueAt: timestamp('callback_due_at', { withTimezone: true }),
    callbackState: leadCallbackStateEnum('callback_state'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Inbox view — newest leads first.
    index('leads_created_at_idx').on(sql`${t.createdAt} DESC`),
    // Pipeline view — filter by status.
    index('leads_status_idx').on(t.status),
    // Customer detail page — list of leads for one customer.
    index('leads_customer_id_idx').on(t.customerId),
    // Dedup Meta webhook re-deliveries by leadgen id (NULLs are distinct).
    uniqueIndex('leads_meta_leadgen_id_uniq').on(t.metaLeadgenId),
    // Callback scheduler scan — find due 'pending' callbacks, oldest first.
    index('leads_callback_due_idx').on(t.callbackState, t.callbackDueAt),
  ],
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
