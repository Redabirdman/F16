/**
 * SUBSCRIPTION.* intents — the M8.T7 Maxance closing lifecycle (design §5.1).
 *
 * Flow: the Sales Agent emits SUBSCRIPTION.REQUESTED once the customer has
 * accepted a quote and provided their bank details; the Maxance Operator
 * resumes the devis, completes the souscription up to the Paiement page and
 * answers with SUBSCRIPTION.READY (or SUBSCRIPTION.FAILED). The inspector
 * handoff + contract issuance reuse the already-registered CONTRACT.* intents.
 *
 * PII discipline: IBAN/BIC/titulaire are NEVER carried in intent payloads —
 * they are persisted encrypted on the customer row (repositories/customers.ts,
 * saveCustomerBankDetails) and the operator reads them from the DB at drive
 * time. `bankRef: 'customer'` documents that contract explicitly so a future
 * emitter cannot "helpfully" inline the IBAN without a schema change.
 */
import { z } from 'zod';
import { registerIntent } from './_registry.js';

const FormuleEnum = z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']);
const FractionnementEnum = z.enum(['mensuel', 'annuel']);

/** Same screenshot shape as the QUOTE.* intents (Stagehand /v1/static URLs). */
const ScreenshotList = z
  .array(
    z.object({
      step: z.string(),
      url: z.string(),
    }),
  )
  .default([]);

/**
 * SUBSCRIPTION.REQUESTED — Sales Agent → Maxance Operator. Customer accepted
 * the quote and the closing data is complete (bank details already persisted
 * encrypted on the customer; birthPlaceCity collected conversationally —
 * "Paris" fallback for foreign birthplaces happens upstream).
 */
export const SubscriptionRequestedPayload = registerIntent(
  'SUBSCRIPTION.REQUESTED',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    leadId: z.string().uuid().nullish(),
    /** Maxance devis reference to resume (e.g. "DR0000971882"). */
    devisNumber: z.string().min(1),
    formule: FormuleEnum,
    fractionnement: FractionnementEnum,
    /** Lieu de naissance — Ville. */
    birthPlaceCity: z.string().min(1),
    /**
     * Bank details are NOT in this payload — the operator decrypts them from
     * the customer row. The literal makes that indirection explicit.
     */
    bankRef: z.literal('customer'),
  }),
);

/**
 * SUBSCRIPTION.READY — Maxance Operator → Sales Agent. The souscription ran
 * to its stop point: the Paiement page in real mode, or the pre-Valider gate
 * when dryRun. The Sales Agent turns this into the customer-facing message
 * (figures + payment link).
 */
export const SubscriptionReadyPayload = registerIntent(
  'SUBSCRIPTION.READY',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    /** Maxance souscripteur/instance ref from the Paiement page. Absent on dryRun. */
    souscripteurRef: z.string().optional(),
    /** "Comptant dû" read from the portal, €. Absent when extraction failed. */
    montantComptantEur: z.number().nonnegative().optional(),
    /** Maxance's own "frais de dossier" portion of the comptant, €. */
    fraisComptantEur: z.number().nonnegative().optional(),
    /** Assuryal total frais de dossier for the formule (50/60/65 €). */
    fraisDossierTotalEur: z.number().nonnegative(),
    /** What the customer owes Assuryal = total − frais comptant, floored at 0. */
    assuryalFraisEur: z.number().nonnegative(),
    /** Stripe payment link; null when Stripe is unconfigured (human fallback). */
    paymentLinkUrl: z.string().url().nullable(),
    dryRun: z.boolean(),
  }),
);

/**
 * SUBSCRIPTION.FAILED — Maxance Operator → Sales Agent. Flow-internal failure
 * (UI drift, wrong state, duplicate contact, …). Never echoed verbatim to the
 * customer — same contract as QUOTE.FAILED.
 */
export const SubscriptionFailedPayload = registerIntent(
  'SUBSCRIPTION.FAILED',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    /** Tagged failure code (e.g. `maxance_subscription_wrong_state`). */
    errorCode: z.string().min(1),
    /** Optional human-readable hint for the operator UI. Never echo to customer. */
    detail: z.string().optional(),
    /** Captured screenshots up to the failure point, for diagnosis. */
    screenshots: ScreenshotList.optional(),
  }),
);
