import { z } from 'zod';
import { registerIntent } from './_registry.js';

const ChannelEnum = z.enum(['whatsapp', 'voice', 'email', 'sms']);

export const QuoteRequestedPayload = registerIntent(
  'QUOTE.REQUESTED',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    leadId: z.string().uuid(),
    product: z.enum(['scooter', 'car']),
    productVariant: z.string(),
    formData: z.record(z.string(), z.unknown()),
  }),
);

export const QuoteReadyPayload = registerIntent(
  'QUOTE.READY',
  z.object({
    quoteId: z.string().uuid(),
    monthlyPremium: z.number().nonnegative(),
    comptantDue: z.number().nonnegative(),
    devisNumber: z.string(),
    pdfUrl: z.string().url(),
  }),
);

export const QuoteDeliveredPayload = registerIntent(
  'QUOTE.DELIVERED',
  z.object({
    quoteId: z.string().uuid(),
    channel: ChannelEnum,
  }),
);

export const QuoteAcceptedPayload = registerIntent(
  'QUOTE.ACCEPTED',
  z.object({
    quoteId: z.string().uuid(),
  }),
);

export const QuoteRejectedPayload = registerIntent(
  'QUOTE.REJECTED',
  z.object({
    quoteId: z.string().uuid(),
    reason: z.string().optional(),
  }),
);

export const PaymentPendingHumanPayload = registerIntent(
  'PAYMENT.PENDING_HUMAN',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
  }),
);

export const ContractPendingHumanPayload = registerIntent(
  'CONTRACT.PENDING_HUMAN',
  z.object({
    quoteId: z.string().uuid(),
  }),
);

export const ContractIssuedPayload = registerIntent(
  'CONTRACT.ISSUED',
  z.object({
    quoteId: z.string().uuid(),
    contractNumber: z.string(),
  }),
);
