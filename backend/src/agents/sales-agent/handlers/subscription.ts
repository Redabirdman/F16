/**
 * Sales Agent — SUBSCRIPTION.* intent handlers (extracted from agent.ts).
 *
 * Mirrors the QUOTE.* handlers: deterministic, templated French closing /
 * failure messages (no LLM call — the montant comptant + frais figures must
 * be exact and the frais wording compliant; see formatters.ts). Each handler
 * is a free function taking a `SalesHandlerCtx` + the envelope.
 */
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../../messaging/dispatcher.js';
import { logger } from '../../../logger.js';
import { decryptPII } from '../../../db/crypto.js';
import { listTurns } from '../../../db/repositories/conversation-turns.js';
import { sendViaChannel } from '../../../channels/send.js';
import { coerceSendableChannel } from '../../../channels/registry.js';
import type { ChannelId } from '../../../channels/types.js';
import * as humanActions from '../../../db/repositories/human-actions.js';
import { notifyHumanAction } from '../../human-notify.js';
import { formatSubscriptionReadyMessage, formatSubscriptionFailedMessage } from '../formatters.js';
import type { SalesHandlerCtx } from './context.js';

/**
 * Maxance Operator (M8.T7) ran the souscription up to its stop point (the
 * Paiement page in real mode, or the pre-Valider gate in dryRun). Build the
 * customer-facing closing message with the EXACT figures + the Stripe
 * payment link and send it on the customer's most-recent channel.
 *
 * No LLM call — the montant comptant + frais figures must be exact and
 * stable. When Stripe is unconfigured the operator sends
 * `paymentLinkUrl: null`; we then fall back to a "votre conseiller vous
 * transmet le lien" line so the customer still gets a coherent message.
 *
 * Idempotency: same `#<quoteId>` outbound-turn marker scheme as the QUOTE.*
 * handlers — a worker restart mid-flight must not double-send.
 */
export async function handleSubscriptionReady(
  ctx: SalesHandlerCtx,
  envelope: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  const payload = envelope.payload as {
    quoteId: string;
    customerId: string;
    leadId?: string;
    souscripteurRef?: string;
    montantComptantEur?: number;
    fraisComptantEur?: number;
    fraisDossierTotalEur: number;
    assuryalFraisEur: number;
    paymentLinkUrl: string | null;
    dryRun: boolean;
  };

  // Prefer the explicit payload.leadId — the sales-agent is a SINGLETON and
  // the envelope correlationId is the quoteId, so the fallback heuristic
  // resolves the wrong id (same guard as the QUOTE.* handlers, 2026-07-04).
  const leadId = payload.leadId ?? ctx.leadIdFromEnvelope(envelope);
  if (!leadId) return { ok: false, error: 'no leadId available' };

  const recentTurns = await listTurns(ctx.db, {
    customerId: payload.customerId,
    leadId,
    limit: 5,
  });
  const channel: ChannelId = coerceSendableChannel(
    recentTurns[0]?.channel as ChannelId | undefined,
  );

  const { customer, lead, contactRef } = await ctx.resolveCustomerAndContact(leadId, channel);
  if (!contactRef) {
    logger.warn(
      { leadId: lead.id, channel, instanceId: ctx.instanceId, quoteId: payload.quoteId },
      'sales-agent: no contact address for subscription-ready channel',
    );
    return { ok: true, result: { skipped: 'no-contact-address', channel } };
  }

  // Idempotency: skip if we've already sent the "souscription / paiement"
  // message for this quoteId.
  const marker = `#${payload.quoteId.slice(0, 8)} paiement`;
  const alreadySent = recentTurns.some(
    (t) => t.direction === 'outbound' && (t.content ?? '').includes(marker),
  );
  if (alreadySent) {
    return { ok: true, result: { skipped: 'already-sent', quoteId: payload.quoteId } };
  }

  const fullName = decryptPII(customer.fullName) ?? '';
  const firstName = (fullName.split(' ')[0] ?? '').trim();
  const draft = formatSubscriptionReadyMessage({
    firstName,
    ...(payload.montantComptantEur !== undefined
      ? { montantComptantEur: payload.montantComptantEur }
      : {}),
    fraisDossierTotalEur: payload.fraisDossierTotalEur,
    assuryalFraisEur: payload.assuryalFraisEur,
    paymentLinkUrl: payload.paymentLinkUrl,
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
      dryRun: payload.dryRun,
      hasPaymentLink: payload.paymentLinkUrl !== null,
      externalId: send.receipt.externalId,
    },
    'sales-agent: subscription-ready closing message sent to customer',
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
 * Maxance Operator (M8.T7) reported a souscription failure (wrong state, UI
 * drift, duplicate contact, …). Mirror of `handleQuoteFailed`: send the
 * customer a deliberately vague apologetic French notice AND escalate to a
 * HUMAN_ACTION carrying the real errorCode/detail for Ridaa/Achraf. The
 * customer never sees the internal failure code.
 */
export async function handleSubscriptionFailed(
  ctx: SalesHandlerCtx,
  envelope: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  const payload = envelope.payload as {
    quoteId: string;
    customerId: string;
    leadId?: string;
    errorCode: string;
    detail?: string;
    screenshots?: { step: string; url: string }[];
  };

  // Prefer the explicit payload.leadId (singleton — see handleSubscriptionReady).
  const leadId = payload.leadId ?? ctx.leadIdFromEnvelope(envelope);
  if (!leadId) return { ok: false, error: 'no leadId available' };

  const recentTurns = await listTurns(ctx.db, {
    customerId: payload.customerId,
    leadId,
    limit: 5,
  });
  const channel: ChannelId = coerceSendableChannel(
    recentTurns[0]?.channel as ChannelId | undefined,
  );

  const { customer, lead, contactRef } = await ctx.resolveCustomerAndContact(leadId, channel);
  const fullName = decryptPII(customer.fullName) ?? '';
  const firstName = (fullName.split(' ')[0] ?? '').trim();
  const draft = formatSubscriptionFailedMessage({ firstName, quoteId: payload.quoteId });

  // Always escalate — even if the customer channel is unreachable, the
  // closing failure must reach a human (this is the money step).
  const action = await humanActions.createAction(ctx.db, {
    createdByAgent: `${ctx.role}#${ctx.instanceId}`,
    correlationId: payload.quoteId,
    intent: 'SUBSCRIPTION_FAILED',
    severity: 2,
    summary:
      `Souscription ${payload.quoteId} échouée (${payload.errorCode}). ` +
      `Lead ${leadId}. ${payload.detail ? `Détail : ${payload.detail}. ` : ''}` +
      `Capture(s) : ${payload.screenshots?.length ?? 0}.`,
    options: [
      { id: 'retry', label: 'Relancer la souscription', kind: 'approve' },
      { id: 'manual', label: 'Finaliser à la main', kind: 'approve' },
      { id: 'abandon', label: 'Abandonner ce lead', kind: 'reject' },
    ],
  });
  // Row alone only reaches the admin — the WA group needs the emit (H1).
  await notifyHumanAction(
    ctx.db,
    { id: action.id, severity: 2, summary: action.summary },
    { role: ctx.role, instanceId: ctx.instanceId, correlationId: payload.quoteId },
  );

  if (!contactRef) {
    logger.warn(
      { leadId: lead.id, channel, instanceId: ctx.instanceId, quoteId: payload.quoteId },
      'sales-agent: no contact address for subscription-failed message; escalation logged',
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
    'sales-agent: subscription-failed notice sent + human escalation logged',
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
