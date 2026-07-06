import { z } from 'zod';
import { registerIntent } from './_registry.js';

const ChannelEnum = z.enum(['whatsapp', 'voice', 'email', 'sms']);

const FormuleEnum = z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']);

/**
 * Garanties additionnelles the customer wants on the devis (2026-07-02,
 * Achraf's pack: Tiers Illimité + Assistance Mobilité + Garantie Personnelle
 * du Conducteur). Ticked on the Maxance Garanties tab by quote.confirm.
 */
const GarantiesAdditionnellesSchema = z.object({
  assistance: z.boolean().optional(),
  garantiePersonnelle: z.boolean().optional(),
});

/**
 * Per-formule pricing extracted by the extension (2026-07-02, Achraf's sales
 * method): `annualPremiumEur` = the formules-table Montant (ANNUAL premium),
 * `termeSuivantEur` = the customer-facing MONTHLY payment, `comptantEur` =
 * the first payment, `coutAnnuelBrutEur` = total annual cost with fees.
 */
const FormulePricingSchema = z.object({
  formule: FormuleEnum,
  annualPremiumEur: z.number().nonnegative().optional(),
  comptantEur: z.number().nonnegative().optional(),
  termeSuivantEur: z.number().nonnegative().optional(),
  coutAnnuelBrutEur: z.number().nonnegative().optional(),
});

/** Garanties-additionnelles ANNUAL prices read off the Garanties tab. */
const AddOnPricingSchema = z.object({
  assistanceAnnualEur: z.number().nonnegative().optional(),
  garantiePersonnelleAnnualEur: z.number().nonnegative().optional(),
});

export const QuoteRequestedPayload = registerIntent(
  'QUOTE.REQUESTED',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    leadId: z.string().uuid(),
    product: z.enum(['scooter', 'car']),
    productVariant: z.string(),
    formData: z.record(z.string(), z.unknown()),
    /**
     * 2026-07-06 maintenance self-heal: how many times the maxance-operator
     * re-parked THIS job because Maxance showed its maintenance page
     * (`maxance_maintenance`). Incremented on each maintenance defer; past 4
     * the job falls through to the normal QUOTE.FAILED path. ⚠️ Registry
     * validator STRIPS unknown keys — schema + the operator's
     * deferForMaintenance emitter/reader must change together.
     */
    deferCount: z.number().int().min(0).optional(),
  }),
);

export const QuoteReadyPayload = registerIntent(
  'QUOTE.READY',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    /** 2026-07-02: explicit lead — the sales-agent SINGLETON has no per-lead
     *  meta and the envelope correlationId is the quoteId. */
    leadId: z.string().uuid().optional(),
    monthlyPremium: z.number().nonnegative(),
    comptantDue: z.number().nonnegative(),
    devisNumber: z.string(),
    /**
     * Email address Maxance sent the quote PDF to (it dispatches the email
     * directly — we don't get a downloadable URL). Echoed back so the Sales
     * Agent can confirm to the customer "envoyé à xxx@yyy.com".
     */
    pdfSentTo: z.string().email(),
  }),
);

/**
 * QUOTE.CONFIRM_REQUESTED — the customer said YES to a previewed quote.
 * The Sales Agent emits this when its LLM (or simple regex) detects an
 * affirmative reply to the PREVIEW_READY message. The Maxance Operator
 * (M8.T4) handles it: drives Valider devis → Devis tab fill → email send,
 * then emits QUOTE.READY with the devisNumber + pdfSentTo.
 *
 * Carries the subscriber info Maxance needs on the Devis tab. The Sales
 * Agent assembles this from the customer + lead row before emitting; if a
 * required field is missing the agent asks the customer for it instead.
 */
export const QuoteConfirmRequestedPayload = registerIntent(
  'QUOTE.CONFIRM_REQUESTED',
  z.object({
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    leadId: z.string().uuid(),
    subscriber: z.object({
      civilite: z.enum(['monsieur', 'madame']),
      lastName: z.string().min(1),
      firstName: z.string().min(1),
      addressLine: z.string().min(1),
      addressComplement: z.string().optional(),
      postalCode: z.string().min(1),
      city: z.string().min(1),
      phoneMobile: z.string().min(1),
      email: z.string().email(),
      profession: z
        .enum(['employe_prive', 'employe_public', 'etudiant', 'retraite', 'sans_profession'])
        .optional(),
    }),
    /**
     * 2026-07-02 (Achraf's pack): tick these add-on checkboxes on the
     * Garanties tab before Valider devis. ⚠️ Registry validator STRIPS
     * unknown keys — schema + emit + read must change together.
     */
    garantiesAdditionnelles: GarantiesAdditionnellesSchema.optional(),
    /**
     * 2026-07-06 maintenance self-heal: maintenance re-park counter — same
     * semantics as QUOTE.REQUESTED.deferCount (bounded at 4). ⚠️ Registry
     * validator STRIPS unknown keys — schema + the operator's
     * deferForMaintenance emitter/reader must change together.
     */
    deferCount: z.number().int().min(0).optional(),
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
    /** 2026-07-02: explicit lead — the sales-agent SINGLETON has no per-lead
     *  meta and the envelope correlationId is the quoteId. */
    leadId: z.string().uuid().optional(),
    /**
     * Pricing in EUR. At least one of monthly/annual is set; both may be set.
     * ⚠️ 2026-07-02 semantics fix (Achraf): `monthly` = the Garanties tab's
     * "Terme suivant" (the true monthly payment, e.g. 6.51), NOT the
     * formules-table Montant (which is the ANNUAL premium, e.g. 66.20 — old
     * builds sent that as "Mensuel"). `annual` = coût annuel brut.
     */
    pricePreviewEur: z.object({
      monthly: z.number().nonnegative().optional(),
      annual: z.number().nonnegative().optional(),
    }),
    /** Which formule the price applies to — defaults to Tiers Illimité if unset. */
    formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
    /**
     * 2026-07-02 (Achraf's sales script): monthly pricing for ALL formules +
     * the two garanties-additionnelles annual prices, so the sales-agent can
     * present the full menu + pack recommendation. ⚠️ Registry validator
     * STRIPS unknown keys — schema + emit + read must change together.
     */
    formulePricing: z.array(FormulePricingSchema).optional(),
    addOns: AddOnPricingSchema.optional(),
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
    /**
     * 2026-07-02: carried explicitly because the sales-agent is a SINGLETON
     * (no per-lead meta) and the envelope correlationId is the quoteId — the
     * handler needs the real lead to notify the customer of the failure.
     */
    leadId: z.string().uuid().optional(),
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

/**
 * DEVIS.PDF_RECEIVED — emitted by the devis-inbox watcher (2026-07-02
 * inbox-relay delivery) when Maxance's devis email lands in the Assuryal
 * Workspace inbox. The Sales Agent handles it: looks the quote up by
 * devisNumber and re-delivers the PDF to the customer via WhatsApp + a
 * branded Assuryal email. pdfPath is a local absolute path under
 * backend/var/devis/ (this PC is prod — single-process, shared disk).
 */
export const DevisPdfReceivedPayload = registerIntent(
  'DEVIS.PDF_RECEIVED',
  z.object({
    devisNumber: z.string().min(3),
    pdfPath: z.string().min(1),
    filename: z.string().min(1),
    /** Sender address of the inbound email — audit only. */
    from: z.string().optional(),
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
