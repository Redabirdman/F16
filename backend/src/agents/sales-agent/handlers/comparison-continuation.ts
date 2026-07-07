/**
 * Two-devis comparison AUTO-CONTINUATION (2026-07-07, Achraf run-2 finding).
 *
 * The two-devis comparison (playbook step 6) is strictly serial:
 *   confirm variant 1 → WAIT for the send confirmation → quote.request variant 2
 *   → WAIT for prices → quote.confirm variant 2.
 * The "WAIT for the send confirmation" arrives as DEVIS.PDF_RECEIVED (the
 * inbox-relay delivered devis #1). But nothing WOKE the LLM at that point, so
 * the agent that had promised « j'enchaîne avec le deuxième » went idle until
 * the customer complained. This module supplies the two missing self-wakes:
 *
 *   1. after devis #1 delivers → run an LLM turn that (if a 2nd devis was
 *      promised) calls quote.request for the remaining variant + tells the
 *      customer it's on the way. It sets a single-use Redis marker.
 *   2. when the NEXT price preview arrives with that marker set →
 *      handleQuotePreviewReady runs an LLM turn that confirms the 2nd variant.
 *
 * Design guarantees against a runaway self-loop:
 *   - the marker is single-use (GET-then-DEL) and TTL-bounded,
 *   - a hard cap on delivered devis per lead (MAX_DEVIS_PER_LEAD),
 *   - the LLM emits the NO_CONTINUATION sentinel when everything promised is
 *     already sent, and we only send/act when a quote tool actually fired.
 *
 * Everything here is best-effort: a failure NEVER breaks the delivery/preview
 * that triggered it (the customer already has their devis / menu).
 */
import { getRedis } from '../../../queue/index.js';
import { listTurns } from '../../../db/repositories/conversation-turns.js';
import { sendViaChannel } from '../../../channels/send.js';
import { coerceSendableChannel } from '../../../channels/registry.js';
import { generateSalesReply } from '../reply-core.js';
import { logger } from '../../../logger.js';
import type { ChannelId } from '../../../channels/types.js';
import type { SalesHandlerCtx } from './context.js';

/** Sentinel the LLM returns when there is nothing more to send. */
export const NO_CONTINUATION = '__NO_CONTINUATION__';
/** Outbound devis-delivery messages carry `Réf. DR…` (see handleDevisPdfReceived). */
const DELIVERED_MARKER = /Réf\.\s*DR/i;
/** Hard backstop: never self-continue past this many delivered devis on a lead. */
const MAX_DEVIS_PER_LEAD = 3;
/** How long a "second leg in flight" marker lives — one request→preview window. */
const PENDING_TTL_S = 900;
const QUOTE_TOOLS = new Set(['quote.request', 'quote.confirm']);

const pendingKey = (leadId: string): string => `f16:comparison-pending:${leadId}`;

/** Has the delivery-continuation flagged a comparison 2nd leg as in-flight for
 *  this lead? Single-use: reading it CONSUMES it (GET then DEL). */
export async function consumeComparisonPending(leadId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = pendingKey(leadId);
    const val = await redis.get(key);
    if (val === null) return false;
    await redis.del(key);
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), leadId },
      'comparison-continuation: pending-marker read failed',
    );
    return false;
  }
}

async function markComparisonPending(leadId: string): Promise<void> {
  try {
    await getRedis().set(pendingKey(leadId), '1', 'EX', PENDING_TTL_S);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), leadId },
      'comparison-continuation: pending-marker set failed',
    );
  }
}

async function countDeliveredDevis(
  ctx: SalesHandlerCtx,
  customerId: string,
  leadId: string,
): Promise<number> {
  const turns = await listTurns(ctx.db, { customerId, leadId, limit: 50 });
  return turns.filter((t) => t.direction === 'outbound' && DELIVERED_MARKER.test(t.content ?? ''))
    .length;
}

/**
 * Cheap deterministic pre-gate so the (LLM) continuation turn only runs when the
 * conversation actually shows two-devis / comparison intent — the customer asked
 * for it or the agent promised it. Skips the LLM entirely for the common
 * single-devis flow. Broad on purpose: a false positive just costs one turn that
 * returns the NO_CONTINUATION sentinel; a false negative reverts to the old
 * "customer had to complain" behaviour, so we cast wide.
 */
const COMPARISON_INTENT =
  /\bdeux devis\b|\bles deux\b|\b2e? devis\b|\bsecond devis\b|\bdeuxi[eè]me devis\b|\bj['’ ]?encha[iî]ne\b|\bavec et sans\b|\bcomparer\b|\bcomparat/i;

async function conversationShowsComparison(
  ctx: SalesHandlerCtx,
  customerId: string,
  leadId: string,
): Promise<boolean> {
  const turns = await listTurns(ctx.db, { customerId, leadId, limit: 20 });
  return turns.some((t) => COMPARISON_INTENT.test(t.content ?? ''));
}

async function pickChannel(
  ctx: SalesHandlerCtx,
  customerId: string,
  leadId: string,
): Promise<ChannelId> {
  const recent = await listTurns(ctx.db, { customerId, leadId, limit: 5 });
  return coerceSendableChannel(recent[0]?.channel as ChannelId | undefined);
}

/**
 * Run one system-initiated LLM continuation turn and, IF the model actually
 * drove a quote tool (i.e. it produced/queued the next devis rather than
 * emitting the NO_CONTINUATION sentinel), send its short acknowledgment to the
 * customer. Returns which quote tools fired so the caller can set the marker.
 */
async function runContinuationTurn(
  ctx: SalesHandlerCtx,
  args: { leadId: string; customerId: string; prompt: string },
): Promise<{ toolsInvoked: string[]; sent: boolean }> {
  const channel = await pickChannel(ctx, args.customerId, args.leadId);
  const reply = await generateSalesReply({
    db: ctx.db,
    leadId: args.leadId,
    channel,
    content: args.prompt,
    agentRole: ctx.role,
    agentInstance: ctx.instanceId,
  });
  if (reply.outcome !== 'reply') {
    // 'blocked' already escalated inside generateSalesReply; 'skip'/'error' are
    // benign here (no contact / empty). Nothing to send either way.
    return { toolsInvoked: [], sent: false };
  }
  const droveQuote = reply.toolsInvoked.some((t) => QUOTE_TOOLS.has(t));
  const isSentinel = reply.replyText.trim().toUpperCase().includes(NO_CONTINUATION);
  if (!droveQuote || isSentinel) {
    // Nothing more to do — all promised devis already sent. Do NOT send the
    // sentinel or a spurious closing message to the customer.
    return { toolsInvoked: reply.toolsInvoked, sent: false };
  }
  const { contactRef } = await ctx.resolveCustomerAndContact(args.leadId, channel);
  if (!contactRef) return { toolsInvoked: reply.toolsInvoked, sent: false };
  await sendViaChannel({
    db: ctx.db,
    customerId: reply.customerId,
    leadId: reply.leadId,
    to: contactRef,
    body: [{ type: 'text', text: reply.replyText }],
    agentRole: ctx.role,
    agentInstance: ctx.instanceId,
    correlationId: reply.leadId,
  });
  return { toolsInvoked: reply.toolsInvoked, sent: true };
}

/**
 * Wake #1 — called after devis #1 delivers. If a comparison 2nd devis was
 * promised, the LLM calls quote.request for the remaining variant; we then arm
 * the pending marker so the resulting preview auto-confirms (wake #2).
 */
export async function continueComparisonAfterDelivery(
  ctx: SalesHandlerCtx,
  args: { leadId: string; customerId: string; devisNumber: string },
): Promise<void> {
  try {
    const delivered = await countDeliveredDevis(ctx, args.customerId, args.leadId);
    if (delivered >= MAX_DEVIS_PER_LEAD) {
      logger.info(
        { leadId: args.leadId, delivered },
        'comparison-continuation: delivered-devis cap reached; not continuing',
      );
      return;
    }
    // Cheap gate: skip the LLM turn entirely unless the conversation shows
    // comparison intent — the common single-devis delivery does nothing.
    if (!(await conversationShowsComparison(ctx, args.customerId, args.leadId))) {
      return;
    }
    const prompt =
      `[CONTINUATION AUTOMATIQUE — message système interne, ce n'est PAS le client qui parle] ` +
      `Le devis ${args.devisNumber} vient d'être envoyé au client (WhatsApp + email). ` +
      `Relis toute la conversation. Si tu as promis au client PLUSIEURS devis ` +
      `(comparaison avec / sans options) et qu'il en reste AU MOINS UN à envoyer, ` +
      `enchaîne MAINTENANT : appelle quote.request pour la variante restante ` +
      `(formData STRICTEMENT identique au devis précédent) puis annonce brièvement au ` +
      `client que son second devis arrive tout de suite. N'appelle PAS quote.confirm ` +
      `dans ce tour. Si TOUS les devis promis ont déjà été envoyés — chaque devis livré ` +
      `apparaît comme un message « Voici votre devis … Réf. DR… », compte-les — ` +
      `n'appelle AUCUN outil et réponds EXACTEMENT : ${NO_CONTINUATION}`;
    const { toolsInvoked } = await runContinuationTurn(ctx, {
      leadId: args.leadId,
      customerId: args.customerId,
      prompt,
    });
    if (toolsInvoked.includes('quote.request')) {
      await markComparisonPending(args.leadId);
      logger.info(
        { leadId: args.leadId, devisNumber: args.devisNumber },
        'comparison-continuation: 2nd devis requested — armed preview auto-confirm',
      );
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), leadId: args.leadId },
      'comparison-continuation: after-delivery continuation failed (non-blocking)',
    );
  }
}

/**
 * Wake #2 — called by handleQuotePreviewReady ONLY when the pending marker was
 * set (so normal first-quote previews are completely untouched). The prices for
 * the comparison's 2nd variant just arrived; the LLM confirms it. Returns true
 * if it handled the preview (caller then skips the normal price-menu send).
 */
export async function continueComparisonAfterPreview(
  ctx: SalesHandlerCtx,
  args: { leadId: string; customerId: string },
): Promise<boolean> {
  try {
    const prompt =
      `[CONTINUATION AUTOMATIQUE — message système interne, ce n'est PAS le client qui parle] ` +
      `Les tarifs de la 2e variante d'une comparaison que le client a DÉJÀ acceptée ` +
      `viennent d'arriver. Envoie MAINTENANT le devis officiel de cette variante : appelle ` +
      `quote.confirm en passant garantiesAdditionnelles correspondant à CETTE variante ` +
      `(l'inverse du 1er devis : si le 1er était sans options, celui-ci est AVEC les options, ` +
      `et vice-versa). Annonce brièvement au client que son second devis arrive. Ne renvoie ` +
      `PAS le menu des tarifs. Si en réalité aucune 2e variante n'a été promise, ` +
      `n'appelle AUCUN outil et réponds EXACTEMENT : ${NO_CONTINUATION}`;
    const { toolsInvoked, sent } = await runContinuationTurn(ctx, {
      leadId: args.leadId,
      customerId: args.customerId,
      prompt,
    });
    const confirmed = toolsInvoked.includes('quote.confirm');
    logger.info(
      { leadId: args.leadId, confirmed, sent },
      'comparison-continuation: preview auto-confirm turn complete',
    );
    return confirmed || sent;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), leadId: args.leadId },
      'comparison-continuation: after-preview continuation failed (non-blocking)',
    );
    return false;
  }
}
