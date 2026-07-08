/**
 * Timed message follow-up self-wake (2026-07-08, Achraf live test).
 *
 * The customer said « pouvez-vous me reparler dans 10 mins ? », the agent
 * promised « Je vous retrouve dans 10 minutes » — and went idle until the
 * customer complained. The conversation.schedule_followup tool now books the
 * promise (leads.followup_*), the followup tick fires CUSTOMER.FOLLOWUP_DUE
 * at the time, and THIS handler runs the system-initiated LLM turn that
 * actually sends the message.
 *
 * Same shape as the comparison-continuation self-wake:
 *   - system prompt marked as internal (not the customer speaking),
 *   - a NO_FOLLOWUP sentinel when resuming no longer makes sense (the
 *     conversation already resumed on its own, the lead closed, …),
 *   - customer channel = last INBOUND channel,
 *   - best-effort: a failure never throws past the envelope handler.
 */
import { listTurns } from '../../../db/repositories/conversation-turns.js';
import { sendViaChannel } from '../../../channels/send.js';
import { preferInboundChannel } from '../../../channels/registry.js';
import { generateSalesReply } from '../reply-core.js';
import { logger } from '../../../logger.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../../messaging/dispatcher.js';
import type { SalesHandlerCtx } from './context.js';

/** Sentinel the LLM returns when the follow-up is moot. */
export const NO_FOLLOWUP = '__NO_FOLLOWUP__';

export async function handleTimedFollowup(
  ctx: SalesHandlerCtx,
  envelope: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  const payload = envelope.payload as {
    customerId: string;
    cascadeName: string;
    leadId?: string;
    topic?: string;
    dueAt?: string;
  };
  // Only the timed-followup cascade is ours; engagement cascades (if they
  // ever route here) are not.
  if (payload.cascadeName !== 'timed-followup') {
    return { ok: true, result: { skipped: 'not-timed-followup', cascade: payload.cascadeName } };
  }
  const leadId = payload.leadId ?? ctx.leadIdFromEnvelope(envelope);
  if (!leadId) {
    return { ok: true, result: { skipped: 'no-lead' } };
  }

  try {
    const recent = await listTurns(ctx.db, {
      customerId: payload.customerId,
      leadId,
      limit: 10,
    });
    const channel = preferInboundChannel(recent);

    const prompt =
      `[RELANCE PROGRAMMÉE — message système interne, ce n'est PAS le client qui parle] ` +
      `Tu avais convenu avec le client de reprendre la conversation maintenant` +
      `${payload.topic ? ` (contexte noté : ${payload.topic})` : ''}. ` +
      `Relis la conversation et reprends-la là où elle s'était arrêtée : un message ` +
      `chaleureux et UNE question ou action concrète pour avancer (pas de résumé, pas ` +
      `d'excuses). Si la conversation a DÉJÀ repris depuis la promesse (vous avez ` +
      `échangé entre-temps et le sujet est traité) ou si une reprise n'a plus aucun ` +
      `sens, n'envoie rien : réponds EXACTEMENT ${NO_FOLLOWUP}`;

    const reply = await generateSalesReply({
      db: ctx.db,
      leadId,
      channel,
      content: prompt,
      agentRole: ctx.role,
      agentInstance: ctx.instanceId,
    });
    if (reply.outcome !== 'reply') {
      return { ok: true, result: { skipped: reply.outcome } };
    }
    if (reply.replyText.trim().toUpperCase().includes(NO_FOLLOWUP)) {
      logger.info({ leadId }, 'timed-followup: LLM judged the follow-up moot — nothing sent');
      return { ok: true, result: { skipped: 'moot' } };
    }
    const { contactRef } = await ctx.resolveCustomerAndContact(leadId, channel);
    if (!contactRef) {
      return { ok: true, result: { skipped: 'no-contact', channel } };
    }
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
    logger.info({ leadId, channel }, 'timed-followup: promised follow-up sent');
    return { ok: true, result: { sent: true, channel } };
  } catch (err) {
    logger.warn(
      { leadId, err: err instanceof Error ? err.message : String(err) },
      'timed-followup: failed (non-blocking)',
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
