/**
 * Tool: `voice.schedule_call` — schedule an outbound voice call.
 *
 * The Sales Agent calls this when a customer asks to be phoned ("vous pouvez
 * m'appeler ?", "rappelez-moi"). It emits VOICE.CALL_SCHEDULED → the
 * voice-operator picks it up off the `voice` queue and originates the call via
 * the OpenAI native-SIP bridge. The voice-operator re-resolves the customer's
 * verified DB phone, so the toNumber here is only a hint.
 *
 * Returns `{ callId, queued: true }` so the agent can tell the customer
 * "c'est noté, on vous rappelle" and keep the thread alive.
 *
 * PII: customerId/leadId are UUIDs; the resolved phone is never logged.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { registerTool } from '../registry.js';
import { getCustomerById } from '../../db/repositories/customers.js';
import { sendMessage } from '../../messaging/dispatcher.js';

export const voiceScheduleCallToolName = 'voice.schedule_call';

const inputSchema = z.object({
  customerId: z.string().uuid(),
  leadId: z.string().uuid().optional(),
  /** Short FR reason surfaced in the audit/voice context (optional). */
  reason: z.string().optional(),
});

const outputSchema = z.object({
  callId: z.string().uuid(),
  queued: z.literal(true),
});

registerTool({
  name: voiceScheduleCallToolName,
  description:
    "Programmer un appel téléphonique sortant vers le client (par ex. quand il demande à être rappelé). L'appel est passé en arrière-plan par le système ; dis simplement au client qu'on va le rappeler.",
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const customer = await getCustomerById(ctx.db, input.customerId);
    if (!customer) throw new Error('voice.schedule_call: customer not found');

    const callId = randomUUID();
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
          toNumber: customer.phone ?? '',
          scheduledAt: new Date().toISOString(),
        },
        ...((input.leadId ?? ctx.correlationId)
          ? { correlationId: input.leadId ?? ctx.correlationId }
          : {}),
      },
    );

    return { callId, queued: true as const };
  },
});
