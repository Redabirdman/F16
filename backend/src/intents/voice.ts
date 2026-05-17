import { z } from 'zod';
import { registerIntent } from './_registry.js';

export const VoiceCallScheduledPayload = registerIntent(
  'VOICE.CALL_SCHEDULED',
  z.object({
    callId: z.string().uuid(),
    customerId: z.string().uuid(),
    toNumber: z.string(),
    scheduledAt: z.string().datetime(),
  }),
);

export const VoiceCallStartedPayload = registerIntent(
  'VOICE.CALL_STARTED',
  z.object({
    callId: z.string().uuid(),
    customerId: z.string().uuid(),
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
