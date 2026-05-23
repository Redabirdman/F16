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
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { insertCustomer, getCustomerByPhone } from '../../db/repositories/customers.js';
import { insertTurn } from '../../db/repositories/conversation-turns.js';
import { leads } from '../../db/schema/leads.js';
import { listPending, resolveAction } from '../../db/repositories/human-actions.js';
import {
  WahaWebhookEnvelopeSchema,
  WahaMessagePayloadSchema,
  chatIdToE164,
} from './webhook-types.js';
import {
  parseHumanActionResolution,
  parseAuthorisedResolvers,
  isMatch,
} from './human-action-router.js';

export interface WhatsAppWebhookOptions {
  db: Database;
  /**
   * Shared HMAC secret used to verify the `X-Webhook-Hmac` (or legacy
   * `X-Waha-Signature`) header. When undefined, signature verification is
   * skipped — this is intended for local dev / legacy WAHA installs that
   * don't forward the header. Production deployments MUST set this.
   */
  hmacSecret?: string;
  /**
   * Optional — WAHA chat id of the human-action group (e.g.
   * "120363012345@g.us"). When set, inbound messages from this chat are
   * routed to the human-action resolution parser instead of the customer-
   * message path. When unset, the webhook ignores all group messages
   * (legacy behaviour). Default is to read HUMAN_ACTION_GROUP_CHAT_ID from
   * env in start().
   */
  humanActionGroupChatId?: string;
  /**
   * Allowlist of authorised resolver phones in E.164 ("+33612345678"). Only
   * messages from these senders count as authoritative human_action
   * resolutions, per project_human_action_channel.md. Default is to read
   * HUMAN_ACTION_AUTHORISED_RESOLVERS from env in start() (comma-separated).
   */
  humanActionAuthorisedResolvers?: Set<string>;
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

    // 5. Filter self-echoes (we sent it). WAHA emits a `message` event for
    //    our own outbound messages too — we must not loop back.
    if (msg.fromMe) {
      return c.json({ accepted: true, ignored: 'fromMe' }, 200);
    }

    // 5b. HUMAN_ACTION group intercept (option G follow-up). When the
    //     configured group chat sends a message, treat it as a possible
    //     resolution of an open human_action rather than a customer message.
    //     `from` for group messages is the group chat id; `author` is the
    //     individual sender (we authorise on the latter).
    const groupChatId = opts.humanActionGroupChatId;
    if (groupChatId && msg.from === groupChatId) {
      const outcome = await tryResolveHumanActionFromGroup(opts, msg);
      // Always 200 — we don't want WAHA to retry an operator reply.
      return c.json({ accepted: true, humanAction: outcome }, 200);
    }

    // 5c. Other group chats (not the human-action group) are ignored —
    //     V1 customer messaging is personal-chat only. chatIdToE164 returns
    //     null for any `@g.us` chat id.
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

    // 8. Resolve the live conversation instance. The Sales Agent is spawned
    // per-lead (`lead-<leadId>`) by the M5.T4 orchestrator, so we look up the
    // customer's most-recent lead to find the running instance. Falls back
    // to `customer-<id>` (the legacy addressing) when no lead exists yet —
    // WhatsApp-first strangers who haven't gone through the website intake
    // still need a deliverable target.
    //
    // `correlationId` carries the leadId when known so the SalesAgent's
    // `handleCustomerMessage` can resolve the conversation context even
    // when the agent's `meta.leadId` isn't set (e.g. cross-process replay).
    const activeLead = await findActiveLeadForCustomer(opts.db, customer.id);
    const toInstance = activeLead ? `lead-${activeLead.id}` : `customer-${customer.id}`;
    const correlationId = activeLead?.id ?? customer.id;

    await sendMessage(
      { db: opts.db },
      {
        fromRole: 'channel.whatsapp',
        toRole: 'sales-agent',
        toInstance,
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
        correlationId,
      },
    );

    return c.json({ accepted: true, customerId: customer.id }, 200);
  });

  return app;
}

/**
 * Find the most-recent lead for a customer that we'd still consider
 * "active" — i.e. NOT closed/won/lost. The Sales Agent for that lead is
 * the natural recipient of the inbound customer message. Returns null
 * when no lead exists yet (WhatsApp-first stranger who hasn't been
 * through the website intake).
 *
 * Ordering by `created_at DESC` is good enough for V1 — multi-lead
 * customers are rare and the freshest lead is the conversation we want
 * to continue. M11's Customer Engagement Agent will revisit this.
 */
async function findActiveLeadForCustomer(
  db: Database,
  customerId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: leads.id, status: leads.status })
    .from(leads)
    .where(eq(leads.customerId, customerId))
    .orderBy(desc(leads.createdAt))
    .limit(5);
  // Prefer leads that are mid-conversation. Terminal states route through
  // `customer-<id>` legacy addressing so a new conversation doesn't keep
  // poking a dead lead's agent. `dormant` is included — a customer who
  // pings after a long silence deserves a fresh lead, not a stale agent.
  const TERMINAL: ReadonlySet<string> = new Set(['closed_won', 'closed_lost', 'dormant']);
  const active = rows.find((r) => !TERMINAL.has(r.status));
  return active ? { id: active.id } : null;
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
 * Try to resolve an open human_action from a message posted in the
 * configured WA group (option G follow-up).
 *
 * Flow:
 *   1. Load currently-pending human_actions (most-recent first).
 *   2. Hand the message + pending list to the pure parser. It decides
 *      whether the message is a valid resolution and which option was
 *      picked, applying the auth allowlist.
 *   3. On match: call resolveAction (idempotent), emit
 *      HUMAN_ACTION.RESOLVED — the Reporter Agent picks that up and posts
 *      the closure message in the same group.
 *   4. On failure: log a structured warn with the reason. The webhook
 *      always returns 200 either way.
 *
 * Returns a small object describing the outcome — surfaced in the HTTP
 * response body so the WAHA admin can see why a reply didn't take.
 */
async function tryResolveHumanActionFromGroup(
  opts: WhatsAppWebhookOptions,
  msg: { body: string; from: string; author?: string | undefined },
): Promise<
  { resolved: false; reason: string } | { resolved: true; actionId: string; choice: string }
> {
  const groupChatId = opts.humanActionGroupChatId;
  if (!groupChatId) {
    return { resolved: false, reason: 'not_human_action_group' };
  }
  const authorised = opts.humanActionAuthorisedResolvers ?? new Set<string>();
  const pending = await listPending(opts.db, { limit: 20 });
  const outcome = parseHumanActionResolution({
    body: msg.body,
    from: msg.from,
    author: msg.author,
    groupChatId,
    authorisedResolvers: authorised,
    pendingActions: pending,
  });

  if (!isMatch(outcome)) {
    logger.warn(
      { reason: outcome.reason, detail: outcome.detail },
      'waha webhook: human-action message did not resolve',
    );
    return { resolved: false, reason: outcome.reason };
  }

  await resolveAction(opts.db, outcome.actionId, {
    chosenOption: outcome.option,
    by: outcome.resolverPhone,
    source: 'whatsapp',
  });

  await sendMessage(
    { db: opts.db },
    {
      fromRole: 'channel.whatsapp',
      toRole: 'human-router',
      toInstance: 'singleton',
      intent: 'HUMAN_ACTION.RESOLVED',
      payload: {
        humanActionId: outcome.actionId,
        choice: outcome.option.id,
        source: 'whatsapp',
      },
      correlationId: outcome.actionId,
    },
  );

  logger.info(
    {
      humanActionId: outcome.actionId,
      choice: outcome.option.id,
      resolverPhone: outcome.resolverPhone,
      matchedActionVia: outcome.matchedActionVia,
      matchedOptionVia: outcome.matchedOptionVia,
    },
    'waha webhook: human-action resolved via WhatsApp',
  );

  return { resolved: true, actionId: outcome.actionId, choice: outcome.option.id };
}

/** Re-export so start() and tests can build a Set from the env value. */
export { parseAuthorisedResolvers };

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
