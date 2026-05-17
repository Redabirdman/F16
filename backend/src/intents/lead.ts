import { z } from 'zod';
import { registerIntent } from './_registry.js';

export const LeadNewPayload = registerIntent(
  'LEAD.NEW',
  z.object({
    leadId: z.string().uuid(),
    source: z.enum(['website', 'meta', 'organic', 'referral', 'other']),
    sourceId: z.string().optional(),
    productLine: z.enum(['scooter', 'car']),
    raw: z.record(z.string(), z.unknown()).optional(),
  }),
);

export const LeadProfileUpdatedPayload = registerIntent(
  'LEAD.PROFILE_UPDATED',
  z.object({
    leadId: z.string().uuid(),
    fields: z.array(z.string()),
  }),
);

export const LeadScoredPayload = registerIntent(
  'LEAD.SCORED',
  z.object({
    leadId: z.string().uuid(),
    score: z.number().min(0).max(100),
    opening: z.string(),
    channel: z.enum(['whatsapp', 'voice', 'email', 'sms']),
  }),
);

export const LeadStatusChangedPayload = registerIntent(
  'LEAD.STATUS_CHANGED',
  z.object({
    leadId: z.string().uuid(),
    from: z.string(),
    to: z.string(),
  }),
);
