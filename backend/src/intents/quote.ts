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

/**
 * QUOTE.PREVIEW_READY — emitted by the Maxance Operator (M8.T4) after a
 * dryRun quote successfully extracts the price preview from the Garanties
 * tab. No real record was created in Maxance; no devisNumber and no PDF
 * exist yet. The Sales Agent uses this to reply to the customer with the
 * headline numbers and ask "shall I lock it in?". On YES it fires the full
 * QUOTE.READY path (M8.T6).
 *
 * Distinct from QUOTE.READY because the schema requirements differ:
 * QUOTE.READY means "quote saved in Maxance with PDF + devisNumber".
 * Mixing the two would force nullable devisNumber/pdfUrl on QUOTE.READY
 * and downstream consumers would have to handle the null. Cleaner to keep
 * two intents.
 */
export const QuotePreviewReadyPayload = registerIntent(
  'QUOTE.PREVIEW_READY',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    /** Pricing in EUR. At least one of monthly/annual is set; both may be set. */
    pricePreviewEur: z.object({
      monthly: z.number().nonnegative().optional(),
      annual: z.number().nonnegative().optional(),
    }),
    /** Which formule the price applies to — defaults to Tiers Illimité if unset. */
    formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
    /** Stagehand session URL at the moment of preview — useful for the operator UI. */
    finalUrl: z.string(),
    /** Captured screenshots, in flow order. Each URL is served by Stagehand's /v1/static. */
    screenshots: z
      .array(
        z.object({
          step: z.string(),
          url: z.string(),
        }),
      )
      .default([]),
    /** Wall-clock duration of the quote-flow run, milliseconds. Audit only. */
    durationMs: z.number().int().nonnegative(),
  }),
);

/**
 * QUOTE.FAILED — emitted by the Maxance Operator when a dryRun run fails
 * for any reason (network, Maxance UI drift, Cloudflare block, missing
 * session). Distinguishes from QUOTE.REJECTED (customer turned the quote
 * down) — this one is a flow-internal failure that the Service Agent /
 * Sales Agent should NOT propagate verbatim to the customer.
 */
export const QuoteFailedPayload = registerIntent(
  'QUOTE.FAILED',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    /** Tagged failure code from quote.ts (e.g. `maxance_quote_unexpected_entry_page:unknown`). */
    errorCode: z.string(),
    /** Optional human-readable hint for the operator UI. Never echo to customer. */
    detail: z.string().optional(),
    /** Captured screenshots up to the failure point, for diagnosis. */
    screenshots: z
      .array(
        z.object({
          step: z.string(),
          url: z.string(),
        }),
      )
      .default([]),
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
