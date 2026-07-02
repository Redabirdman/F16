/**
 * Sales Agent — QUOTE.* intent handlers (extracted from agent.ts).
 *
 * These produce DETERMINISTIC, templated French messages — no LLM call. The
 * price/figures need to be exact, and Achraf reviews the customer-facing
 * wording once (see formatters.ts), then it's locked.
 *
 * Each handler is a free function taking a `SalesHandlerCtx` (the slice of the
 * SalesAgent it needs) + the envelope, so the agent class stays a thin
 * dispatcher.
 */
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../../messaging/dispatcher.js';
import { logger } from '../../../logger.js';
import { decryptPII } from '../../../db/crypto.js';
import { listTurns } from '../../../db/repositories/conversation-turns.js';
import { sendViaChannel } from '../../../channels/send.js';
import type { ChannelId } from '../../../channels/types.js';
import * as humanActions from '../../../db/repositories/human-actions.js';
import {
  formatQuotePreviewMessage,
  formatQuoteReadyMessage,
  formatQuoteFailedMessage,
} from '../formatters.js';
import type { SalesHandlerCtx } from './context.js';

/**
 * Maxance Operator (M8.T4) produced a price preview. Format a deterministic
 * French message with the price + formule, send it via the customer's most
 * recent channel, and log the outbound turn.
 *
 * Idempotency: keyed on `correlationId = quoteId`. If we've already sent
 * an outbound turn for this quoteId we skip — the Maxance Operator should
 * not normally re-emit, but a worker restart mid-flight could redeliver.
 */
export async function handleQuotePreviewReady(
  ctx: SalesHandlerCtx,
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

  const leadId = ctx.leadIdFromEnvelope(envelope);
  if (!leadId) return { ok: false, error: 'no leadId available' };

  // Pick the channel the customer last used (or the most recent outbound
  // channel if they haven't replied yet). Default to WhatsApp — the
  // Assuryal funnel is WhatsApp-first.
  const recentTurns = await listTurns(ctx.db, {
    customerId: payload.customerId,
    leadId,
    limit: 5,
  });
  const channel: ChannelId = (recentTurns[0]?.channel as ChannelId | undefined) ?? 'whatsapp';

  const { customer, lead, contactRef } = await ctx.resolveCustomerAndContact(leadId, channel);
  if (!contactRef) {
    logger.warn(
      { leadId: lead.id, channel, instanceId: ctx.instanceId, quoteId: payload.quoteId },
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
    db: ctx.db,
    customerId: customer.id,
    leadId: lead.id,
    to: contactRef,
    body: [{ type: 'text', text: draft }],
    agentRole: ctx.role,
    agentInstance: ctx.instanceId,
    correlationId: payload.quoteId,
  });

  logger.info(
    {
      leadId: lead.id,
      customerId: customer.id,
      instanceId: ctx.instanceId,
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
 * outbound turn.
 *
 * Idempotency: same scheme as PREVIEW_READY — scan recent outbound turns
 * for `#<quoteId>` markers to skip duplicate deliveries.
 */
export async function handleQuoteReady(
  ctx: SalesHandlerCtx,
  envelope: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  const payload = envelope.payload as {
    quoteId: string;
    customerId: string;
    monthlyPremium: number;
    comptantDue: number;
    devisNumber: string;
    pdfSentTo: string;
  };

  const leadId = ctx.leadIdFromEnvelope(envelope);
  if (!leadId) return { ok: false, error: 'no leadId available' };

  const recentTurns = await listTurns(ctx.db, {
    customerId: payload.customerId,
    leadId,
    limit: 5,
  });
  const channel: ChannelId = (recentTurns[0]?.channel as ChannelId | undefined) ?? 'whatsapp';

  const { customer, lead, contactRef } = await ctx.resolveCustomerAndContact(leadId, channel);
  if (!contactRef) {
    logger.warn(
      { leadId: lead.id, channel, instanceId: ctx.instanceId, quoteId: payload.quoteId },
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
    db: ctx.db,
    customerId: customer.id,
    leadId: lead.id,
    to: contactRef,
    body: [{ type: 'text', text: draft }],
    agentRole: ctx.role,
    agentInstance: ctx.instanceId,
    correlationId: payload.quoteId,
  });

  logger.info(
    {
      leadId: lead.id,
      customerId: customer.id,
      instanceId: ctx.instanceId,
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
 */
export async function handleQuoteFailed(
  ctx: SalesHandlerCtx,
  envelope: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  const payload = envelope.payload as {
    quoteId: string;
    customerId: string;
    leadId?: string;
    errorCode: string;
    detail?: string;
    screenshots: { step: string; url: string }[];
  };

  // Prefer the explicit payload.leadId (the operator now carries it — the
  // sales-agent singleton has no per-lead meta, and the envelope's
  // correlationId is the quoteId, not a lead). Fall back to the envelope
  // heuristic only when an older emitter omits it.
  const leadId = payload.leadId ?? ctx.leadIdFromEnvelope(envelope);
  if (!leadId) return { ok: false, error: 'no leadId available' };

  // Pick the customer's most-recent channel, same heuristic as PREVIEW_READY.
  const recentTurns = await listTurns(ctx.db, {
    customerId: payload.customerId,
    leadId,
    limit: 5,
  });
  const channel: ChannelId = (recentTurns[0]?.channel as ChannelId | undefined) ?? 'whatsapp';

  const { customer, lead, contactRef } = await ctx.resolveCustomerAndContact(leadId, channel);
  const fullName = decryptPII(customer.fullName) ?? '';
  const firstName = (fullName.split(' ')[0] ?? '').trim();
  const draft = formatQuoteFailedMessage({ firstName, quoteId: payload.quoteId });

  // Always escalate — even if we can't reach the customer on the channel,
  // Ridaa/Achraf must know the quote failed.
  const action = await humanActions.createAction(ctx.db, {
    createdByAgent: `${ctx.role}#${ctx.instanceId}`,
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
      { leadId: lead.id, channel, instanceId: ctx.instanceId, quoteId: payload.quoteId },
      'sales-agent: no contact address for quote-failed message; escalation logged',
    );
    return {
      ok: true,
      result: { skipped: 'no-contact-address', humanActionId: action.id, channel },
    };
  }

  const send = await sendViaChannel({
    db: ctx.db,
    customerId: customer.id,
    leadId: lead.id,
    to: contactRef,
    body: [{ type: 'text', text: draft }],
    agentRole: ctx.role,
    agentInstance: ctx.instanceId,
    correlationId: payload.quoteId,
  });

  logger.warn(
    {
      leadId: lead.id,
      customerId: customer.id,
      instanceId: ctx.instanceId,
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
