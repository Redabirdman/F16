import { z } from 'zod';
import { registerIntent } from './_registry.js';

const ChannelEnum = z.enum(['whatsapp', 'voice', 'email', 'sms']);

export const ComplianceCheckRequestedPayload = registerIntent(
  'COMPLIANCE.CHECK_REQUESTED',
  z.object({
    messageId: z.string().uuid(),
    customerId: z.string().uuid(),
    draftContent: z.string(),
    channel: ChannelEnum,
  }),
);

export const CompliancePassedPayload = registerIntent(
  'COMPLIANCE.PASSED',
  z.object({
    messageId: z.string().uuid(),
  }),
);

export const ComplianceBlockedPayload = registerIntent(
  'COMPLIANCE.BLOCKED',
  z.object({
    messageId: z.string().uuid(),
    reasons: z.array(z.string()),
  }),
);
