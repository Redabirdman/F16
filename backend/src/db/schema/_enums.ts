/**
 * Postgres ENUM types — single source of truth.
 *
 * Each `pgEnum(name, [...])` produces:
 *   - a TypeScript union you can import for column types and zod schemas,
 *   - a `CREATE TYPE "<name>" AS ENUM (...)` in the generated migration.
 *
 * Adding a value later requires `ALTER TYPE ... ADD VALUE` (irreversible in
 * the same tx) — keep this list curated. Reordering is a breaking change.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// Lead acquisition channel. 'other' is the catch-all so unknown sources don't
// block intake; the source_id column carries the provider-specific reference.
export const leadSourceEnum = pgEnum('lead_source', [
  'website',
  'meta',
  'organic',
  'referral',
  'other',
]);

// Lead lifecycle state machine (see design §M5). Forward-only in practice;
// `dormant` is the only "rewindable" state via re-engagement.
export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'scored',
  'qualifying',
  'quoting',
  'negotiating',
  'awaiting_payment',
  'closed_won',
  'closed_lost',
  'dormant',
]);

// Product family — drives which quoter/agent flow handles the lead.
export const productLineEnum = pgEnum('product_line', ['scooter', 'car']);

// Conversation channels — must mirror the ConversationChannel.id union in
// `src/channels/*` (design §8). Adding a value here means a new channel impl.
export const channelEnum = pgEnum('channel', ['whatsapp', 'voice', 'email', 'sms']);

// Conversation direction relative to Assuryal: inbound = from customer.
export const directionEnum = pgEnum('direction', ['inbound', 'outbound']);

// Customer fact taxonomy (design §7.1). 'event' covers timestamped state
// changes that aren't preferences/objections (e.g. "renewed in 2024").
export const factTypeEnum = pgEnum('fact_type', [
  'objection',
  'preference',
  'observation',
  'event',
]);

// Quote lifecycle (design §9 + §14). Forward-only in the happy path:
//   draft → requested → in_progress → ready → sent → accepted
// Terminal sad paths: rejected (customer declined) or expired (TTL elapsed
// with no acceptance). 'draft' exists for quotes assembled in admin before
// being dispatched to Maxance; the Maxance flow starts at 'requested'.
export const quoteStatusEnum = pgEnum('quote_status', [
  'draft',
  'requested',
  'in_progress',
  'ready',
  'sent',
  'accepted',
  'rejected',
  'expired',
]);
