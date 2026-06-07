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

// Lead's preferred FIRST-contact channel, captured on paid lead forms (M12).
// 'call' is routed to the voice channel (voice-operator callback); 'whatsapp'
// flows through the normal Sales-Agent welcome. Kept distinct from `channel`
// because it is the customer's stated preference, not a live conversation leg.
export const leadPreferredChannelEnum = pgEnum('lead_preferred_channel', ['whatsapp', 'call']);

// Preferred contact-time window from the paid lead form (M12). 'maintenant' =
// ASAP; the others map to a next-occurrence slot in Europe/Paris.
export const leadContactWindowEnum = pgEnum('lead_contact_window', [
  'maintenant',
  'matin',
  'apres_midi',
  'soir',
]);

// Scheduled-callback lifecycle for paid leads who chose 'call' (M12). The
// callback scheduler scans 'pending' rows whose callback_due_at has arrived,
// emits VOICE.CALL_SCHEDULED, and flips the row to 'dispatched'.
export const leadCallbackStateEnum = pgEnum('lead_callback_state', [
  'pending',
  'dispatched',
  'cancelled',
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

// Agent lifecycle status (M3.T7). Forward-only in the happy path:
//   starting → running → stopping → stopped
// Sad path: any → crashed. A subsequent successful spawn for the same
// (role, instance_id) upserts the row back to 'starting'/'running' — the
// crash record is overwritten by design (the latest spawn wins).
export const agentStatusEnum = pgEnum('agent_status', [
  'starting',
  'running',
  'stopping',
  'stopped',
  'crashed',
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
