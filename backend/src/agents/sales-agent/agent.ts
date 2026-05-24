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
 * Future plug-in points:
 *   - M10   — voice channel (Pipecat); for now we skip when `channel='voice'`
 *             cannot send (no phone hashed).
 *   - M11   — Customer Engagement Agent schedules a 24h-no-reply follow-up
 *             from the welcome event-fact recorded by `handleLeadScored`.
 */
import { eq } from 'drizzle-orm';
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { listTurns } from '../../db/repositories/conversation-turns.js';
import { callClaudeWithTools } from '../../llm/tool-loop.js';
import { buildSalesAgentSystemPrompt, type SalesAgentTurnContext } from './prompts/index.js';
import { sendViaChannel } from '../../channels/send.js';
import type { ChannelId, ContactRef } from '../../channels/types.js';
import { checkComplianceFor } from '../../compliance/index.js';
import * as humanActions from '../../db/repositories/human-actions.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
// Importing the tools barrel registers all built-in tools at module load
// (side-effect registration). The Sales Agent is the first user of the
// tool-use loop, so this is the natural boot point until a dedicated tool
// bootstrap module is needed (post M6).
import { listTools } from '../../tools/index.js';
import { recallCustomerFacts, recordCustomerFact } from '../../memory/index.js';

const MAX_HISTORY_TURNS = 10;
const MAX_REPLY_CHARS = 1500;
const REPLY_TOKEN_BUDGET = 400;

/**
 * Curated allow-list of tools the Sales Agent is permitted to invoke. Other
 * agent roles (Service, Quote) will declare their own list against the same
 * registry. The tool-loop trusts this list — it does not enforce.
 */
const SALES_AGENT_TOOL_NAMES = [
  'customer.read_profile',
  'customer.update_profile',
  'customer.remember_fact',
  'knowledge.search',
  'human.escalate',
  // M8.T8 Option A: trottinette quote kickoff. Tool builds the
  // QUOTE.REQUESTED payload + writes the canonical quotes row + emits
  // to the maxance-operator queue. Sales Agent calls this once it has
  // gathered the full trottinette qualification field set.
  'quote.request',
] as const;

/**
 * Cosine-distance ceiling for facts recalled into the prompt. Conservative —
 * we'd rather omit a marginally-relevant fact than splice noise into the
 * model's context. Tune as we observe real recall quality.
 */
const RECALL_DISTANCE_CEILING = 0.6;
const RECALL_LIMIT = 5;
const RECALL_MIN_CONFIDENCE = 0.3;

export class SalesAgent extends BaseAgent {
  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    try {
      switch (envelope.intent) {
        case 'LEAD.SCORED':
          return await this.handleLeadScored(envelope);
        case 'CUSTOMER.MESSAGE_RECEIVED':
          return await this.handleCustomerMessage(envelope);
        case 'QUOTE.PREVIEW_READY':
          return await this.handleQuotePreviewReady(envelope);
        case 'QUOTE.READY':
          return await this.handleQuoteReady(envelope);
        case 'QUOTE.FAILED':
          return await this.handleQuoteFailed(envelope);
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

    // Status transition: scored → qualifying. Atomic single-statement update.
    await this.db
      .update(leads)
      .set({ status: 'qualifying', updatedAt: new Date() })
      .where(eq(leads.id, lead.id));

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

    // Mem0 recall — embed the customer's current message, kNN over
    // `customer_facts.embedding` bounded to this customer, splice the hits
    // into the system prompt's per-turn fragment. Wrapped in try/catch:
    // if embeddings are down the customer reply is more important than
    // perfect memory, so we degrade silently.
    let recalledFacts: string[] = [];
    try {
      const hits = await recallCustomerFacts(this.db, customer.id, payload.content, {
        limit: RECALL_LIMIT,
        minConfidence: RECALL_MIN_CONFIDENCE,
      });
      recalledFacts = hits
        .filter((f) => f.distance < RECALL_DISTANCE_CEILING)
        .map((f) => `[${f.factType}, conf ${f.confidence.toFixed(2)}] ${f.content}`);
    } catch (err) {
      logger.warn(
        { err, leadId: lead.id, instanceId: this.instanceId },
        'sales-agent: fact recall failed; continuing without recalled facts',
      );
    }

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
      ...(recalledFacts.length > 0 ? { recalledFacts } : {}),
      channel: payload.channel,
    };

    // Call Claude — Sonnet for sales conversation. The system fragments
    // (M6.T2) include the cached prefix + per-turn context; userPrompt is
    // ONLY the customer's current message. The tool-loop (M6.T5) lets the
    // model invoke registered tools mid-turn (customer profile read/update,
    // knowledge search, human escalation) and only returns once the response
    // is text-only.
    const tools = listTools({ allowed: SALES_AGENT_TOOL_NAMES });
    const llmResult = await callClaudeWithTools({
      tier: 'sonnet',
      systemFragments: buildSalesAgentSystemPrompt(ctx),
      userPrompt: payload.content,
      tools,
      toolContext: {
        db: this.db,
        agentRole: this.role,
        agentInstance: this.instanceId,
        correlationId: lead.id,
      },
      maxTokens: REPLY_TOKEN_BUDGET,
      logContext: { agent: 'sales-agent', instanceId: this.instanceId, leadId },
    });
    const draft = cleanLLMReply(llmResult.text);

    logger.info(
      {
        leadId: lead.id,
        instanceId: this.instanceId,
        iterations: llmResult.iterations,
        toolCalls: llmResult.toolCalls.length,
        inputTokens: llmResult.usage.inputTokens,
        outputTokens: llmResult.usage.outputTokens,
        stopReason: llmResult.stopReason,
      },
      'sales-agent: claude turn completed',
    );

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

    // M6.T4 — Compliance Sentry. Two-layer check (server rules + Haiku LLM)
    // synchronously gates the send. Fail-closed: any block routes the draft
    // to a human action and emits COMPLIANCE.BLOCKED instead of sending.
    const compliance = await checkComplianceFor(this.db, {
      draft,
      ctx: {
        customerId: customer.id,
        channel: payload.channel,
        productLine: (lead.productLine ?? 'car') as 'scooter' | 'car',
        leadStatus: lead.status,
        lastInboundContent: payload.content,
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
        'sales-agent: compliance blocked draft, escalating to human',
      );

      // Persist the human action — severity 2 = standard (yellow).
      const action = await humanActions.createAction(this.db, {
        createdByAgent: `${this.role}#${this.instanceId}`,
        correlationId: lead.id,
        intent: 'COMPLIANCE_BLOCKED',
        severity: 2,
        summary: `Sales Agent draft bloqué (${compliance.ruleHits.join(', ') || 'LLM'}). Raisons : ${compliance.reasons.join(' ; ')}`,
        options: [
          { id: 'send_as_is', label: 'Envoyer quand même', kind: 'approve' },
          { id: 'reject_send', label: "Refuser l'envoi", kind: 'reject' },
          { id: 'revise', label: 'Demander une révision', kind: 'revise' },
        ],
      });

      // Emit COMPLIANCE.BLOCKED to the audit trail.
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
   * Maxance Operator (M8.T4) produced a price preview. Format a deterministic
   * French message with the price + formule, send it via the customer's most
   * recent channel, and log the outbound turn. No LLM call — the price
   * needs to be exact, and Achraf will sleep better at night knowing the
   * customer-facing number is templated, not synthesised.
   *
   * Idempotency: keyed on `correlationId = quoteId`. If we've already sent
   * an outbound turn for this quoteId we skip — the Maxance Operator should
   * not normally re-emit, but a worker restart mid-flight could redeliver.
   */
  private async handleQuotePreviewReady(
    envelope: AgentMessageEnvelope,
  ): Promise<MessageHandlerResult> {
    const payload = envelope.payload as {
      quoteId: string;
      customerId: string;
      pricePreviewEur: { monthly?: number; annual?: number };
      formule?: 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';
      finalUrl: string;
      screenshots: { step: string; url: string }[];
      durationMs: number;
    };

    const leadId = this.leadIdFromEnvelope(envelope);
    if (!leadId) return { ok: false, error: 'no leadId available' };

    // Pick the channel the customer last used (or the most recent outbound
    // channel if they haven't replied yet). Default to WhatsApp — the
    // Assuryal funnel is WhatsApp-first.
    const recentTurns = await listTurns(this.db, {
      customerId: payload.customerId,
      leadId,
      limit: 5,
    });
    const channel: ChannelId = (recentTurns[0]?.channel as ChannelId | undefined) ?? 'whatsapp';

    const { customer, lead, contactRef } = await this.resolveCustomerAndContact(leadId, channel);
    if (!contactRef) {
      logger.warn(
        { leadId: lead.id, channel, instanceId: this.instanceId, quoteId: payload.quoteId },
        'sales-agent: no contact address for preview channel',
      );
      return { ok: true, result: { skipped: 'no-contact-address', channel } };
    }

    // Idempotency: if we already sent a turn correlated with this quoteId, skip.
    // We piggy-back on conversation-turns' content scan — quoteId appears in
    // the body as a non-visible marker we add below.
    const alreadySent = recentTurns.some(
      (t) => t.direction === 'outbound' && (t.content ?? '').includes(`#${payload.quoteId}`),
    );
    if (alreadySent) {
      return { ok: true, result: { skipped: 'already-sent', quoteId: payload.quoteId } };
    }

    const fullName = decryptPII(customer.fullName) ?? '';
    const firstName = (fullName.split(' ')[0] ?? '').trim();
    const draft = formatQuotePreviewMessage({
      firstName,
      ...(payload.pricePreviewEur.monthly !== undefined
        ? { monthly: payload.pricePreviewEur.monthly }
        : {}),
      ...(payload.pricePreviewEur.annual !== undefined
        ? { annual: payload.pricePreviewEur.annual }
        : {}),
      formule: payload.formule ?? 'tiers_illimite',
      quoteId: payload.quoteId,
    });

    const send = await sendViaChannel({
      db: this.db,
      customerId: customer.id,
      leadId: lead.id,
      to: contactRef,
      body: [{ type: 'text', text: draft }],
      agentRole: this.role,
      agentInstance: this.instanceId,
      correlationId: payload.quoteId,
    });

    logger.info(
      {
        leadId: lead.id,
        customerId: customer.id,
        instanceId: this.instanceId,
        channel,
        quoteId: payload.quoteId,
        externalId: send.receipt.externalId,
        monthly: payload.pricePreviewEur.monthly,
        annual: payload.pricePreviewEur.annual,
      },
      'sales-agent: quote preview sent to customer',
    );

    return {
      ok: true,
      result: {
        intent: envelope.intent,
        sent: true,
        channel,
        externalId: send.receipt.externalId,
        quoteId: payload.quoteId,
      },
    };
  }

  /**
   * Maxance Operator (M8.T6) completed the Valider devis + email send path.
   * The customer's quote PDF has been dispatched by Maxance directly to
   * their email. Send a short French confirmation message and log the
   * outbound turn. No LLM call — the response is templated for the same
   * reasons as PREVIEW_READY (Achraf reviews the wording once).
   *
   * Idempotency: same scheme as PREVIEW_READY — scan recent outbound turns
   * for `#<quoteId>` markers to skip duplicate deliveries.
   */
  private async handleQuoteReady(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    const payload = envelope.payload as {
      quoteId: string;
      customerId: string;
      monthlyPremium: number;
      comptantDue: number;
      devisNumber: string;
      pdfSentTo: string;
    };

    const leadId = this.leadIdFromEnvelope(envelope);
    if (!leadId) return { ok: false, error: 'no leadId available' };

    const recentTurns = await listTurns(this.db, {
      customerId: payload.customerId,
      leadId,
      limit: 5,
    });
    const channel: ChannelId = (recentTurns[0]?.channel as ChannelId | undefined) ?? 'whatsapp';

    const { customer, lead, contactRef } = await this.resolveCustomerAndContact(leadId, channel);
    if (!contactRef) {
      logger.warn(
        { leadId: lead.id, channel, instanceId: this.instanceId, quoteId: payload.quoteId },
        'sales-agent: no contact address for quote-ready channel',
      );
      return { ok: true, result: { skipped: 'no-contact-address', channel } };
    }

    // Idempotency: skip if we've already messaged the customer the
    // "devis envoyé" confirmation for this quoteId.
    const marker = `#${payload.quoteId.slice(0, 8)} envoyé`;
    const alreadySent = recentTurns.some(
      (t) => t.direction === 'outbound' && (t.content ?? '').includes(marker),
    );
    if (alreadySent) {
      return { ok: true, result: { skipped: 'already-sent', quoteId: payload.quoteId } };
    }

    const fullName = decryptPII(customer.fullName) ?? '';
    const firstName = (fullName.split(' ')[0] ?? '').trim();
    const draft = formatQuoteReadyMessage({
      firstName,
      pdfSentTo: payload.pdfSentTo,
      devisNumber: payload.devisNumber,
      quoteId: payload.quoteId,
    });

    const send = await sendViaChannel({
      db: this.db,
      customerId: customer.id,
      leadId: lead.id,
      to: contactRef,
      body: [{ type: 'text', text: draft }],
      agentRole: this.role,
      agentInstance: this.instanceId,
      correlationId: payload.quoteId,
    });

    logger.info(
      {
        leadId: lead.id,
        customerId: customer.id,
        instanceId: this.instanceId,
        channel,
        quoteId: payload.quoteId,
        devisNumber: payload.devisNumber,
        externalId: send.receipt.externalId,
      },
      'sales-agent: quote-ready confirmation sent to customer',
    );

    return {
      ok: true,
      result: {
        intent: envelope.intent,
        sent: true,
        channel,
        externalId: send.receipt.externalId,
        quoteId: payload.quoteId,
        devisNumber: payload.devisNumber,
      },
    };
  }

  /**
   * Maxance Operator (M8.T4) reported a quote-flow failure. Send a short,
   * apologetic French message to the customer ("on revient vers vous très
   * vite") and escalate to a HUMAN_ACTION so Ridaa/Achraf can look at
   * what went wrong (the operator-side error code is in the payload for
   * the admin UI; never echoed to the customer).
   *
   * The customer message is deliberately vague — they don't need the
   * Cloudflare/Stagehand internals. The HUMAN_ACTION carries the actual
   * errorCode and detail for diagnosis.
   */
  private async handleQuoteFailed(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    const payload = envelope.payload as {
      quoteId: string;
      customerId: string;
      errorCode: string;
      detail?: string;
      screenshots: { step: string; url: string }[];
    };

    const leadId = this.leadIdFromEnvelope(envelope);
    if (!leadId) return { ok: false, error: 'no leadId available' };

    // Pick the customer's most-recent channel, same heuristic as PREVIEW_READY.
    const recentTurns = await listTurns(this.db, {
      customerId: payload.customerId,
      leadId,
      limit: 5,
    });
    const channel: ChannelId = (recentTurns[0]?.channel as ChannelId | undefined) ?? 'whatsapp';

    const { customer, lead, contactRef } = await this.resolveCustomerAndContact(leadId, channel);
    const fullName = decryptPII(customer.fullName) ?? '';
    const firstName = (fullName.split(' ')[0] ?? '').trim();
    const draft = formatQuoteFailedMessage({ firstName, quoteId: payload.quoteId });

    // Always escalate — even if we can't reach the customer on the channel,
    // Ridaa/Achraf must know the quote failed.
    const action = await humanActions.createAction(this.db, {
      createdByAgent: `${this.role}#${this.instanceId}`,
      correlationId: payload.quoteId,
      intent: 'QUOTE_FAILED',
      severity: 2,
      summary:
        `Quote ${payload.quoteId} failed (${payload.errorCode}). ` +
        `Lead ${leadId}. ${payload.detail ? `Détail : ${payload.detail}. ` : ''}` +
        `Capture(s) : ${payload.screenshots.length}.`,
      options: [
        { id: 'retry', label: 'Relancer le devis', kind: 'approve' },
        { id: 'manual', label: 'Faire le devis à la main', kind: 'approve' },
        { id: 'abandon', label: 'Abandonner ce lead', kind: 'reject' },
      ],
    });

    if (!contactRef) {
      logger.warn(
        { leadId: lead.id, channel, instanceId: this.instanceId, quoteId: payload.quoteId },
        'sales-agent: no contact address for quote-failed message; escalation logged',
      );
      return {
        ok: true,
        result: { skipped: 'no-contact-address', humanActionId: action.id, channel },
      };
    }

    const send = await sendViaChannel({
      db: this.db,
      customerId: customer.id,
      leadId: lead.id,
      to: contactRef,
      body: [{ type: 'text', text: draft }],
      agentRole: this.role,
      agentInstance: this.instanceId,
      correlationId: payload.quoteId,
    });

    logger.warn(
      {
        leadId: lead.id,
        customerId: customer.id,
        instanceId: this.instanceId,
        channel,
        quoteId: payload.quoteId,
        errorCode: payload.errorCode,
        externalId: send.receipt.externalId,
        humanActionId: action.id,
      },
      'sales-agent: quote-failed notice sent + human escalation logged',
    );

    return {
      ok: true,
      result: {
        intent: envelope.intent,
        sent: true,
        channel,
        externalId: send.receipt.externalId,
        humanActionId: action.id,
        quoteId: payload.quoteId,
      },
    };
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
 * Format the customer-facing French price-preview message for a trottinette
 * quote. Templated, no LLM call — the headline figures must be EXACT and
 * stable (Achraf reviews the wording once, then it's locked).
 *
 * The trailing `#<quoteId>` is an idempotency / lookup marker — invisible
 * enough to not annoy the customer ("réf #abc..." reads like a normal
 * support reference) and we use it in handleQuotePreviewReady to detect
 * "we already sent this".
 *
 * Pure function — covered by unit tests.
 */
export function formatQuotePreviewMessage(opts: {
  firstName?: string;
  monthly?: number;
  annual?: number;
  formule: 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
  const formuleLabel =
    opts.formule === 'tiers_illimite'
      ? 'Tiers Illimité'
      : opts.formule === 'vol_incendie'
        ? 'Tiers Illimité + Vol & Incendie'
        : 'Tous Risques';

  const lines: string[] = [greeting, '', 'Voici votre devis trottinette :'];
  if (opts.monthly !== undefined) {
    lines.push(`• Mensuel : ${formatEur(opts.monthly)}`);
  }
  if (opts.annual !== undefined) {
    lines.push(`• Annuel : ${formatEur(opts.annual)}`);
  }
  lines.push(`• Formule : ${formuleLabel}`);
  lines.push('');
  lines.push('Souhaitez-vous que je vous envoie le devis officiel par mail ?');
  lines.push('');
  lines.push(`(réf #${opts.quoteId.slice(0, 8)})`);
  return lines.join('\n');
}

/**
 * Customer-facing confirmation after Maxance has emailed the quote PDF.
 * Achraf's wording — locked once, templated forever.
 *
 * Pure function — covered by unit tests.
 */
export function formatQuoteReadyMessage(opts: {
  firstName?: string;
  pdfSentTo: string;
  devisNumber: string;
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
  return [
    greeting,
    '',
    `C'est envoyé ! Votre devis trottinette vient d'arriver par mail à ${opts.pdfSentTo}.`,
    `Référence du devis : ${opts.devisNumber}.`,
    '',
    'Vérifiez aussi vos spams si vous ne le voyez pas.',
    '',
    `(réf #${opts.quoteId.slice(0, 8)} envoyé)`,
  ].join('\n');
}

/**
 * Customer-facing message when the Maxance flow blew up. Deliberately vague
 * — the customer doesn't need to know about Cloudflare / Stagehand / Auth0.
 * The real diagnostics are in the HUMAN_ACTION the handler also creates.
 *
 * Pure function — covered by unit tests.
 */
export function formatQuoteFailedMessage(opts: { firstName?: string; quoteId: string }): string {
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
  return [
    greeting,
    '',
    "J'ai un petit souci technique pour finaliser votre devis trottinette.",
    'Un conseiller revient vers vous très rapidement.',
    '',
    `(réf #${opts.quoteId.slice(0, 8)})`,
  ].join('\n');
}

/**
 * Format a EUR number French-style: `18.95€/mois` style numbers stay
 * accurate, but the decimal separator is a comma (`18,95 €`) per French
 * convention. Two decimals always.
 */
function formatEur(value: number): string {
  // toFixed(2) → "18.95"; swap the dot for a comma.
  return `${value.toFixed(2).replace('.', ',')} €`;
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
