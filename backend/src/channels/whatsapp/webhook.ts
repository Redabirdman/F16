/**
 * WAHA inbound webhook (M4.T3).
 *
 * Translates a WAHA `message` event into the F16 internal world by:
 *   1. verifying the HMAC signature (when a shared secret is configured),
 *   2. parsing the envelope + message payload via zod,
 *   3. filtering out group chats and our own outbound echoes,
 *   4. matching the sender to an existing customer by phone-hash (M4.T3a) or
 *      creating a stub when no match exists,
 *   5. emitting a `CUSTOMER.MESSAGE_RECEIVED` agent message via the
 *      dispatcher so the Sales Agent (M6) picks it up.
 *
 * Out of scope (intentionally deferred):
 *   - Triggering OCR for media attachments (M11).
 *   - Lead creation flow (M5); for now an inbound stranger gets a customer
 *     stub with `fullName = "WhatsApp <phone>"`.
 *
 * HMAC verification is wrapped in `crypto.timingSafeEqual` so request timing
 * doesn't leak how much of the signature was correct. The check is constant-
 * time on the byte length and uses our shared `PII_ENCRYPTION_KEY` policy
 * for env-driven secrets (the WAHA HMAC secret is independent).
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { insertCustomer, getCustomerByPhone } from '../../db/repositories/customers.js';
import { insertTurn } from '../../db/repositories/conversation-turns.js';
import {
  WahaWebhookEnvelopeSchema,
  WahaMessagePayloadSchema,
  chatIdToE164,
} from './webhook-types.js';

export interface WhatsAppWebhookOptions {
  db: Database;
  /**
   * Shared HMAC secret used to verify the `X-Webhook-Hmac` (or legacy
   * `X-Waha-Signature`) header. When undefined, signature verification is
   * skipped — this is intended for local dev / legacy WAHA installs that
   * don't forward the header. Production deployments MUST set this.
   */
  hmacSecret?: string;
}

/**
 * Mount the WAHA webhook on a fresh Hono router. Returns the router so it
 * can be composed into the main server (or used directly in tests via
 * `app.request(...)`).
 */
export function buildWhatsAppWebhook(opts: WhatsAppWebhookOptions): Hono {
  const app = new Hono();

  app.post('/webhooks/waha', async (c) => {
    // Read the raw body ONCE — we need the exact bytes WAHA signed for HMAC,
    // and JSON.parse can't reconstruct that byte-for-byte after the fact
    // (whitespace, key ordering). Subsequent JSON.parse is on the same string.
    const rawBody = await c.req.text();

    // 1. HMAC verification (skipped when no secret is configured).
    if (opts.hmacSecret) {
      const sig = c.req.header('x-webhook-hmac') ?? c.req.header('x-waha-signature') ?? '';
      if (!verifyHmac(rawBody, sig, opts.hmacSecret)) {
        logger.warn('waha webhook: HMAC verification failed');
        return c.json({ error: 'invalid signature' }, 401);
      }
    }

    // 2. Parse the envelope. A bad JSON body or shape mismatch is a hard
    // 400 — WAHA should never emit either of those.
    let envelope;
    try {
      envelope = WahaWebhookEnvelopeSchema.parse(JSON.parse(rawBody));
    } catch (err) {
      logger.warn({ err }, 'waha webhook: invalid envelope');
      return c.json({ error: 'invalid payload' }, 400);
    }

    // 3. Only the `message` event triggers downstream work. Acks, session
    // status, presence updates etc. are acknowledged with a 200 + ignored
    // marker so WAHA doesn't retry them.
    if (envelope.event !== 'message') {
      return c.json({ accepted: true, ignored: envelope.event }, 200);
    }

    // 4. Re-validate the payload now that we know the event shape we expect.
    let msg;
    try {
      msg = WahaMessagePayloadSchema.parse(envelope.payload);
    } catch (err) {
      logger.warn({ err }, 'waha webhook: invalid message payload');
      return c.json({ error: 'invalid message payload' }, 400);
    }

    // 5. Filter self-echoes (we sent it) and group chats (V1 scope).
    //   - fromMe: WAHA emits a `message` event for our own outbound messages
    //     too. We must not loop back into the dispatcher with our own copy.
    //   - chatIdToE164 returns null for `@g.us` group ids — group support is
    //     deliberately out of scope (M11+ would add it).
    if (msg.fromMe) {
      return c.json({ accepted: true, ignored: 'fromMe' }, 200);
    }
    const e164 = chatIdToE164(msg.from);
    if (!e164) {
      return c.json({ accepted: true, ignored: 'non-personal-chat' }, 200);
    }

    // 6. Match-or-create the customer. The phone-hash unique index (M4.T3a
    // migration) is the dedup key — we never decrypt other customers to do
    // this lookup.
    const customer = await findOrCreateCustomerByPhone(opts.db, e164);

    // 7. Audit the inbound message in `conversation_turns` BEFORE emitting
    // the intent. The admin timeline must include every inbound message,
    // regardless of whether downstream agent dispatch later fails. agentRole
    // is null — inbound messages have no agent attribution.
    const occurredAt = new Date(msg.timestamp * 1000);
    const attachments =
      msg.hasMedia && msg.mediaUrl ? [{ url: msg.mediaUrl, type: 'media' }] : undefined;
    await insertTurn(opts.db, {
      customerId: customer.id,
      channel: 'whatsapp',
      direction: 'inbound',
      content: msg.body,
      ...(attachments ? { attachments } : {}),
      occurredAt,
    });

    // 8. Emit the agent-bus intent. The Sales Agent (M6) is the eventual
    // consumer; it routes via `toInstance = customer-<id>` so a singleton
    // worker per customer can keep conversation state warm.
    await sendMessage(
      { db: opts.db },
      {
        fromRole: 'channel.whatsapp',
        toRole: 'sales-agent',
        toInstance: `customer-${customer.id}`,
        intent: 'CUSTOMER.MESSAGE_RECEIVED',
        payload: {
          customerId: customer.id,
          channel: 'whatsapp',
          content: msg.body,
          // Single-attachment model for V1 — WAHA emits one mediaUrl per
          // message. The intent schema accepts an array so future channels
          // (email with N attachments) reuse the same shape.
          attachments: msg.hasMedia && msg.mediaUrl ? [{ url: msg.mediaUrl }] : [],
          // WAHA emits seconds since epoch; the intent schema requires an
          // ISO datetime. Reuse the same instant as the conversation_turns row.
          occurredAt: occurredAt.toISOString(),
        },
        correlationId: customer.id,
      },
    );

    return c.json({ accepted: true, customerId: customer.id }, 200);
  });

  return app;
}

/**
 * Find an existing customer by phone hash, or create a minimal stub if none
 * exists. The stub has just enough identity (full_name + phone) for the
 * Sales Agent to start a conversation; M5's lead-creation flow will fill
 * the rest later.
 */
async function findOrCreateCustomerByPhone(db: Database, e164: string): Promise<{ id: string }> {
  const existing = await getCustomerByPhone(db, e164);
  if (existing) return { id: existing.id };

  // No match — create a stub. We use a placeholder `fullName` so the
  // NOT-NULL constraint is satisfied; admins can rename it once they have a
  // real identity. Sending the plaintext phone through insertCustomer also
  // populates `phone_hash` so subsequent inbound messages dedup correctly.
  const created = await insertCustomer(db, {
    fullName: `WhatsApp ${e164}`,
    phone: e164,
  });
  logger.info(
    { customerId: created.id, source: 'whatsapp-webhook' },
    'created customer stub from inbound WhatsApp message',
  );
  return { id: created.id };
}

/**
 * Constant-time HMAC-SHA256 verification.
 *
 * Tolerates the `sha256=` prefix some webhook senders emit (GitHub-style),
 * and short-circuits when the byte lengths differ — `timingSafeEqual` throws
 * on mismatched-length buffers, so we filter that here for a clean 401.
 */
function verifyHmac(rawBody: string, providedSig: string, secret: string): boolean {
  if (!providedSig) return false;
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = providedSig.startsWith('sha256=') ? providedSig.slice(7) : providedSig;
  if (provided.length !== computed.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    // Non-hex input (`provided` had non-hex chars after the prefix strip)
    // — treat as an invalid signature rather than 5xx.
    return false;
  }
}
