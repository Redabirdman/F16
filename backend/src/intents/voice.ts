import { z } from 'zod';
import { registerIntent } from './_registry.js';

export const VoiceCallScheduledPayload = registerIntent(
  'VOICE.CALL_SCHEDULED',
  z.object({
    callId: z.string().uuid(),
    customerId: z.string().uuid(),
    toNumber: z.string(),
    scheduledAt: z.string().datetime(),
    // 2026-07-08: toNumber is a CUSTOMER-PROVIDED alternative — the
    // voice-operator must dial IT and not re-resolve the profile phone.
    altNumber: z.boolean().optional(),
  }),
);

export const VoiceCallStartedPayload = registerIntent(
  'VOICE.CALL_STARTED',
  z.object({
    callId: z.string().uuid(),
    customerId: z.string().uuid(),
    // Asterisk ARI channel id of the originated call. Optional for back-compat
    // with any emitter that doesn't have it; the Asterisk voice-operator sets it.
    channelId: z.string().optional(),
  }),
);

export const VoiceCallCompletedPayload = registerIntent(
  'VOICE.CALL_COMPLETED',
  z.object({
    callId: z.string().uuid(),
    durationSec: z.number().int().nonnegative(),
    transcriptUrl: z.string().url().optional(),
  }),
);

export const VoiceCallFailedPayload = registerIntent(
  'VOICE.CALL_FAILED',
  z.object({
    callId: z.string().uuid(),
    reason: z.string(),
  }),
);
