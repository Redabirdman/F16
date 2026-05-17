/**
 * WAHA inbound webhook — zod schemas for the slice of the WAHA envelope we
 * actually need (M4.T3). WAHA emits a generic `{event, session, payload}`
 * shape; the `payload` shape varies per event. We validate the envelope
 * first, then re-parse `payload` against the per-event schema once we know
 * the event is interesting.
 *
 * We deliberately do NOT model the full WAHA `_data` blob — it is opaque,
 * shape-drifts between WAHA versions, and is not part of our contract.
 * The shapes here are the minimal set the webhook handler needs to:
 *   - identify the sender (chatId)
 *   - skip our own outbound echoes (fromMe)
 *   - skip group chats (chatId ending in @g.us)
 *   - emit a CUSTOMER.MESSAGE_RECEIVED intent (body + optional mediaUrl)
 */
import { z } from 'zod';

/**
 * Payload shape for the `message` event. Everything past `from` is optional —
 * media messages may have an empty `body`, text messages have no `mediaUrl`,
 * and `type`/`hasMedia` are useful hints but not required for correctness.
 */
export const WahaMessagePayloadSchema = z.object({
  id: z.string(),
  // WAHA emits seconds-since-epoch (not ms). We multiply by 1000 at use sites.
  timestamp: z.number(),
  // Either "<digits>@c.us" (personal) or "<group-id>@g.us" (group). We
  // accept the raw string here and filter on shape downstream.
  from: z.string(),
  fromMe: z.boolean(),
  body: z.string().optional().default(''),
  hasMedia: z.boolean().optional().default(false),
  mediaUrl: z.string().url().optional(),
  type: z.string().optional(),
});

/**
 * Outer envelope — every WAHA webhook delivery wraps the event-specific
 * payload in this shape. We keep `payload` typed as `unknown` here; the
 * handler re-parses against the per-event schema once it has decided to act.
 */
export const WahaWebhookEnvelopeSchema = z.object({
  event: z.string(),
  session: z.string().optional(),
  payload: z.unknown(),
});

export type WahaMessagePayload = z.infer<typeof WahaMessagePayloadSchema>;
export type WahaWebhookEnvelope = z.infer<typeof WahaWebhookEnvelopeSchema>;

/**
 * Extract an E.164 phone from a WAHA personal chatId.
 *
 * WAHA chatIds look like `33612345678@c.us` for individual chats and
 * `<group-id>@g.us` for groups. We only support personal-chat senders in V1
 * — group messages are ignored upstream — so this returns null for any
 * non-`@c.us` input.
 *
 * Returns null (not throw) on malformed input so the webhook can respond with
 * a structured ignore rather than a 5xx.
 */
export function chatIdToE164(chatId: string): string | null {
  const m = /^(\d+)@c\.us$/.exec(chatId);
  if (!m) return null; // group, missing suffix, or non-numeric prefix
  const phone = m[1];
  if (!phone) return null;
  return `+${phone}`;
}
