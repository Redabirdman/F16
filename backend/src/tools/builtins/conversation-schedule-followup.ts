/**
 * Tool: `conversation.schedule_followup` — book a timed MESSAGE follow-up.
 *
 * Live gap (2026-07-08, Achraf test): the customer said « est-ce que vous
 * pouvez me reparler dans 10 mins ? », the agent answered « Je vous retrouve
 * dans 10 minutes » — and nothing ever woke it up. voice.schedule_call covers
 * PHONE callbacks; this is its messaging sibling: the sales agent calls it
 * whenever it commits to resume the CONVERSATION at a specific time.
 *
 * Mechanics mirror the timed call callback: write leads.followup_due_at /
 * followup_state='pending' / followup_topic; the followup tick inside the
 * callback scheduler (src/leads/callback-scheduler.ts) claims the row when
 * due and emits CUSTOMER.FOLLOWUP_DUE (cascadeName 'timed-followup') to the
 * sales agent, which runs a system-initiated turn and messages the customer
 * on their last inbound channel. Restart-proof: a due row is re-found on the
 * next tick.
 *
 * One pending follow-up per lead — a newer booking overwrites the older one
 * (the customer changed their mind about the time).
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { registerTool } from '../registry.js';
import { leads } from '../../db/schema/index.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import { logger } from '../../logger.js';

export const conversationScheduleFollowupToolName = 'conversation.schedule_followup';

/** Guards LLM date mistakes — a follow-up further out belongs to engagement. */
const MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;
/** Below this the promise is "right now" — booking gains nothing. */
const MIN_AHEAD_MS = 60_000;

const inputSchema = z.object({
  customerId: z.string().uuid(),
  leadId: z.string().uuid().optional(),
  /**
   * When to resume, ISO 8601 WITH offset (e.g. "2026-07-08T15:31:00+02:00").
   * Compute from the Date du jour in the context ("dans 10 minutes" → now+10).
   */
  resumeAt: z.string().datetime({ offset: true }),
  /** Short FR note: where the conversation stood / what to resume with. */
  topic: z.string().max(300).optional(),
});

const outputSchema = z.object({
  booked: z.literal(true),
  /** French human-readable resume time to echo to the customer. */
  resumesAt: z.string(),
});

registerTool({
  name: conversationScheduleFollowupToolName,
  description:
    'Programmer une reprise de conversation PAR MESSAGE à une heure précise (ex. client : ' +
    '« reparlez-moi dans 10 minutes », « recontactez-moi à 15h »). resumeAt en ISO 8601 avec ' +
    "fuseau, calculé à partir de la Date du jour du contexte. À l'heure dite le système te " +
    'réveillera automatiquement pour envoyer le message — tu peux donc PROMETTRE au client ' +
    "puisque l'engagement est tenu par le système. OBLIGATOIRE avant toute promesse du type " +
    '« je reviens vers vous dans X minutes ». Pour un APPEL téléphonique, utiliser ' +
    'voice.schedule_call à la place.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const leadId = input.leadId ?? ctx.correlationId ?? null;
    if (!leadId) {
      throw new Error('conversation.schedule_followup: no leadId available to book against');
    }
    const target = new Date(input.resumeAt);
    if (!Number.isFinite(target.getTime())) {
      throw new Error('conversation.schedule_followup: resumeAt invalide');
    }
    const ahead = target.getTime() - Date.now();
    if (ahead > MAX_AHEAD_MS) {
      throw new Error(
        'conversation.schedule_followup: resumeAt est à plus de 7 jours — vérifie la date ' +
          '(utilise la Date du jour du contexte).',
      );
    }
    // Past / near-now booking still fires on the next tick (~30 s) — clamp
    // rather than reject so "dans 1 minute" behaves sanely.
    const due = ahead < MIN_AHEAD_MS ? new Date(Date.now() + MIN_AHEAD_MS) : target;

    await ctx.db
      .update(leads)
      .set({
        followupDueAt: due,
        followupState: 'pending',
        followupTopic: input.topic?.slice(0, 300) ?? null,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId));

    const resumesAt = due.toLocaleString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    });

    logger.info(
      { leadId, dueAt: due.toISOString() },
      'conversation.schedule_followup: follow-up booked — the followup tick will wake the agent',
    );

    // Paper trail — visible in the admin activity feed + lead timeline.
    try {
      await appendAudit(ctx.db, {
        actorType: 'agent',
        actorId: `${ctx.agentRole}#${ctx.agentInstance}`,
        action: 'conversation.followup.booked',
        targetType: 'lead',
        targetId: leadId,
        meta: {
          dueAt: due.toISOString(),
          ...(input.topic ? { topic: input.topic.slice(0, 120) } : {}),
        },
      });
    } catch {
      // non-blocking
    }

    return { booked: true as const, resumesAt };
  },
});
