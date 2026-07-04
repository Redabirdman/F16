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
 *   - QUOTE.* / SUBSCRIPTION.* → deterministic, templated French messages.
 *                                The handlers + their formatters live in the
 *                                sibling `handlers/` + `formatters.ts` modules;
 *                                this class is just the dispatcher.
 *   - any other intent         → returns `{skipped:'unhandled-intent'}`.
 *
 * PII boundary: phone/email/full_name decrypt happens here (the agent
 * process is the encryption boundary); decrypted values are NEVER logged.
 *
 * Future plug-in points:
 *   - M10   — voice channel (Pipecat); for now we skip when `channel='voice'`
 *             cannot send (no phone hashed).
 *   - M11   — Customer Engagement Agent schedules a 24h-no-reply follow-up
 *             from the welcome event-fact recorded by `handleLeadScored`.
 */
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { customers, leads } from '../../db/schema/index.js';
import { listTurns } from '../../db/repositories/conversation-turns.js';
import { sendViaChannel } from '../../channels/send.js';
import type { ChannelId, ContactRef } from '../../channels/types.js';
import { checkComplianceFor } from '../../compliance/index.js';
import * as humanActions from '../../db/repositories/human-actions.js';
import { notifyHumanAction } from '../human-notify.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import { recordCustomerFact } from '../../memory/index.js';
// M10 — the customer-message reply pipeline (resolution → LLM → compliance)
// lives in `reply-core.ts` so the voice route and this agent share one brain.
import { generateSalesReply, resolveSalesContext } from './reply-core.js';
import { setLeadStatus } from '../../db/repositories/leads.js';
// QUOTE.* / SUBSCRIPTION.* intent handlers (extracted to keep this class thin).
import type { SalesHandlerCtx } from './handlers/context.js';
import {
  handleQuotePreviewReady,
  handleQuoteReady,
  handleQuoteFailed,
  handleDevisPdfReceived,
} from './handlers/quote.js';
import { handleSubscriptionReady, handleSubscriptionFailed } from './handlers/subscription.js';

const MAX_HISTORY_TURNS = 10;

export class SalesAgent extends BaseAgent {
  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    try {
      switch (envelope.intent) {
        case 'LEAD.SCORED':
          return await this.handleLeadScored(envelope);
        case 'CUSTOMER.MESSAGE_RECEIVED':
          return await this.handleCustomerMessage(envelope);
        case 'QUOTE.PREVIEW_READY':
          return await handleQuotePreviewReady(this.handlerCtx(), envelope);
        case 'QUOTE.READY':
          return await handleQuoteReady(this.handlerCtx(), envelope);
        case 'QUOTE.FAILED':
          return await handleQuoteFailed(this.handlerCtx(), envelope);
        case 'DEVIS.PDF_RECEIVED':
          return await handleDevisPdfReceived(this.handlerCtx(), envelope);
        case 'SUBSCRIPTION.READY':
          return await handleSubscriptionReady(this.handlerCtx(), envelope);
        case 'SUBSCRIPTION.FAILED':
          return await handleSubscriptionFailed(this.handlerCtx(), envelope);
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
   * Build the dependency surface the extracted QUOTE.* / SUBSCRIPTION.*
   * handlers need. The class's `db` is protected and the helpers private, so
   * we hand the handlers an explicit, structurally-typed slice rather than
   * `this`.
   */
  private handlerCtx(): SalesHandlerCtx {
    return {
      db: this.db,
      role: this.role,
      instanceId: this.instanceId,
      resolveCustomerAndContact: (leadId, channel) =>
        this.resolveCustomerAndContact(leadId, channel),
      leadIdFromEnvelope: (envelope) => this.leadIdFromEnvelope(envelope),
    };
  }

  /**
   * First-turn welcome: uses the Lead Scorer's opener verbatim — no LLM call
   * to GENERATE (the scorer already framed it), but we DO run the Compliance
   * Sentry on the opener defensively in case the LLM-authored draft slipped a
   * guardrail violation through. Then on a successful send we transition the
   * lead `'scored' → 'qualifying'` and record an `event`-type fact in memory
   * so downstream turns know "we welcomed via X at T".
   *
   * Idempotent on `(customerId, leadId)`: skips if an outbound turn already
   * exists. Compliance-blocked sends do NOT transition the status — the lead
   * stays in `'scored'` so a human can pick up cleanly.
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

    // M6.T7 — Compliance Sentry on the Lead-Scorer-authored opener. Lead status
    // here is `'scored'` (the scorer's terminal state) because the welcome
    // hasn't been sent yet. No `lastInboundContent` — this is first contact.
    const compliance = await checkComplianceFor(this.db, {
      draft: payload.opening,
      ctx: {
        customerId: customer.id,
        channel: payload.channel,
        productLine: (lead.productLine ?? 'car') as 'scooter' | 'car',
        leadStatus: 'scored',
      },
    });

    if (compliance.verdict === 'block') {
      logger.warn(
        {
          leadId: lead.id,
          instanceId: this.instanceId,
          reasons: compliance.reasons,
          ruleHits: compliance.ruleHits,
          durationMs: compliance.durationMs,
        },
        'sales-agent: compliance blocked welcome opener, escalating to human',
      );

      const action = await humanActions.createAction(this.db, {
        createdByAgent: `${this.role}#${this.instanceId}`,
        correlationId: lead.id,
        intent: 'COMPLIANCE_BLOCKED',
        severity: 2,
        summary: `Sales Agent welcome opener bloqué (${compliance.ruleHits.join(', ') || 'LLM'}). Raisons : ${compliance.reasons.join(' ; ')}`,
        options: [
          { id: 'send_as_is', label: 'Envoyer quand même', kind: 'approve' },
          { id: 'reject_send', label: "Refuser l'envoi", kind: 'reject' },
          { id: 'revise', label: 'Demander une révision', kind: 'revise' },
        ],
      });

      await sendMessage(
        { db: this.db },
        {
          fromRole: this.role,
          fromInstance: this.instanceId,
          toRole: 'supervisor',
          intent: 'COMPLIANCE.BLOCKED',
          payload: { messageId: action.id, reasons: compliance.reasons },
          correlationId: lead.id,
          requiresHuman: true,
          priority: 2,
        },
      );
      // COMPLIANCE.BLOCKED only reaches the supervisor's audit trail; the WA
      // group needs the HUMAN_ACTION emit (2026-07-04 audit, H1). Without it
      // a blocked welcome sits in the admin while the lead goes cold.
      await notifyHumanAction(
        this.db,
        { id: action.id, severity: 2, summary: action.summary },
        { role: this.role, instanceId: this.instanceId, correlationId: lead.id },
      );

      // Lead status stays 'scored' — human resolves before we re-attempt.
      return {
        ok: true,
        result: {
          intent: envelope.intent,
          sent: false,
          blocked: true,
          reasons: compliance.reasons,
          humanActionId: action.id,
        },
      };
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

    // Status transition: scored → qualifying. Routes through setLeadStatus so
    // the CRM mirror fires on every transition (HubSpot Phase 2).
    await setLeadStatus(this.db, lead.id, 'qualifying');

    // M13 — audit the welcome transition. Best-effort: a failed audit
    // shouldn't undo the welcome (already sent + status flipped).
    try {
      await appendAudit(this.db, {
        actorType: 'agent',
        actorId: `${this.role}#${this.instanceId}`,
        action: 'lead.status.change',
        targetType: 'lead',
        targetId: lead.id,
        before: { status: 'scored' },
        after: { status: 'qualifying', reason: 'sales-agent-welcomed' },
        meta: { channel: payload.channel },
      });
    } catch {
      // non-blocking
    }

    // Memory event-fact. Best-effort — if embeddings are down we still want
    // the welcome (already sent above) to register as a success. Same fallback
    // policy as M6.T6's recall path: log a warning, swallow.
    try {
      await recordCustomerFact(this.db, {
        customerId: customer.id,
        factType: 'event',
        content: `Welcomed via ${payload.channel} at ${new Date().toISOString()}`,
        confidence: 1.0,
        recordedBy: `${this.role}#${this.instanceId}`,
      });
    } catch (err) {
      logger.warn(
        { err, leadId: lead.id, customerId: customer.id, instanceId: this.instanceId },
        'sales-agent: failed to record welcome event-fact; continuing',
      );
    }

    logger.info(
      {
        leadId: lead.id,
        customerId: customer.id,
        instanceId: this.instanceId,
        channel: payload.channel,
        externalId: send.receipt.externalId,
      },
      'sales-agent: welcome sent + lead transitioned to qualifying',
    );

    return {
      ok: true,
      result: {
        intent: envelope.intent,
        sent: true,
        blocked: false,
        channel: payload.channel,
        externalId: send.receipt.externalId,
        leadStatus: 'qualifying',
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

    // M10 — shared reply core. `generateSalesReply` reproduces the resolution
    // → LLM → clean → guard → compliance pipeline and RETURNS a result; the
    // voice route (`POST /v1/voice/turn`) calls the same function. Here we map
    // its outcome back to the historical MessageHandlerResult shapes, and on a
    // clean reply we send via the channel exactly as before.
    const reply = await generateSalesReply({
      db: this.db,
      leadId,
      channel: payload.channel,
      content: payload.content,
      agentRole: this.role,
      agentInstance: this.instanceId,
    });

    switch (reply.outcome) {
      case 'skip':
        // 'empty-inbound' is handled above (returns before this call), so the
        // only soft-skip reaching here is 'no-contact-address'.
        return { ok: true, result: { skipped: reply.reason } };
      case 'error':
        return { ok: false, error: reply.error };
      case 'blocked':
        return {
          ok: true,
          result: {
            intent: envelope.intent,
            sent: false,
            blocked: true,
            reasons: reply.reasons,
            humanActionId: reply.humanActionId,
          },
        };
      case 'reply': {
        // Re-resolve the ContactRef for the send. `generateSalesReply` already
        // proved a contact address exists (else it would have returned a
        // 'skip'); guard the null anyway in case it vanished between calls.
        const { contactRef } = await this.resolveCustomerAndContact(leadId, payload.channel);
        if (!contactRef) {
          logger.warn(
            { leadId, instanceId: this.instanceId },
            'sales-agent: contact address disappeared before send',
          );
          return { ok: true, result: { skipped: 'no-contact-address' } };
        }
        const send = await sendViaChannel({
          db: this.db,
          customerId: reply.customerId,
          leadId: reply.leadId,
          to: contactRef,
          body: [{ type: 'text', text: reply.replyText }],
          agentRole: this.role,
          agentInstance: this.instanceId,
          correlationId: reply.leadId,
        });
        return {
          ok: true,
          result: {
            intent: envelope.intent,
            sent: true,
            channel: payload.channel,
            externalId: send.receipt.externalId,
            length: reply.replyText.length,
          },
        };
      }
    }
  }

  /**
   * Resolve the leadId for the current envelope.
   *
   * Two sources, in priority order:
   *   1. The Sales Agent instance's `meta.leadId` (set by the spawn
   *      orchestrator when this instance was created for a specific lead).
   *   2. The envelope's `correlationId` — for the QUOTE.PREVIEW_READY path
   *      the Maxance Operator sets correlationId = quoteId, NOT leadId,
   *      so this fallback only matters for old / replay envelopes.
   *
   * Returns null when neither is available — callers fail fast with
   * `no leadId available`.
   */
  private leadIdFromEnvelope(envelope: AgentMessageEnvelope): string | null {
    const fromMeta = this.meta['leadId'];
    if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
    if (envelope.correlationId && envelope.correlationId.length > 0) {
      return envelope.correlationId;
    }
    return null;
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
    // M10 — delegates to the shared free helper so the voice route and the
    // agent resolve customer/lead/contact through ONE code path.
    return resolveSalesContext(this.db, leadId, channel);
  }
}

// Customer-facing French message formatters moved to `formatters.ts` to keep
// this class a thin dispatcher. Re-exported here so existing importers (the
// format unit tests + any caller using `from './agent.js'`) are unaffected.
export {
  formatQuotePreviewMessage,
  formatQuoteReadyMessage,
  formatQuoteFailedMessage,
  formatSubscriptionReadyMessage,
  formatSubscriptionFailedMessage,
} from './formatters.js';

// `summarizeJson` + `cleanLLMReply` moved to `text-utils.ts` (M10) to break the
// agent.ts ↔ reply-core.ts import cycle. Re-exported here so existing importers
// (tests + callers using `from './agent.js'`) are unaffected.
export { summarizeJson, cleanLLMReply } from './text-utils.js';
