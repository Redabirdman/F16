/**
 * Sales Agent — conversation loop (M6.T3).
 *
 * Per-lead WhatsApp/email/SMS conversation handler. Replaces the M5.T4
 * placeholder. Branches by intent:
 *
 *   - LEAD.SCORED              → first-turn welcome. Uses the Lead Scorer's
 *                                pre-crafted `opening` + `channel` verbatim —
 *                                no LLM call (the scorer already framed it).
 *                                Idempotent: skips when an outbound turn
 *                                already exists for the lead.
 *   - CUSTOMER.MESSAGE_RECEIVED → fetch context (customer + lead + last 10
 *                                turns) → build the system prompt (M6.T2) →
 *                                call Claude Sonnet (raw SDK, M6.T1) → clean
 *                                wrapping artifacts → send via the channel
 *                                layer (M4.T7). The user-message side carries
 *                                only the customer's CURRENT message; recent
 *                                turns live in the cached system fragment so
 *                                prompt caching stays hot.
 *   - any other intent         → returns `{skipped:'unhandled-intent'}`.
 *
 * PII boundary: phone/email/full_name decrypt happens here (the agent
 * process is the encryption boundary); decrypted values are NEVER logged.
 *
 * Future M6 plug-in points:
 *   - M6.T4 — Compliance Sentry on the draft before send (TODO marker below).
 *   - M6.T5 — tool-use invocation (so Claude can call OCR/quote tools mid-turn).
 *   - M6.T6 — Mem0 recall fed into `recalledFacts`.
 *   - M6.T7 — welcome flow polish (multi-step opener, A/B variants).
 *   - M10   — voice channel (Pipecat); for now we skip when `channel='voice'`
 *             cannot send (no phone hashed).
 */
import { eq } from 'drizzle-orm';
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { listTurns } from '../../db/repositories/conversation-turns.js';
import { callClaude } from '../../llm/claude.js';
import { buildSalesAgentSystemPrompt, type SalesAgentTurnContext } from './prompts/index.js';
import { sendViaChannel } from '../../channels/send.js';
import type { ChannelId, ContactRef } from '../../channels/types.js';

const MAX_HISTORY_TURNS = 10;
const MAX_REPLY_CHARS = 1500;
const REPLY_TOKEN_BUDGET = 400;

export class SalesAgent extends BaseAgent {
  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    try {
      switch (envelope.intent) {
        case 'LEAD.SCORED':
          return await this.handleLeadScored(envelope);
        case 'CUSTOMER.MESSAGE_RECEIVED':
          return await this.handleCustomerMessage(envelope);
        default:
          logger.debug(
            { intent: envelope.intent, instanceId: this.instanceId },
            'sales-agent: ignoring unhandled intent',
          );
          return { ok: true, result: { skipped: 'unhandled-intent', intent: envelope.intent } };
      }
    } catch (err) {
      logger.error(
        { err, intent: envelope.intent, instanceId: this.instanceId },
        'sales-agent: onMessage threw',
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * First-turn welcome: uses the Lead Scorer's opener verbatim — no LLM call.
   * Idempotent on `(customerId, leadId)`: skips if an outbound turn already exists.
   */
  private async handleLeadScored(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    const payload = envelope.payload as { leadId: string; opening: string; channel: ChannelId };
    const { customer, lead, contactRef } = await this.resolveCustomerAndContact(
      payload.leadId,
      payload.channel,
    );
    if (!contactRef) {
      logger.warn(
        { leadId: lead.id, channel: payload.channel, instanceId: this.instanceId },
        'sales-agent: no contact address for channel',
      );
      return { ok: true, result: { skipped: 'no-contact-address', channel: payload.channel } };
    }
    // Idempotency — don't double-welcome a lead that already has an outbound turn.
    const priorTurns = await listTurns(this.db, {
      customerId: customer.id,
      leadId: lead.id,
      limit: MAX_HISTORY_TURNS,
    });
    if (priorTurns.some((t) => t.direction === 'outbound')) {
      logger.debug(
        { leadId: lead.id, instanceId: this.instanceId },
        'sales-agent: lead already welcomed; skipping',
      );
      return { ok: true, result: { skipped: 'already-welcomed' } };
    }
    const send = await sendViaChannel({
      db: this.db,
      customerId: customer.id,
      leadId: lead.id,
      to: contactRef,
      body: [{ type: 'text', text: payload.opening }],
      agentRole: this.role,
      agentInstance: this.instanceId,
      correlationId: lead.id,
    });
    return {
      ok: true,
      result: {
        intent: envelope.intent,
        sent: true,
        channel: payload.channel,
        externalId: send.receipt.externalId,
      },
    };
  }

  /**
   * Customer reply: full LLM loop. Builds the system prompt with the most
   * recent 10 turns; the user-message side carries only the customer's
   * current content so prompt caching keeps hitting.
   */
  private async handleCustomerMessage(
    envelope: AgentMessageEnvelope,
  ): Promise<MessageHandlerResult> {
    const payload = envelope.payload as {
      customerId: string;
      channel: ChannelId;
      content: string;
    };
    if (!payload.content || payload.content.trim().length === 0) {
      return { ok: true, result: { skipped: 'empty-inbound' } };
    }
    // The Sales Agent instance was spawned with `meta.leadId` set by M5.T4's
    // orchestrator. Fall back to the envelope's correlationId for callers
    // (M6.T7 + manual replay) that hand the leadId there instead.
    const metaLeadId = this.meta['leadId'];
    const leadId =
      (typeof metaLeadId === 'string' && metaLeadId.length > 0 ? metaLeadId : undefined) ??
      envelope.correlationId ??
      null;
    if (!leadId) {
      logger.warn(
        { instanceId: this.instanceId },
        'sales-agent: no leadId in meta or correlationId — cannot resolve lead',
      );
      return { ok: false, error: 'no leadId available' };
    }
    const { customer, lead, contactRef } = await this.resolveCustomerAndContact(
      leadId,
      payload.channel,
    );
    if (!contactRef) {
      logger.warn(
        { leadId, channel: payload.channel, instanceId: this.instanceId },
        'sales-agent: no contact address for channel',
      );
      return { ok: true, result: { skipped: 'no-contact-address' } };
    }

    // Build context — pull last N turns across any channel, oldest first.
    const recentTurnsDesc = await listTurns(this.db, {
      customerId: customer.id,
      limit: MAX_HISTORY_TURNS,
    });
    const recentTurns = [...recentTurnsDesc].reverse();
    const fullName = decryptPII(customer.fullName);

    const ctx: SalesAgentTurnContext = {
      customer: {
        id: customer.id,
        fullName,
        civility: customer.civility ?? null,
        productLine: (lead.productLine ?? 'car') as 'scooter' | 'car',
        vehicleSummary: summarizeJson(customer.vehicle),
        driverSummary: summarizeJson(customer.driver),
      },
      lead: {
        id: lead.id,
        source: lead.source as SalesAgentTurnContext['lead']['source'],
        status: lead.status,
        score: lead.score,
        // M9 will plumb actual quote state from the quotes repo; for now
        // every Sales Agent turn assumes no live quote.
        quoteState: 'none',
      },
      recentTurns: recentTurns.map((t) => ({
        direction: t.direction,
        channel: t.channel,
        content: t.content,
        at: t.occurredAt,
      })),
      channel: payload.channel,
    };

    // Call Claude — Sonnet for sales conversation. The system fragments
    // (M6.T2) include the cached prefix + per-turn context; userPrompt is
    // ONLY the customer's current message.
    const result = await callClaude({
      tier: 'sonnet',
      systemFragments: buildSalesAgentSystemPrompt(ctx),
      userPrompt: payload.content,
      maxTokens: REPLY_TOKEN_BUDGET,
      structured: false,
      logContext: { agent: 'sales-agent', instanceId: this.instanceId, leadId },
    });
    const draftRaw = typeof result === 'string' ? result : result.text;
    const draft = cleanLLMReply(draftRaw);

    if (!draft || draft.length === 0) {
      logger.warn(
        { leadId, instanceId: this.instanceId },
        'sales-agent: LLM returned empty after cleaning',
      );
      return { ok: false, error: 'empty-llm-reply' };
    }
    if (draft.length > MAX_REPLY_CHARS) {
      logger.warn(
        { leadId, instanceId: this.instanceId, length: draft.length },
        'sales-agent: LLM reply exceeds max chars',
      );
      return { ok: false, error: `reply-too-long (${draft.length} chars)` };
    }

    // TODO M6.T4 — pass `draft` through compliance.sentry before sending.
    // The sentry will return either {ok:true, draft} (possibly rewritten) or
    // {ok:false, reason} which should trigger a HUMAN_ACTION.REQUESTED here.
    const send = await sendViaChannel({
      db: this.db,
      customerId: customer.id,
      leadId: lead.id,
      to: contactRef,
      body: [{ type: 'text', text: draft }],
      agentRole: this.role,
      agentInstance: this.instanceId,
      correlationId: lead.id,
    });
    return {
      ok: true,
      result: {
        intent: envelope.intent,
        sent: true,
        channel: payload.channel,
        externalId: send.receipt.externalId,
        length: draft.length,
      },
    };
  }

  /**
   * Resolve `(lead, customer, ContactRef)` for the given lead+channel.
   * - Throws on missing lead / missing customer-id-on-lead / missing customer.
   * - Returns `contactRef: null` when the customer has no address for the
   *   requested channel (phone for whatsapp/sms/voice, email for email) —
   *   callers handle this as a soft skip rather than an error.
   */
  private async resolveCustomerAndContact(
    leadId: string,
    channel: ChannelId,
  ): Promise<{
    customer: typeof customers.$inferSelect;
    lead: typeof leads.$inferSelect;
    contactRef: ContactRef | null;
  }> {
    const [lead] = await this.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) throw new Error(`Lead ${leadId} not found`);
    if (!lead.customerId) throw new Error(`Lead ${leadId} has no customer_id`);
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, lead.customerId))
      .limit(1);
    if (!customer) throw new Error(`Customer ${lead.customerId} not found`);

    let address: string | null = null;
    switch (channel) {
      case 'whatsapp':
      case 'sms':
      case 'voice':
        address = decryptPII(customer.phone);
        break;
      case 'email':
        address = decryptPII(customer.email);
        break;
    }
    if (!address) return { customer, lead, contactRef: null };
    const fullName = decryptPII(customer.fullName);
    const contactRef: ContactRef = {
      channel,
      address,
      ...(fullName ? { displayName: fullName } : {}),
    };
    return { customer, lead, contactRef };
  }
}

/**
 * Format a plaintext JSONB column (vehicle / driver) into a single-line
 * summary string for the prompt context. Skips null/empty values so the
 * prompt stays terse.
 */
export function summarizeJson(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return null;
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

/**
 * Strip common LLM wrapping artifacts from a draft reply so the customer
 * doesn't see them. Handles: fenced code blocks, leading "Réponse :" /
 * "Voici :" labels (French + English), wrapping straight or French guillemet
 * quotes. Pure / deterministic — covered by unit tests.
 */
export function cleanLLMReply(raw: string): string {
  let s = raw.trim();
  // Strip ```...``` fences (with optional language tag) wrapping the message.
  s = s
    .replace(/^```(?:\w+)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  // Strip a leading "Réponse :" / "Voici :" / "Message :" label (FR + EN).
  s = s.replace(/^(R[ée]ponse|Voici|Message|Reply|Response)\s*[:.]\s*/i, '').trim();
  // Strip wrapping straight quotes or French guillemets when both ends match.
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('«') && s.endsWith('»')) ||
    (s.startsWith('“') && s.endsWith('”'))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}
