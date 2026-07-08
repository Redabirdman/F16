/**
 * Sales Agent — channel-agnostic reply core (M10.T?).
 *
 * `generateSalesReply` reproduces the Sales Agent's customer-message reply
 * logic from customer/lead resolution THROUGH the Compliance Sentry, but
 * RETURNS a result instead of sending. This lets two callers share one brain:
 *
 *   - the event-driven WhatsApp/email/SMS path (`SalesAgent.handleCustomerMessage`)
 *     which calls this then sends via the channel layer, and
 *   - the synchronous voice path (`POST /v1/voice/turn`, M10) which speaks the
 *     returned text back to the caller waiting on the line.
 *
 * It deliberately does NOT call `sendViaChannel` — the caller decides what to
 * do with the reply. On a compliance block it DOES create the human action +
 * emit COMPLIANCE.BLOCKED, exactly as the agent did inline, so the escalation
 * behavior is identical regardless of caller.
 *
 * PII boundary: phone/email/full_name decrypt happens in `resolveSalesContext`
 * (same boundary the agent used). Decrypted values are NEVER logged.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { listTurns } from '../../db/repositories/conversation-turns.js';
import { callClaudeWithTools } from '../../llm/tool-loop.js';
import { buildSalesAgentSystemFragments, type SalesAgentTurnContext } from './prompts/index.js';
import type { ChannelId, ContactRef } from '../../channels/types.js';
import { checkComplianceFor } from '../../compliance/index.js';
import { buildQuoteContextLine } from '../../compliance/sentry.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import * as humanActions from '../../db/repositories/human-actions.js';
import { notifyHumanAction } from '../human-notify.js';
import { HUMAN_ACTION_DRAFT_MARKER } from '../reporter-agent/humanize.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { listTools } from '../../tools/index.js';
import { recallCustomerFacts } from '../../memory/index.js';
import { cleanLLMReply, summarizeJson } from './text-utils.js';
import {
  extractQualification,
  saveQualification,
  type QualificationState,
} from './qualification.js';

// 2026-07-03: 10 turns scrolled past the customer's address/civilité mid-sale
// (the agent re-asked → loop). 24 covers a full qualify→confirm conversation.
const MAX_HISTORY_TURNS = 24;
const MAX_REPLY_CHARS = 1500;
const REPLY_TOKEN_BUDGET = 400;
/** Tighter cap for the voice channel — one short spoken sentence. */
const VOICE_REPLY_TOKEN_BUDGET = 150;

/**
 * Curated allow-list of tools the Sales Agent is permitted to invoke. Kept in
 * lock-step with the list inside `agent.ts` — both share this brain, so the
 * voice path and the WhatsApp path must see the exact same toolset.
 */
const SALES_AGENT_TOOL_NAMES = [
  'customer.read_profile',
  'customer.update_profile',
  'customer.remember_fact',
  'knowledge.search',
  'human.escalate',
  'quote.request',
  'quote.confirm',
  'subscription.request',
  'voice.schedule_call',
  'conversation.schedule_followup',
] as const;

/** Cosine-distance ceiling for recalled facts (see agent.ts notes). */
const RECALL_DISTANCE_CEILING = 0.6;
const RECALL_LIMIT = 5;
const RECALL_MIN_CONFIDENCE = 0.3;

/**
 * Resolved `(lead, customer, ContactRef)` for a lead+channel.
 *
 * - Throws on missing lead / missing customer-id-on-lead / missing customer.
 * - Returns `contactRef: null` when the customer has no address for the
 *   requested channel (phone for whatsapp/sms/voice, email for email) —
 *   callers handle this as a soft skip rather than an error.
 *
 * Extracted out of `SalesAgent.resolveCustomerAndContact` so both the agent
 * and the voice route resolve through ONE function.
 */
export async function resolveSalesContext(
  db: Database,
  leadId: string,
  channel: ChannelId,
): Promise<{
  customer: typeof customers.$inferSelect;
  lead: typeof leads.$inferSelect;
  contactRef: ContactRef | null;
}> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (!lead.customerId) throw new Error(`Lead ${leadId} has no customer_id`);
  const [customer] = await db
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

/** Inputs for `generateSalesReply`. */
export interface GenerateSalesReplyDeps {
  db: Database;
  leadId: string;
  channel: ChannelId;
  content: string;
  /** Agent identity for tool context, human-action attribution, compliance emit. */
  agentRole: string;
  agentInstance: string;
}

/**
 * Result of `generateSalesReply`. A discriminated union so the caller knows
 * exactly what happened and what (if anything) to send.
 *
 *   - 'reply'   → a clean, compliance-passed draft ready to send/speak.
 *   - 'blocked' → compliance blocked; a human action was created + emitted.
 *                 The caller must NOT send the draft.
 *   - 'skip'    → soft no-op (empty inbound, no contact address). Mirrors the
 *                 `{ skipped: ... }` shapes the agent returned today.
 *   - 'error'   → a guard tripped (empty / too-long LLM reply, missing leadId).
 *                 Mirrors the `{ ok:false, error }` shapes the agent returned.
 */
export type GenerateSalesReplyResult =
  | {
      outcome: 'reply';
      replyText: string;
      customerId: string;
      leadId: string;
      /** Dotted registry names of any tools the model invoked this turn (e.g.
       *  ['quote.request','quote.confirm']). Used by the comparison-continuation
       *  path to tell "produced the next devis" from "just chatted". */
      toolsInvoked: string[];
    }
  | { outcome: 'blocked'; humanActionId: string; reasons: string[] }
  | { outcome: 'skip'; reason: string }
  | { outcome: 'error'; error: string };

/**
 * Channel-agnostic Sales reply core. Resolves the customer/lead/contact,
 * builds the prompt context (history + Mem0 recall), calls Claude (Sonnet)
 * through the tool-loop, cleans + guards the draft, then runs the Compliance
 * Sentry. Returns a result instead of sending.
 *
 * Behavior is byte-for-byte equivalent to the body of the old
 * `handleCustomerMessage` between resolution and the compliance check.
 */
export async function generateSalesReply(
  deps: GenerateSalesReplyDeps,
): Promise<GenerateSalesReplyResult> {
  const { db, leadId, channel, content, agentRole, agentInstance } = deps;

  if (!content || content.trim().length === 0) {
    return { outcome: 'skip', reason: 'empty-inbound' };
  }

  const { customer, lead, contactRef } = await resolveSalesContext(db, leadId, channel);
  if (!contactRef) {
    logger.warn(
      { leadId, channel, instanceId: agentInstance },
      'sales-agent: no contact address for channel',
    );
    return { outcome: 'skip', reason: 'no-contact-address' };
  }

  // Build context — pull last N turns across any channel, oldest first.
  // Fetched BEFORE qualification extraction (2026-07-08) so the extractor can
  // see the agent's last message: « oui c'est ça » confirming a date the
  // AGENT proposed must land in the slot memory.
  const recentTurnsDesc = await listTurns(db, {
    customerId: customer.id,
    limit: MAX_HISTORY_TURNS,
  });
  const recentTurns = [...recentTurnsDesc].reverse();

  // Progressive qualification memory — merge any quote fields THIS message
  // provides into the durable per-lead state, so the prompt can render a ✓/✗
  // checklist and the agent never re-asks an answered question. Skip on voice
  // (extra Haiku call = latency on a live call; the short voice qualifying
  // conversation rides the history instead).
  let qualification: QualificationState = (lead.qualification as QualificationState | null) ?? {};
  if (channel !== 'voice') {
    try {
      const lastAgentMessage = recentTurnsDesc.find((t) => t.direction === 'outbound')?.content;
      const updated = await extractQualification({
        current: qualification,
        message: content,
        ...(lastAgentMessage ? { lastAgentMessage } : {}),
        db,
      });
      if (JSON.stringify(updated) !== JSON.stringify(qualification)) {
        await saveQualification(db, lead.id, updated);
      }
      qualification = updated;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), leadId: lead.id },
        'sales-agent: qualification extraction failed; continuing without it',
      );
    }
  }
  const fullName = decryptPII(customer.fullName);

  // Mem0 recall — embed the customer's current message, kNN over
  // `customer_facts.embedding` bounded to this customer. Wrapped in try/catch:
  // if embeddings are down the customer reply is more important than perfect
  // memory, so we degrade silently.
  let recalledFacts: string[] = [];
  const _tRecall0 = Date.now();
  // Voice is a live call: skip the Mem0 fact recall. It embeds the message via
  // an external API (OpenRouter) + a kNN query — ~0.9 s of serial latency per
  // turn measured live — and the recentTurns history already gives the qualifying
  // conversation enough context. WhatsApp keeps full recall.
  if (channel !== 'voice') {
    try {
      const hits = await recallCustomerFacts(db, customer.id, content, {
        limit: RECALL_LIMIT,
        minConfidence: RECALL_MIN_CONFIDENCE,
      });
      recalledFacts = hits
        .filter((f) => f.distance < RECALL_DISTANCE_CEILING)
        .map((f) => `[${f.factType}, conf ${f.confidence.toFixed(2)}] ${f.content}`);
    } catch (err) {
      logger.warn(
        { err, leadId: lead.id, instanceId: agentInstance },
        'sales-agent: fact recall failed; continuing without recalled facts',
      );
    }
  }
  const _recallMs = Date.now() - _tRecall0;

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
      quoteState: 'none',
    },
    recentTurns: recentTurns.map((t) => ({
      direction: t.direction,
      channel: t.channel,
      content: t.content,
      at: t.occurredAt,
    })),
    ...(recalledFacts.length > 0 ? { recalledFacts } : {}),
    qualification,
    channel,
  };

  // Call Claude. Text/chat channels use Sonnet for sales quality; the VOICE
  // channel uses Haiku — on a live phone call latency dominates UX (the caller
  // is waiting in silence), and Haiku's ~sub-second replies keep the
  // conversation natural where Sonnet's multi-second turns felt laggy. The
  // system fragments include the cached prefix + per-turn context; userPrompt is
  // ONLY the customer's current message. The tool-loop lets the model invoke
  // registered tools mid-turn and only returns once the response is text-only.
  // Voice is a LIVE phone call — the caller waits in silence, so latency
  // dominates UX. Skip the tool-loop entirely on voice: each tool round-trip
  // (knowledge.search etc.) is another Haiku call + a vector query, stacking
  // several seconds onto every utterance. The qualifying conversation needs
  // only the context already in the prompt (history + recalled facts), so voice
  // runs a single-shot Haiku call. WhatsApp keeps the full toolset.
  const tools = channel === 'voice' ? [] : listTools({ allowed: SALES_AGENT_TOOL_NAMES });
  const systemFragments = await buildSalesAgentSystemFragments(db, ctx);
  const _tLlm0 = Date.now();
  const llmResult = await callClaudeWithTools({
    tier: channel === 'voice' ? 'haiku' : 'sonnet',
    systemFragments,
    userPrompt: content,
    tools,
    toolContext: {
      db,
      agentRole,
      agentInstance,
      correlationId: lead.id,
      // Server-authoritative identity — injected into every tool call so the
      // model never has to (and never gets to) supply the internal UUIDs.
      customerId: customer.id,
      leadId: lead.id,
    },
    // Voice replies must be ONE short spoken sentence (see the voice channel
    // instruction in the system prompt) — a tighter cap is a backstop so a
    // runaway reply can't turn into a multi-second TTS monologue on the call.
    maxTokens: channel === 'voice' ? VOICE_REPLY_TOKEN_BUDGET : REPLY_TOKEN_BUDGET,
    logContext: { agent: 'sales-agent', instanceId: agentInstance, leadId },
  });
  const _llmMs = Date.now() - _tLlm0;
  const draft = cleanLLMReply(llmResult.text);

  logger.info(
    {
      leadId: lead.id,
      instanceId: agentInstance,
      channel,
      iterations: llmResult.iterations,
      toolCalls: llmResult.toolCalls.length,
      inputTokens: llmResult.usage.inputTokens,
      outputTokens: llmResult.usage.outputTokens,
      stopReason: llmResult.stopReason,
      recallMs: _recallMs,
      llmMs: _llmMs,
    },
    'sales-agent: claude turn completed',
  );

  if (!draft || draft.length === 0) {
    logger.warn(
      { leadId, instanceId: agentInstance },
      'sales-agent: LLM returned empty after cleaning',
    );
    return { outcome: 'error', error: 'empty-llm-reply' };
  }
  if (draft.length > MAX_REPLY_CHARS) {
    logger.warn(
      { leadId, instanceId: agentInstance, length: draft.length },
      'sales-agent: LLM reply exceeds max chars',
    );
    return { outcome: 'error', error: `reply-too-long (${draft.length} chars)` };
  }

  // Compliance Sentry — two-layer check (server rules + Haiku LLM)
  // synchronously gates the send. Fail-closed: any block routes the draft to a
  // human action and emits COMPLIANCE.BLOCKED instead of returning a 'reply'.
  // quoteContext feeds the lead's REAL devis/price facts to the sentry — it was
  // judging blind and blocking devis-backed prices as "invented" (2026-07-07).
  const quoteContext = channel === 'voice' ? undefined : await buildQuoteContextLine(db, lead.id);
  // The price MENU already sent to the customer grounds derived numbers too
  // (pack = formule + options sums — blocked as "invented" without it).
  const menuTurn =
    channel === 'voice'
      ? undefined
      : recentTurnsDesc.find((t) => t.direction === 'outbound' && /€\/mois/.test(t.content ?? ''));
  const sentMenuExcerpt = menuTurn?.content ?? undefined;
  // THE robustness fix (Ridaa 2026-07-07 eve): the sentry judged drafts with
  // no history and invented context errors ("le client n'a jamais demandé de
  // second devis" — he had, three turns earlier). Give it the recent
  // conversation, and flag SYSTEM-triggered turns (comparison continuation)
  // whose "last message" is an internal instruction, not customer input.
  const conversationExcerpt =
    channel === 'voice'
      ? undefined
      : recentTurns
          .slice(-8)
          .map(
            (t) =>
              `${t.direction === 'inbound' ? 'CLIENT' : 'AGENT'}: ${(t.content ?? '').slice(0, 180)}`,
          )
          .join('\n');
  const systemTriggered = /^\[CONTINUATION AUTOMATIQUE/.test(content);
  // Ground "c'est programmé / je transmets" claims: the tools the model
  // REALLY executed this turn are facts, not promises (the sentry blocked
  // "un conseiller vous rappelle ce soir" while the call was in flight).
  const toolsExecuted = llmResult.toolCalls.filter((t) => t.ok).map((t) => t.toolName);
  const complianceCtx = {
    customerId: customer.id,
    channel,
    productLine: (lead.productLine ?? 'car') as 'scooter' | 'car',
    leadStatus: lead.status,
    lastInboundContent: content,
    ...(quoteContext ? { quoteContext } : {}),
    ...(sentMenuExcerpt ? { sentMenuExcerpt } : {}),
    ...(conversationExcerpt ? { conversationExcerpt } : {}),
    ...(systemTriggered ? { systemTriggered } : {}),
    ...(toolsExecuted.length > 0 ? { toolsExecuted } : {}),
  };
  // Voice = live call: rules-only compliance (hard server rules still
  // fail-closed), no LLM sentry round-trip (seconds of dead air per turn).
  const rulesOnly = { rulesOnly: channel === 'voice' };
  let finalDraft = draft;
  let compliance = await checkComplianceFor(db, { draft, ctx: complianceCtx }, rulesOnly);

  // SELF-CORRECTION (Ridaa 2026-07-07: "the system should manage by itself").
  // A refused draft gets ONE automatic rewrite with the refusal reasons as
  // feedback, then re-judged. Most blocks are generation flaws (internal
  // monologue leaked as the reply, sloppy phrasing) — the agent fixes its own
  // message and the customer never waits on a human. Only a rewrite that is
  // STILL refused escalates to management. Tools are disabled on the rewrite:
  // attempt 1 already executed its side effects (quote.request etc.) and the
  // rewrite must only rephrase the MESSAGE, never re-drive Maxance.
  if (compliance.verdict === 'block' && channel !== 'voice') {
    logger.info(
      { leadId: lead.id, reasons: compliance.reasons },
      'sales-agent: draft refused — attempting one self-correction rewrite',
    );
    try {
      const retry = await callClaudeWithTools({
        tier: 'sonnet',
        systemFragments,
        userPrompt:
          `${content}\n\n[SYSTÈME — ta réponse précédente a été REFUSÉE par la conformité pour : ` +
          `${compliance.reasons.join(' ; ').slice(0, 500)}. Rédige une NOUVELLE réponse destinée au ` +
          `CLIENT, conforme, naturelle, sans mentionner ce refus ni cette instruction. N'appelle aucun outil.]`,
        tools: [],
        toolContext: {
          db,
          agentRole,
          agentInstance,
          correlationId: lead.id,
          customerId: customer.id,
          leadId: lead.id,
        },
        maxTokens: REPLY_TOKEN_BUDGET,
        logContext: {
          agent: 'sales-agent',
          instanceId: agentInstance,
          leadId,
          selfCorrection: true,
        },
      });
      const retryDraft = cleanLLMReply(retry.text);
      if (retryDraft && retryDraft.length > 0 && retryDraft.length <= MAX_REPLY_CHARS) {
        const recheck = await checkComplianceFor(
          db,
          { draft: retryDraft, ctx: complianceCtx },
          rulesOnly,
        );
        if (recheck.verdict === 'pass') {
          logger.info(
            { leadId: lead.id },
            'sales-agent: self-correction passed compliance — sending the rewrite',
          );
          try {
            await appendAudit(db, {
              actorType: 'agent',
              actorId: `${agentRole}#${agentInstance}`,
              action: 'compliance.self-corrected',
              targetType: 'lead',
              targetId: lead.id,
              meta: {
                refusedReasons: compliance.reasons,
                refusedDraft: draft.slice(0, 400),
                sentDraft: retryDraft.slice(0, 400),
              },
            });
          } catch {
            // best-effort
          }
          finalDraft = retryDraft;
          compliance = recheck;
        } else {
          // Escalate the REWRITE (the better of the two attempts) below.
          finalDraft = retryDraft;
          compliance = recheck;
        }
      }
    } catch (err) {
      logger.warn(
        { leadId: lead.id, err: err instanceof Error ? err.message : String(err) },
        'sales-agent: self-correction rewrite failed — escalating the original block',
      );
    }
  }

  if (compliance.verdict === 'block') {
    logger.warn(
      {
        leadId: lead.id,
        instanceId: agentInstance,
        reasons: compliance.reasons,
        ruleHits: compliance.ruleHits,
        durationMs: compliance.durationMs,
      },
      'sales-agent: compliance blocked draft, escalating to human',
    );

    // WA-group throttle (2026-07-07, Ridaa): several blocks on the same lead
    // within minutes each posted an "ACTION NEEDED" — one pending decision per
    // lead is enough. Check BEFORE inserting the new row; the admin still gets
    // every action, only the duplicate group post is suppressed.
    const alreadyEscalated = await humanActions
      .hasPendingAction(db, { correlationId: lead.id, intent: 'COMPLIANCE_BLOCKED' })
      .catch(() => false);

    // Persist the human action — severity 2 = standard (yellow).
    const action = await humanActions.createAction(db, {
      createdByAgent: `${agentRole}#${agentInstance}`,
      correlationId: lead.id,
      intent: 'COMPLIANCE_BLOCKED',
      severity: 2,
      // The blocked draft rides along after the marker so the WA-group
      // message can show WHAT was blocked (management can't decide "send
      // anyway" blind). humanize.ts splits it back off before rendering.
      summary:
        `Sales Agent draft bloqué (${compliance.ruleHits.join(', ') || 'LLM'}). Raisons : ${compliance.reasons.join(' ; ')}` +
        `${HUMAN_ACTION_DRAFT_MARKER}${finalDraft}`,
      // English labels — these render verbatim in the management WA group.
      options: [
        { id: 'send_as_is', label: 'Send it anyway', kind: 'approve' },
        { id: 'reject_send', label: 'Do not send', kind: 'reject' },
        { id: 'revise', label: 'Ask for a revision', kind: 'revise' },
      ],
    });

    // Emit COMPLIANCE.BLOCKED to the audit trail.
    await sendMessage(
      { db },
      {
        fromRole: agentRole,
        fromInstance: agentInstance,
        toRole: 'supervisor',
        intent: 'COMPLIANCE.BLOCKED',
        payload: { messageId: action.id, reasons: compliance.reasons },
        correlationId: lead.id,
        requiresHuman: true,
        priority: 2,
      },
    );

    // The supervisor emit is audit-only; the WA group needs the HUMAN_ACTION
    // emit (2026-07-04 audit, H1) — a blocked reply means the customer is
    // waiting on a human decision right now. Skipped when a COMPLIANCE_BLOCKED
    // for this lead is already pending in the group (see throttle above).
    if (!alreadyEscalated) {
      await notifyHumanAction(
        db,
        { id: action.id, severity: 2, summary: action.summary },
        { role: agentRole, instanceId: agentInstance, correlationId: lead.id },
      );
    } else {
      logger.info(
        { leadId: lead.id, humanActionId: action.id },
        'sales-agent: compliance block escalated in admin only — a pending block for this lead is already in the WA group',
      );
    }

    return { outcome: 'blocked', humanActionId: action.id, reasons: compliance.reasons };
  }

  // Advisory flag (restructure 2026-07-07): the sentry had minor reservations
  // or was unavailable — the message SENDS, but leave an audit trail so the
  // admin can review flagged conversations after the fact. Never reaches the
  // WA group.
  if (compliance.flagged) {
    logger.info(
      { leadId: lead.id, reasons: compliance.reasons },
      'sales-agent: compliance flagged (advisory) — sending + audit trail',
    );
    try {
      await appendAudit(db, {
        actorType: 'agent',
        actorId: `${agentRole}#${agentInstance}`,
        action: 'compliance.flagged',
        targetType: 'lead',
        targetId: lead.id,
        meta: { reasons: compliance.reasons, draft: finalDraft.slice(0, 500) },
      });
    } catch {
      // best-effort — the send matters more than the audit row
    }
  }

  return {
    outcome: 'reply',
    replyText: finalDraft,
    customerId: customer.id,
    leadId: lead.id,
    toolsInvoked: llmResult.toolCalls.map((t) => t.toolName),
  };
}
