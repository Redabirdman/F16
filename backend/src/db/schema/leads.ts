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
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { leadSourceEnum, leadStatusEnum, productLineEnum } from './_enums.js';
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
  ],
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
