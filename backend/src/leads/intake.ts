/**
 * Lead intake — pure logic + DB layer (M5.T1).
 *
 * The HTTP transport in `intake-http.ts` calls into `ingestLead()`, which:
 *   1. normalizes phone numbers into E.164 (best-effort French default),
 *   2. matches an existing customer via `phone_hash` when phone is present,
 *      otherwise creates a fresh customer stub,
 *   3. writes a NEW `leads` row for every submission (status='new'),
 *   4. emits a `LEAD.NEW` agent message via the dispatcher for the Lead
 *      Scorer (M5.T3) to pick up.
 *
 * Why a new lead row even on dedup: the lead row is the audit trail for the
 * acquisition event. Two website submissions from the same phone are two
 * separate signals (the customer cared enough to submit twice) — collapsing
 * them would erase the second one from analytics + Sales-Agent context.
 *
 * Customer matching by email is intentionally NOT done in V1. Adding an
 * `email_hash` column is M5.T1a scope; for now, no-phone leads always create
 * a new customer stub and the Sales Agent reconciles duplicates downstream
 * once a WhatsApp handle is established.
 */
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { leads } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { sendMessage } from '../messaging/dispatcher.js';
import { insertCustomer, getCustomerByPhone } from '../db/repositories/customers.js';

/**
 * Inbound lead shape — the WIRE format we accept from any source (website
 * form, Meta lead-form forwarder, etc.). All PII fields optional; we ingest
 * what we can and write encrypted via the customers repo.
 *
 * `formAnswers` and `raw` are kept as opaque jsonb on the lead row for audit
 * + replay. They're merged into the emitted `LEAD.NEW` payload so the Lead
 * Scorer doesn't need a second DB roundtrip.
 */
export const LeadIntakePayloadSchema = z.object({
  source: z.enum(['website', 'meta', 'organic', 'referral', 'other']),
  /** Provider's lead id (Meta lead id, website form submission id, etc.). */
  sourceId: z.string().optional(),
  productLine: z.enum(['scooter', 'car']),

  // PII (optional — at least one of email/phone strongly preferred).
  fullName: z.string().optional(),
  email: z.string().email().optional(),
  /** E.164 preferred; best-effort normalized for French numbers. */
  phone: z.string().optional(),

  // Free-form context.
  formAnswers: z.record(z.string(), z.unknown()).optional(),
  /** The exact source-payload for audit (Meta webhook body, form POST, …). */
  raw: z.record(z.string(), z.unknown()).optional(),

  // --- M12 paid-acquisition (Meta lead forms) -----------------------------
  /** Meta `leadgen_id` — dedup key for webhook retries. */
  metaLeadgenId: z.string().optional(),
  /** Full attribution chain (campaign/adset/ad/form ids + names). */
  attribution: z.record(z.string(), z.unknown()).optional(),
  /** Captured preference: how the prospect wants first contact. */
  preferredChannel: z.enum(['whatsapp', 'call']).optional(),
  /** Captured preference: when the prospect wants first contact. */
  preferredTime: z.enum(['maintenant', 'matin', 'apres_midi', 'soir']).optional(),
  /**
   * When to place the callback (ISO-8601). Set by the Meta webhook for
   * `call` leads; the callback scheduler dials at/after this time.
   */
  callbackDueAt: z.string().datetime().optional(),
});
export type LeadIntakePayload = z.infer<typeof LeadIntakePayloadSchema>;

export interface IngestedLead {
  leadId: string;
  /** Matched or newly created customer; never null in the V1 flow. */
  customerId: string;
  dedup: 'new_customer' | 'matched_existing';
  source: LeadIntakePayload['source'];
  productLine: LeadIntakePayload['productLine'];
}

/**
 * Best-effort phone normalization into E.164.
 *
 * Rules:
 *   - strip whitespace, dashes, parens, dots,
 *   - if already starts with `+`, keep digits after it,
 *   - if 9 digits and starts with `6` or `7` -> assume French mobile,
 *   - if 10 digits and starts with `0` -> French national; strip leading 0 + prefix `+33`,
 *   - if 11+ digits without `+` -> reject (ambiguous country),
 *   - returns `null` when we can't produce something that looks E.164-ish.
 *
 * This is deliberately conservative: a bad normalization that silently maps
 * two distinct numbers to the same string would corrupt the phone_hash
 * dedup. When in doubt we return null and the caller falls back to "new
 * customer with no phone".
 */
export function normalizePhone(input: string | undefined | null): string | null {
  if (!input) return null;
  // Keep '+' if it's the first char; strip everything non-digit.
  const trimmed = input.trim();
  const startsWithPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length === 0) return null;

  if (startsWithPlus) {
    // Already E.164-ish — return canonical `+` + digits. Reject obviously
    // too-short numbers (E.164 mandates 8–15 digits).
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  // No '+' — try French defaults.
  if (digits.length === 10 && digits.startsWith('0')) {
    return `+33${digits.slice(1)}`;
  }
  if (digits.length === 9 && (digits.startsWith('6') || digits.startsWith('7'))) {
    return `+33${digits}`;
  }
  // Could be a French number with the country code but no '+' (e.g. '33612345678').
  if (digits.length === 11 && digits.startsWith('33')) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Match an existing customer by phone, or create a new one. Returns the
 * customer id + whether it was a match or a fresh insert.
 */
async function resolveCustomer(
  db: Database,
  payload: LeadIntakePayload,
  normalizedPhone: string | null,
): Promise<{ id: string; dedup: 'new_customer' | 'matched_existing' }> {
  // Try phone match first — phone_hash is HMAC-keyed so we can equality-
  // lookup without decrypting any other customer row.
  if (normalizedPhone) {
    const existing = await getCustomerByPhone(db, normalizedPhone);
    if (existing) {
      return { id: existing.id, dedup: 'matched_existing' };
    }
  }

  // No match (or no phone) — create a new customer stub. The customers repo
  // handles encryption + hashing; we just pass plaintext.
  //
  // `fullName` is NOT NULL at the DB level. When the payload has no name we
  // fall back to a stable placeholder so the row passes the constraint and
  // is easy to spot in admin views ("Lead <source>" rather than "Unknown").
  const fullName = payload.fullName?.trim() || `Lead ${payload.source}`;
  const created = await insertCustomer(db, {
    fullName,
    email: payload.email ?? null,
    phone: normalizedPhone,
  });
  return { id: created.id, dedup: 'new_customer' };
}

/**
 * Ingest a lead end-to-end:
 *   1. normalize phone,
 *   2. match-or-create customer,
 *   3. insert a `leads` row (always),
 *   4. emit `LEAD.NEW`.
 *
 * Returns the leadId + customerId so the HTTP layer can echo them.
 *
 * Throws on DB errors. The caller (HTTP handler) maps to 500 and avoids
 * leaking PII into the response body.
 */
export async function ingestLead(db: Database, payload: LeadIntakePayload): Promise<IngestedLead> {
  const normalizedPhone = normalizePhone(payload.phone);

  // 1+2. Customer match-or-create.
  const customer = await resolveCustomer(db, payload, normalizedPhone);

  // 3. Insert the lead row. Even on a customer match we want a fresh row —
  //    two form submissions are two signals (see header comment).
  //
  //    raw_payload is the union of `formAnswers` and `raw`; we don't store
  //    plaintext PII here beyond what the upstream forwarder included. The
  //    column is jsonb and access is gated by the API layer in V1.
  const mergedRaw =
    payload.formAnswers || payload.raw
      ? { ...(payload.formAnswers ?? {}), ...(payload.raw ?? {}) }
      : null;

  // M12: a `call`-preference lead schedules a voice callback. We persist the
  // due time + a 'pending' state; the callback scheduler (callback-scheduler.ts)
  // is the single emitter of VOICE.CALL_SCHEDULED, so even 'maintenant' flows
  // through one idempotent path (dialed on the next tick, ~1 min).
  const isCallback = payload.preferredChannel === 'call';
  const callbackDueAt = isCallback
    ? payload.callbackDueAt
      ? new Date(payload.callbackDueAt)
      : new Date()
    : null;

  const [insertedLead] = await db
    .insert(leads)
    .values({
      customerId: customer.id,
      source: payload.source,
      sourceId: payload.sourceId ?? null,
      productLine: payload.productLine,
      status: 'new',
      score: null,
      rawPayload: mergedRaw,
      metaLeadgenId: payload.metaLeadgenId ?? null,
      attribution: payload.attribution ?? null,
      preferredChannel: payload.preferredChannel ?? null,
      preferredTime: payload.preferredTime ?? null,
      callbackDueAt,
      callbackState: isCallback ? 'pending' : null,
    })
    .returning();

  if (!insertedLead) {
    throw new Error('ingestLead: insert returned no row');
  }

  // 4. Emit LEAD.NEW. Priority 4 sits one slot above the default (5) — leads
  //    are time-sensitive (first-touch SLA) but not as urgent as inbound
  //    customer messages (which run at default).
  //
  //    The `lead-scorer` consumes LEAD.NEW on the `lead` queue. HubSpot is NOT
  //    fanned out here anymore: it lives on its own `hubspot` queue (sole
  //    consumer) and is triggered by a separate LEAD.SYNC_HUBSPOT below — this
  //    avoids the wrong-role race where lead-scorer grabbed the hubspot job on
  //    the shared queue and the bounded-reroute dropped it.
  const fanoutRoles = ['lead-scorer'] as const;
  const intentPayload = {
    leadId: insertedLead.id,
    source: payload.source,
    ...(payload.sourceId ? { sourceId: payload.sourceId } : {}),
    productLine: payload.productLine,
    // Thread the stated channel preference so the Lead Scorer routes the
    // welcome to the right channel (call → voice, suppressing a competing
    // WhatsApp greeting on a lead who explicitly asked to be phoned).
    ...(payload.preferredChannel ? { preferredChannel: payload.preferredChannel } : {}),
    ...(payload.preferredTime ? { preferredTime: payload.preferredTime } : {}),
    // The intent schema accepts `raw` as the audit blob — merge form answers
    // + the source-payload there so consumers don't need a second DB hop.
    ...(mergedRaw ? { raw: mergedRaw } : {}),
  };
  const messageIds: string[] = [];
  for (const toRole of fanoutRoles) {
    const id = await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole,
        intent: 'LEAD.NEW',
        payload: intentPayload,
        correlationId: insertedLead.id,
        priority: 4,
      },
    );
    messageIds.push(id);
  }

  // 4b. Route the lead to HubSpot via its own queue + dedicated intent. Gated
  //     on HUBSPOT_API_KEY (no-op when the integration is off). Wrapped so a
  //     HubSpot routing hiccup never breaks lead intake — the lead is already
  //     persisted and LEAD.NEW dispatched.
  if (process.env.HUBSPOT_API_KEY) {
    try {
      const id = await sendMessage(
        { db },
        {
          fromRole: 'channel.intake',
          toRole: 'hubspot-sync',
          intent: 'LEAD.SYNC_HUBSPOT',
          payload: { leadId: insertedLead.id },
          correlationId: insertedLead.id,
          priority: 4,
        },
      );
      messageIds.push(id);
    } catch (err) {
      logger.warn(
        { leadId: insertedLead.id, err: err instanceof Error ? err.message : 'unknown' },
        'lead intake: failed to enqueue HubSpot sync (non-fatal)',
      );
    }
  }

  // Log without payload — `formAnswers` may contain plaintext PII the
  // upstream form happened to include (DOB, address, etc.).
  logger.info(
    {
      leadId: insertedLead.id,
      customerId: customer.id,
      source: payload.source,
      productLine: payload.productLine,
      dedup: customer.dedup,
      messageIds,
      fanout: fanoutRoles,
    },
    'lead ingested',
  );

  return {
    leadId: insertedLead.id,
    customerId: customer.id,
    dedup: customer.dedup,
    source: payload.source,
    productLine: payload.productLine,
  };
}
