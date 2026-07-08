import { z } from 'zod';
import { registerIntent } from './_registry.js';

const ChannelEnum = z.enum(['whatsapp', 'voice', 'email', 'sms']);

export const CustomerMessageReceivedPayload = registerIntent(
  'CUSTOMER.MESSAGE_RECEIVED',
  z.object({
    customerId: z.string().uuid(),
    channel: ChannelEnum,
    content: z.string(),
    attachments: z.array(
      z.object({
        url: z.string().url(),
        mimeType: z.string().optional(),
      }),
    ),
    occurredAt: z.string().datetime(),
  }),
);

export const CustomerMessageSentPayload = registerIntent(
  'CUSTOMER.MESSAGE_SENT',
  z.object({
    customerId: z.string().uuid(),
    channel: ChannelEnum,
    content: z.string(),
    deliveryReceipt: z.record(z.string(), z.unknown()),
  }),
);

export const CustomerOcrRequestedPayload = registerIntent(
  'CUSTOMER.OCR_REQUESTED',
  z.object({
    customerId: z.string().uuid(),
    imageUrl: z.string().url(),
    hint: z.string().optional(),
  }),
);

export const CustomerOcrReadyPayload = registerIntent(
  'CUSTOMER.OCR_READY',
  z.object({
    customerId: z.string().uuid(),
    fields: z.record(z.string(), z.unknown()),
    confidence: z.number().min(0).max(1),
  }),
);

export const CustomerFollowupDuePayload = registerIntent(
  'CUSTOMER.FOLLOWUP_DUE',
  z.object({
    customerId: z.string().uuid(),
    cascadeName: z.string(),
    stepIndex: z.number().int().min(0),
    // Timed message follow-up (2026-07-08, cascadeName='timed-followup'):
    // the followup tick wakes the sales agent to keep an in-conversation
    // promise (« je vous retrouve dans 10 minutes »). The validator STRIPS
    // unknown keys, so these must live in the schema, not just the emit.
    leadId: z.string().uuid().optional(),
    topic: z.string().optional(),
    dueAt: z.string().datetime().optional(),
  }),
);

export const CustomerChannelSwitchRequestedPayload = registerIntent(
  'CUSTOMER.CHANNEL_SWITCH_REQUESTED',
  z.object({
    customerId: z.string().uuid(),
    fromChannel: ChannelEnum,
    toChannel: ChannelEnum,
    reason: z.string(),
  }),
);
