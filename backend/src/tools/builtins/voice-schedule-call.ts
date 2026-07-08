/**
 * Tool: `voice.schedule_call` — schedule an outbound voice call, NOW or at a
 * customer-chosen time.
 *
 * The Sales Agent calls this when a customer asks to be phoned ("vous pouvez
 * m'appeler ?", "rappelez-moi demain à 10h").
 *
 *   - No `scheduledAt` (or a past/near time) → emits VOICE.CALL_SCHEDULED
 *     immediately; the voice-operator dials via the OpenAI native-SIP bridge.
 *   - Future `scheduledAt` → writes the lead's callback_due_at/'pending' and
 *     the M12 callback scheduler dials AT that time (restart-proof: a due row
 *     is simply re-found on the next tick). Live 2026-07-07: Khalid said
 *     "à partir de 19h" and the tool had no time concept — it could only
 *     dial immediately.
 *
 * Both paths leave a paper trail: an audit row (admin audit log) + a
 * best-effort HubSpot note (contact/deal timeline) so the commitment is
 * visible to management. Completed calls already land in HubSpot separately
 * as call engagements (voice-call-ended → CallSpec).
 *
 * PII: customerId/leadId are UUIDs; the resolved phone is never logged.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { registerTool } from '../registry.js';
import { getCustomerById } from '../../db/repositories/customers.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { leads } from '../../db/schema/index.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import { emitHubSpotActivity } from '../../integrations/hubspot/activity-worker.js';
import { logger } from '../../logger.js';

export const voiceScheduleCallToolName = 'voice.schedule_call';

/** Furthest ahead a customer can book a callback (guards LLM date mistakes). */
const MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;
/** Anything due within this window just dials now (scheduler tick is 60s). */
const IMMEDIATE_WINDOW_MS = 2 * 60_000;

const inputSchema = z.object({
  customerId: z.string().uuid(),
  leadId: z.string().uuid().optional(),
  /** Short FR reason surfaced in the audit/voice context (optional). */
  reason: z.string().optional(),
  /**
   * When the customer wants the call, ISO 8601 WITH offset (e.g.
   * "2026-07-08T19:00:00+02:00"). Omit for "call now".
   */
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  /**
   * A DIFFERENT number the customer explicitly gave for this call (live
   * 2026-07-08: « voilà mon numéro … » — the profile number belonged to
   * their kid). Accepts 06/07…, +33…, 00… formats; normalized to E.164.
   * Omit to call the profile number.
   */
  phoneNumber: z.string().min(6).max(24).optional(),
});

/**
 * Normalize a customer-typed phone number to E.164 for the SIP dialer.
 * Returns null when the input can't be a dialable number.
 */
export function normalizeDialNumber(raw: string): string | null {
  const digits = raw.replace(/[\s.\-()]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return `+33${digits.slice(1)}`;
  if (/^00\d{8,14}$/.test(digits)) return `+${digits.slice(2)}`;
  return null;
}

const outputSchema = z.object({
  callId: z.string().uuid(),
  queued: z.literal(true),
  /** Set when the call was booked for later — French human-readable time. */
  scheduledFor: z.string().optional(),
});

registerTool({
  name: voiceScheduleCallToolName,
  description:
    'Programmer un appel téléphonique sortant vers le client. Sans scheduledAt : appel ' +
    'IMMÉDIAT. Avec scheduledAt (ISO 8601 avec fuseau, ex. "2026-07-08T19:00:00+02:00") : ' +
    "l'appel partira À CE MOMENT-LÀ — calcule à partir de la Date du jour du contexte " +
    '(ex. "demain à partir de 19h" → demain 19:00 heure française). Si le créneau demandé ' +
    "est déjà atteignable aujourd'hui (il est 19h20 et le client dit «à partir de 19h»), " +
    'appelle MAINTENANT (omets scheduledAt). ⚠️ Si le client donne un AUTRE numéro pour ' +
    "l'appel (« appelez-moi plutôt sur … »), passe-le dans phoneNumber — sinon l'appel part " +
    "sur le numéro de la fiche. Dis au client qu'on l'appelle (maintenant ou au créneau " +
    'convenu — le résultat contient scheduledFor quand il est programmé).',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const customer = await getCustomerById(ctx.db, input.customerId);
    if (!customer) throw new Error('voice.schedule_call: customer not found');

    // Customer-provided alternative number (never logged raw — PII).
    const overrideNumber = input.phoneNumber ? normalizeDialNumber(input.phoneNumber) : null;
    if (input.phoneNumber && !overrideNumber) {
      throw new Error(
        'voice.schedule_call: le numéro fourni est invalide — redemande-le au client ' +
          '(format 06/07 xx xx xx xx ou +33...).',
      );
    }

    const callId = randomUUID();
    const leadId = input.leadId ?? ctx.correlationId ?? null;
    const now = Date.now();
    const target = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const wantsLater =
      target !== null &&
      Number.isFinite(target.getTime()) &&
      target.getTime() - now > IMMEDIATE_WINDOW_MS;

    if (wantsLater && target.getTime() - now > MAX_AHEAD_MS) {
      throw new Error(
        'voice.schedule_call: scheduledAt est à plus de 7 jours — vérifie la date ' +
          '(utilise la Date du jour du contexte) ou propose un créneau plus proche.',
      );
    }

    const scheduledForFr =
      wantsLater && target
        ? target.toLocaleString('fr-FR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Paris',
          })
        : null;

    if (wantsLater && target && leadId && !overrideNumber) {
      // Timed callback: hand off to the M12 callback scheduler (single
      // idempotent dial path, survives restarts). It claims the row when
      // callback_due_at arrives and emits VOICE.CALL_SCHEDULED itself.
      // (The scheduler dials the PROFILE phone — an override number can't
      // ride this path, see the delayed-emit branch below.)
      await ctx.db
        .update(leads)
        .set({ callbackDueAt: target, callbackState: 'pending' })
        .where(eq(leads.id, leadId));
      logger.info(
        { leadId, callId, dueAt: target.toISOString() },
        'voice.schedule_call: callback booked — the callback scheduler will dial at the time',
      );
    } else if (wantsLater && target && overrideNumber) {
      // Timed callback on a customer-provided number: the callback scheduler
      // only knows the profile phone, so park a delayed VOICE.CALL_SCHEDULED
      // carrying the override directly (BullMQ delayed job — survives
      // restarts via Redis persistence).
      await sendMessage(
        { db: ctx.db },
        {
          fromRole: ctx.agentRole,
          fromInstance: ctx.agentInstance,
          toRole: 'voice-operator',
          intent: 'VOICE.CALL_SCHEDULED',
          payload: {
            callId,
            customerId: input.customerId,
            toNumber: overrideNumber,
            scheduledAt: target.toISOString(),
          },
          ...(leadId ? { correlationId: leadId } : {}),
          delayMs: target.getTime() - now,
        },
      );
      logger.info(
        { leadId, callId, dueAt: target.toISOString(), altNumber: true },
        'voice.schedule_call: timed call parked on the customer-provided number',
      );
    } else {
      // Call now (also the fallback when no leadId exists to hang the timed
      // callback on — better an early call than none).
      await sendMessage(
        { db: ctx.db },
        {
          fromRole: ctx.agentRole,
          fromInstance: ctx.agentInstance,
          toRole: 'voice-operator',
          intent: 'VOICE.CALL_SCHEDULED',
          payload: {
            callId,
            customerId: input.customerId,
            toNumber: overrideNumber ?? customer.phone ?? '',
            scheduledAt: new Date().toISOString(),
          },
          ...(leadId ? { correlationId: leadId } : {}),
        },
      );
    }

    // Paper trail — audit row (admin audit log) + HubSpot note on the
    // contact/deal timeline. Both best-effort, never block the booking.
    try {
      await appendAudit(ctx.db, {
        actorType: 'agent',
        actorId: `${ctx.agentRole}#${ctx.agentInstance}`,
        action: wantsLater ? 'voice.callback.booked' : 'voice.call.requested',
        targetType: 'lead',
        targetId: leadId ?? input.customerId,
        meta: {
          callId,
          ...(wantsLater && target ? { dueAt: target.toISOString() } : {}),
          ...(input.reason ? { reason: input.reason.slice(0, 120) } : {}),
          // Flag only — the raw number never lands in the audit trail (PII).
          ...(overrideNumber ? { altNumber: true } : {}),
        },
      });
    } catch {
      // non-blocking
    }
    try {
      await emitHubSpotActivity(ctx.db, {
        customerId: input.customerId,
        ...(leadId ? { leadId } : {}),
        activity: {
          kind: 'callback-booked',
          customerId: input.customerId,
          ...(leadId ? { leadId } : {}),
          body: scheduledForFr
            ? `📞 Rappel téléphonique programmé (demande client) : ${scheduledForFr}.`
            : `📞 Appel sortant lancé à la demande du client.`,
          timestamp: new Date(),
        },
      });
    } catch {
      // best-effort
    }

    return {
      callId,
      queued: true as const,
      ...(scheduledForFr ? { scheduledFor: scheduledForFr } : {}),
    };
  },
});
