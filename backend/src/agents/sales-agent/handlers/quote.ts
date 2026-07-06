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
import { readFile } from 'node:fs/promises';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../../messaging/dispatcher.js';
import { logger } from '../../../logger.js';
import { decryptPII } from '../../../db/crypto.js';
import { listTurns } from '../../../db/repositories/conversation-turns.js';
import { getQuoteByDevisNumber } from '../../../db/repositories/quotes.js';
import { sendViaChannel } from '../../../channels/send.js';
import { coerceSendableChannel } from '../../../channels/registry.js';
import type { ChannelId } from '../../../channels/types.js';
import * as humanActions from '../../../db/repositories/human-actions.js';
import { notifyHumanAction } from '../../human-notify.js';
import {
  formatQuotePreviewMessage,
  formatQuoteDryRunReadyMessage,
  formatQuoteReadyMessage,
  formatQuoteRelayPendingMessage,
  formatQuoteFailedMessage,
  type AddOnPricingInfo,
  type FormulePricingLine,
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
    leadId?: string;
    pricePreviewEur: { monthly?: number; annual?: number };
    formule?: 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';
    /** 2026-07-02 Achraf's sales script — per-formule monthlies + add-ons. */
    formulePricing?: FormulePricingLine[];
    addOns?: AddOnPricingInfo;
    finalUrl: string;
    screenshots: { step: string; url: string }[];
    durationMs: number;
  };

  // Prefer the explicit payload.leadId — the sales-agent is a SINGLETON (no
  // per-lead meta) and the envelope correlationId is the quoteId, so the
  // fallback heuristic resolves the wrong id (2026-07-02 pipeline verify).
  const leadId = payload.leadId ?? ctx.leadIdFromEnvelope(envelope);
  if (!leadId) return { ok: false, error: 'no leadId available' };

  // Pick the channel the customer last used (or the most recent outbound
  // channel if they haven't replied yet). Default to WhatsApp — the
  // Assuryal funnel is WhatsApp-first.
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
      'sales-agent: no contact address for preview channel',
    );
    return { ok: true, result: { skipped: 'no-contact-address', channel } };
  }

  // Idempotency: if we already sent a turn correlated with this quoteId, skip.
  // We piggy-back on conversation-turns' content scan — the message body
  // carries `(réf #<first-8-chars>)`, so match on the SAME 8-char prefix
  // (the old full-UUID needle could never match → guard was dead code).
  const alreadySent = recentTurns.some(
    (t) =>
      t.direction === 'outbound' && (t.content ?? '').includes(`#${payload.quoteId.slice(0, 8)}`),
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
    ...(payload.formulePricing !== undefined ? { formulePricing: payload.formulePricing } : {}),
    ...(payload.addOns !== undefined ? { addOns: payload.addOns } : {}),
  });

  // Cross-quote dedup (live 2026-07-02, Achraf's test): a comparison re-run
  // produces a SECOND preview with identical pricing — re-sending the full
  // menu reads as a glitch to the customer. If a recent outbound turn
  // carries the exact same body (ignoring the per-quote réf line), skip.
  const stripRef = (s: string): string => s.replace(/\n?\(réf #[^)]*\)\s*$/u, '').trim();
  const draftBody = stripRef(draft);
  const duplicateMenu = recentTurns.some(
    (t) => t.direction === 'outbound' && stripRef(t.content ?? '') === draftBody,
  );
  if (duplicateMenu) {
    logger.info(
      { leadId: lead.id, quoteId: payload.quoteId, instanceId: ctx.instanceId },
      'sales-agent: identical price menu recently sent — skipping duplicate',
    );
    return { ok: true, result: { skipped: 'duplicate-menu', quoteId: payload.quoteId } };
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
    leadId?: string;
    dryRun?: boolean;
    monthlyPremium: number;
    comptantDue: number;
    devisNumber: string;
    pdfSentTo: string;
  };

  // Prefer the explicit payload.leadId (singleton — see handleQuotePreviewReady).
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
  // Inbox-relay delivery (2026-07-02): Maxance emails the PDF to OUR
  // Workspace inbox, not the customer — telling the customer "arrivé par
  // mail à contact@assuryalconseil.fr" would leak the relay and confuse
  // them. In relay mode announce the imminent delivery instead; the actual
  // PDF message follows from handleDevisPdfReceived within ~1 min.
  const relayTo = process.env.F16_DEVIS_COURRIER_TO;
  const relayed = relayTo !== undefined && payload.pdfSentTo === relayTo;
  // dryRun: no courrier left Maxance — never claim an email arrived (live
  // 2026-07-06: DR0000984054's message said "arrivé par mail", a lie).
  const draft = payload.dryRun
    ? formatQuoteDryRunReadyMessage({
        firstName,
        devisNumber: payload.devisNumber,
        quoteId: payload.quoteId,
      })
    : relayed
      ? formatQuoteRelayPendingMessage({
          firstName,
          devisNumber: payload.devisNumber,
          quoteId: payload.quoteId,
        })
      : formatQuoteReadyMessage({
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
  const channel: ChannelId = coerceSendableChannel(
    recentTurns[0]?.channel as ChannelId | undefined,
  );

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
    // English labels — these render verbatim in the management WA group.
    options: [
      { id: 'retry', label: 'Retry the quote', kind: 'approve' },
      { id: 'manual', label: 'Do the quote manually', kind: 'approve' },
      { id: 'abandon', label: 'Abandon this lead', kind: 'reject' },
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

/**
 * DEVIS.PDF_RECEIVED — the devis-inbox watcher relayed Maxance's devis PDF
 * (2026-07-02 inbox-relay delivery). Re-deliver it to the customer on BOTH
 * channels: WhatsApp (document in the live conversation) + branded Assuryal
 * email. Maxance's own relay never reaches gmail.com mailboxes, so this is
 * the only reliable customer-facing delivery path.
 *
 * Idempotency: the visible message embeds `Réf. <devisNumber>`; if a recent
 * outbound turn already carries it, the PDF was delivered (worker restarts /
 * duplicate emails re-emit the intent).
 */
export async function handleDevisPdfReceived(
  ctx: SalesHandlerCtx,
  envelope: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  const payload = envelope.payload as {
    devisNumber: string;
    pdfPath: string;
    filename: string;
    from?: string;
  };

  const quote = await getQuoteByDevisNumber(ctx.db, payload.devisNumber);
  if (!quote || !quote.leadId) {
    // Harness/manual test devis have no quote row — benign, log and move on.
    logger.warn(
      { devisNumber: payload.devisNumber, hasQuote: Boolean(quote) },
      'sales-agent: devis PDF received but no quote/lead to deliver to',
    );
    return { ok: true, result: { skipped: 'quote-not-found', devisNumber: payload.devisNumber } };
  }
  const leadId = quote.leadId;

  const marker = `Réf. ${payload.devisNumber}`;
  // 50-turn window: a chatty conversation could push the delivery marker
  // past a 10-turn scan and let a duplicate DEVIS.PDF_RECEIVED (IMAP \Seen
  // write lost after dispatch) re-deliver the PDF.
  const recentTurns = await listTurns(ctx.db, {
    customerId: quote.customerId,
    leadId,
    limit: 50,
  });
  if (recentTurns.some((t) => t.direction === 'outbound' && (t.content ?? '').includes(marker))) {
    return { ok: true, result: { skipped: 'already-delivered', devisNumber: payload.devisNumber } };
  }

  const pdfBytes = await readFile(payload.pdfPath);
  const pdfDataUri = `data:application/pdf;base64,${pdfBytes.toString('base64')}`;
  const documentBlock = {
    type: 'document' as const,
    url: pdfDataUri,
    filename: `Devis-Assuryal-${payload.devisNumber}.pdf`,
    mimeType: 'application/pdf',
  };
  const messageText =
    `Voici votre devis Assuryal en pièce jointe (${marker}). ` +
    `N'hésitez pas à revenir vers nous pour toute question — et si le devis vous convient, ` +
    `nous pouvons finaliser la souscription ensemble.`;

  const deliveries: Record<string, string> = {};
  const failures: Record<string, string> = {};
  // WhatsApp first (the live conversation), then email — send on every
  // channel the customer has an address for; a failure on one channel must
  // not block the other.
  for (const channel of ['whatsapp', 'email'] as const) {
    try {
      const { customer, contactRef } = await ctx.resolveCustomerAndContact(leadId, channel);
      if (!contactRef) continue;
      const send = await sendViaChannel({
        db: ctx.db,
        customerId: customer.id,
        leadId,
        to: contactRef,
        body: [{ type: 'text', text: messageText }, documentBlock],
        agentRole: ctx.role,
        agentInstance: ctx.instanceId,
        correlationId: quote.id,
      });
      deliveries[channel] = send.receipt.externalId;
    } catch (err) {
      failures[channel] = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          devisNumber: payload.devisNumber,
          leadId,
          channel,
          err: failures[channel],
        },
        'sales-agent: devis PDF delivery failed on channel',
      );
    }
  }

  if (Object.keys(deliveries).length === 0) {
    // Neither channel worked — escalate so a human can send it manually.
    const action = await humanActions.createAction(ctx.db, {
      createdByAgent: `${ctx.role}#${ctx.instanceId}`,
      correlationId: quote.id,
      intent: 'DEVIS_DELIVERY_FAILED',
      severity: 2,
      summary:
        `Devis ${payload.devisNumber} reçu de Maxance mais impossible à livrer au client ` +
        `(lead ${leadId}). PDF : ${payload.pdfPath}. Envoyer manuellement.`,
      options: [
        { id: 'sent_manually', label: 'Sent manually', kind: 'approve' },
        { id: 'abandon', label: 'Abandon', kind: 'reject' },
      ],
    });
    await notifyHumanAction(
      ctx.db,
      { id: action.id, severity: 2, summary: action.summary },
      { role: ctx.role, instanceId: ctx.instanceId, correlationId: quote.id },
    );
    return { ok: false, error: `devis_delivery_failed:${payload.devisNumber}` };
  }

  if (Object.keys(failures).length > 0) {
    // Partial delivery: the customer HAS the PDF on one channel, but the
    // other channel had an address and failed (e.g. revoked App Password).
    // The `Réf.` idempotency marker is now set, so no retry will ever fill
    // the gap — a human must (ACPR: the email copy matters).
    const failedList = Object.entries(failures)
      .map(([ch, msg]) => `${ch} (${msg})`)
      .join(', ');
    const action = await humanActions.createAction(ctx.db, {
      createdByAgent: `${ctx.role}#${ctx.instanceId}`,
      correlationId: quote.id,
      intent: 'DEVIS_DELIVERY_PARTIAL',
      severity: 3,
      summary:
        `Devis ${payload.devisNumber} livré sur ${Object.keys(deliveries).join(', ')} mais PAS ` +
        `sur : ${failedList}. Lead ${leadId}. PDF : ${payload.pdfPath}. Compléter manuellement.`,
      options: [
        { id: 'sent_manually', label: 'Completed manually', kind: 'approve' },
        { id: 'ignore', label: 'Ignore (the delivered channel is enough)', kind: 'reject' },
      ],
    });
    await notifyHumanAction(
      ctx.db,
      { id: action.id, severity: 3, summary: action.summary },
      { role: ctx.role, instanceId: ctx.instanceId, correlationId: quote.id },
    );
  }

  logger.info(
    { devisNumber: payload.devisNumber, leadId, deliveries },
    'sales-agent: devis PDF delivered to customer',
  );
  return { ok: true, result: { devisNumber: payload.devisNumber, deliveries } };
}
