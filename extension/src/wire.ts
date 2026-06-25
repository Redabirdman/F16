/**
 * Wire schemas for backend ↔ extension communication (M8.T8 phase 2).
 *
 * Transport: WebSocket. The extension service worker (`background.ts`) opens
 * an outbound WS to `ws://127.0.0.1:9223` (backend's `extension-client.ts`,
 * landing in phase 2c). Both directions exchange Zod-validated JSON messages
 * — schemas defined here are the single source of truth.
 *
 * Conventions:
 *   - Every envelope carries `id` (uuid) + `kind` (discriminator).
 *   - Commands FLOW backend → extension: `quote.preview`, `quote.confirm`,
 *     `login.ensure`, `ping`. Each command has a paired response with the
 *     same `id`.
 *   - Status events flow extension → backend: `ready`, `quote.progress`,
 *     `error`. These are not paired with a request id (they're spontaneous).
 *
 * Mirrors the in-process Maxance param types declared in
 * `./maxance/selectors.ts` where possible — same field names + value enums.
 * Where the wire side needs JSON-safe representations (no `Date`), we use
 * ISO strings.
 */
import { z } from 'zod';

/** Maxance quote-flow params over the wire. JSON-safe (dates as ISO strings). */
export const QuoteParamsSchema = z.object({
  vehicleKind: z.literal('trottinette'),
  purchasePriceEur: z.number().positive(),
  /** ISO date string e.g. "2026-01-15". */
  purchaseDate: z.string(),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().optional(),
  stationnement: z.enum(['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue']),
  /** ISO date string e.g. "1990-06-12". */
  clientDateOfBirth: z.string(),
  formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
  commissionPct: z.number().min(0).max(100).optional(),
  fractionnement: z.enum(['mensuel', 'annuel']).optional(),
});
export type QuoteParams = z.infer<typeof QuoteParamsSchema>;

/** Subscriber info for the Devis tab. JSON-safe. */
export const SubscriberInfoSchema = z.object({
  civilite: z.enum(['monsieur', 'madame']),
  lastName: z.string().min(1),
  firstName: z.string().min(1),
  addressLine: z.string().min(1),
  addressComplement: z.string().optional(),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().min(1),
  phoneMobile: z.string().min(1),
  email: z.string().email(),
  profession: z
    .enum(['employe_prive', 'employe_public', 'etudiant', 'retraite', 'sans_profession'])
    .optional(),
});
export type SubscriberInfo = z.infer<typeof SubscriberInfoSchema>;

/**
 * Comptant breakdown read from the Garanties tab AFTER the closing
 * controls (formule / commission 22 / fractionnement) are applied
 * (M8.T7 B1). Sources, live-verified 2026-06-11:
 *   - fractionnement: the `mouvement.codeFractionnement` select value
 *     (M/S/A → mensuel/semestriel/annuel).
 *   - comptant / terme suivant / coût annuel brut: the three decimal
 *     numbers after the "Mensuel Semestriel Annuel" words in the
 *     fractionnement table's body text.
 *   - fraisComptantEur: "NN.NN (Frais comptant)" inside the hidden
 *     `commptant_<code>` popup div; null when the popup/line is absent.
 */
export const ComptantBreakdownSchema = z.object({
  fractionnement: z.enum(['mensuel', 'semestriel', 'annuel']).optional(),
  comptantEur: z.number().nonnegative().optional(),
  termeSuivantEur: z.number().nonnegative().optional(),
  coutAnnuelBrutEur: z.number().nonnegative().optional(),
  fraisComptantEur: z.number().nonnegative().nullable(),
});
export type ComptantBreakdown = z.infer<typeof ComptantBreakdownSchema>;

/**
 * Subscription "Comptant à régler" breakdown (M8.T7 B3) parsed off the
 * Coordonnées + bancaires page body text:
 *   "Frais de gestion X € Commission Y € Frais de dossier Z € Comptant dû W €"
 * All fields optional/nullable — best-effort parse; null when the line is
 * absent. Distinct from `ComptantBreakdown` (which is the Garanties-tab
 * fractionnement row, not the bancaires page).
 */
export const SubscriptionComptantSchema = z.object({
  fraisGestionEur: z.number().nonnegative().nullable(),
  commissionEur: z.number().nonnegative().nullable(),
  fraisDossierEur: z.number().nonnegative().nullable(),
  comptantDuEur: z.number().nonnegative().nullable(),
});
export type SubscriptionComptant = z.infer<typeof SubscriptionComptantSchema>;

/** One screenshot result reported back to the backend (data URL). */
export const ScreenshotSchema = z.object({
  step: z.string(),
  /** Base64 PNG data URL — the extension captures via chrome.tabs.captureVisibleTab. */
  dataUrl: z.string().startsWith('data:image/png;base64,'),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Backend → extension commands                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export const PingCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('ping'),
  /** Optional payload echoed back in the pong, useful for round-trip tests. */
  nonce: z.string().optional(),
});

export const LoginEnsureCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('login.ensure'),
  /** Wall-clock budget for the warm-path check. Default 60s on the server. */
  timeoutMs: z.number().int().positive().optional(),
});

export const QuotePreviewCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.preview'),
  params: QuoteParamsSchema,
  /** Always true in V1 — the prod flow stops at the price preview. */
  dryRun: z.literal(true),
  timeoutMs: z.number().int().positive().optional(),
});

export const QuoteConfirmCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.confirm'),
  subscriber: SubscriberInfoSchema,
  /** True = stop before final Envoyer click. False = send the real email. */
  dryRun: z.boolean(),
  /**
   * Phase-2g diagnostic opt-in. When dryRun=true AND this is true, the flow
   * also exercises the Courrier popup (open + dump + best-effort fill) and
   * STOPS before Envoyer — for verifying/mapping the popup without sending.
   * Default/absent = skip the popup in dryRun (fast "devis created" path).
   * The Courrier composer is a multi-stage Struts frameset still being
   * reverse-engineered, so it's off by default to keep normal dryRun fast.
   */
  exerciseCourrier: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * M8.T7 B2 — resume an existing devis (reprise). Searches the devis by
 * number via the ACCES PORTEFEUILLE bar, opens the dossier, calls the
 * reprise action, advances the resumed VÉHICULE → CONDUCTEUR Suivants to
 * Garanties, applies the closing controls (commission ALWAYS re-forced to
 * 22 — it RESETS to 9.0 on every reprise), and extracts the comptant
 * breakdown. Leaves the tab on Garanties (ready for the B3 subscription
 * flow) — the SW does NOT reset on success.
 */
export const DevisResumeCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('devis.resume'),
  /** Maxance devis number, e.g. "DR0000976146". */
  devisNumber: z.string().min(3),
  /** Coverage tier to (re-)select on Garanties. Absent = leave as resumed. */
  formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
  /** Commission % override. Absent = forced to 22 (Achraf's rule). */
  commissionPct: z.number().min(0).max(100).optional(),
  /** Payment cadence to (re-)select. Absent = leave as resumed. */
  fractionnement: z.enum(['mensuel', 'annuel']).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/** Bank-coordinates payload for the souscription bancaires page. */
export const BankInfoSchema = z.object({
  /** Full FR IBAN (spaces tolerated; the extension strips + segments it). */
  iban: z.string().min(15),
  /** BIC — must correspond to the IBAN's bank (no auto-fill). */
  bic: z.string().min(8).max(11),
  /** Titulaire du compte (account holder). */
  accountHolder: z.string().min(1),
});
export type BankInfo = z.infer<typeof BankInfoSchema>;

/**
 * M8.T7 B3 — complete the souscription on a devis already resumed to its
 * Garanties tab (devis.resume left it there). Drives Valider souscription →
 * Infos complémentaires → Coordonnées + bancaires → Paiement page STOP. The
 * destructive gate is the **Valider souscription** click — `dryRun=true`
 * (DEFAULT) STOPS before it. The Paiement page's CB form is NEVER filled.
 *
 * IBAN/BIC are PII — they're masked (last 4) in every progress/log line; only
 * the extension's MAIN-world fill funcs ever see the full values.
 */
export const SubscriptionCompleteCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('subscription.complete'),
  /** Echoed back for correlation; the resumed devis is already in session. */
  devisNumber: z.string().min(3),
  subscriber: z.object({
    lastName: z.string().min(1),
    firstName: z.string().min(1),
  }),
  bank: BankInfoSchema,
  /** Lieu de naissance ville ("Paris" fallback for foreign-born). */
  birthPlaceCity: z.string().min(1),
  /** N° de série — Achraf's rule defaults to "1234567". */
  serialNumber: z.string().min(1).default('1234567'),
  /**
   * Safety gate. TRUE (DEFAULT) → STOP before clicking Valider souscription
   * and return the comptant breakdown. FALSE → run the full chain to the
   * Paiement page STOP (or rib_rejected).
   */
  dryRun: z.boolean().default(true),
  timeoutMs: z.number().int().positive().optional(),
});

export const CommandSchema = z.discriminatedUnion('kind', [
  PingCommandSchema,
  LoginEnsureCommandSchema,
  QuotePreviewCommandSchema,
  QuoteConfirmCommandSchema,
  DevisResumeCommandSchema,
  SubscriptionCompleteCommandSchema,
]);
export type Command = z.infer<typeof CommandSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Extension → backend responses                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export const PongResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('pong'),
  nonce: z.string().optional(),
});

export const LoginEnsureResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('login.ensure.ok'),
  alreadyLoggedIn: z.boolean(),
  /** "M8.T2.required_human_action" → caller surfaces via human-action flow. */
  requiredHumanAction: z.boolean(),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

export const QuotePreviewResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.preview.ok'),
  pricePreviewEur: z.object({
    monthly: z.number().nonnegative().optional(),
    annual: z.number().nonnegative().optional(),
  }),
  /**
   * M8.T7 B1: Garanties comptant breakdown extracted after the closing
   * controls (commission ALWAYS forced to 22 by default) were applied.
   * Optional for wire-compat with older extension builds.
   */
  comptantBreakdown: ComptantBreakdownSchema.optional(),
  screenshots: z.array(ScreenshotSchema),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

/**
 * In-progress response from the content script signaling that it just
 * clicked a control that triggers a top-frame navigation (M8.T8 phase 2e).
 *
 * The content script in the OLD page cannot complete the whole flow
 * because Chrome destroys its JS context on navigation. Instead, it does
 * as much as possible WITHIN the current page, then returns this
 * response. The SW orchestrator awaits `chrome.webNavigation.onCompleted`
 * for the same tab, then sends the SAME outer command again — the new
 * page's freshly-injected content script picks up where the old one left
 * off (using `detectCurrentScreen()` to figure out where it is).
 *
 * The orchestrator accumulates `screenshots` across iterations and only
 * surfaces the final `quote.preview.ok` (or `error`) to the upstream
 * caller — so the existing `runQuote()` surface on ExtensionClient does
 * not need to change.
 */
export const QuotePreviewNavigatingResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.preview.navigating'),
  /** Screen we were on when we triggered the navigation. */
  fromScreen: z.string(),
  /** What `detectCurrentScreen()` should report after the new page loads. */
  expectedScreen: z.string(),
  /** Screenshots captured during THIS advance iteration. SW concatenates. */
  screenshots: z.array(ScreenshotSchema),
});

export const QuoteConfirmResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.confirm.ok'),
  devisNumber: z.string().min(3),
  pdfSentTo: z.string().email(),
  screenshots: z.array(ScreenshotSchema),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
  /**
   * Phase-2g: in dryRun the flow opens the Courrier popup + fills the mail
   * composer then STOPS before Envoyer (M8.T6 contract). This reports that
   * best-effort outcome (e.g. 'opened_and_filled_no_send' or 'failed:…')
   * without failing the dryRun — the devis is already created. Absent on
   * real-mode (dryRun=false) responses.
   */
  courrierDryRunStatus: z.string().optional(),
  /**
   * M8.T7 B1: optional Garanties comptant breakdown. NOT populated by the
   * confirm flow yet — confirm's final response is built on the Edition à
   * imprimer page (2 navigations after Garanties), so the breakdown read on
   * Garanties doesn't survive to it without SW-side carry. Reserved for the
   * B2 devis.resume / B3 subscription flows, which DO end on/near Garanties.
   */
  comptantBreakdown: ComptantBreakdownSchema.optional(),
});

/** Mirror of QuotePreviewNavigatingResponseSchema for the confirm flow. */
export const QuoteConfirmNavigatingResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.confirm.navigating'),
  fromScreen: z.string(),
  expectedScreen: z.string(),
  screenshots: z.array(ScreenshotSchema),
});

/**
 * M8.T7 B2 — devis.resume terminal success. The flow ends on the Garanties
 * tab of the resumed devis with the closing controls applied. Mirrors
 * quote.preview.ok's price+breakdown shape so the operator reuses the same
 * extraction logic.
 */
export const DevisResumeResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('devis.resume.ok'),
  /** Echoed back so the caller can correlate against the requested devis. */
  devisNumber: z.string().min(3),
  /** Configured Garanties prices (commission forced to 22). */
  pricePreviewEur: z.object({
    monthly: z.number().nonnegative().optional(),
    annual: z.number().nonnegative().optional(),
  }),
  /** Comptant breakdown read off the configured Garanties tab. */
  comptantBreakdown: ComptantBreakdownSchema,
  screenshots: z.array(ScreenshotSchema),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

/** Mirror of QuotePreviewNavigatingResponseSchema for the resume flow. */
export const DevisResumeNavigatingResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('devis.resume.navigating'),
  fromScreen: z.string(),
  expectedScreen: z.string(),
  screenshots: z.array(ScreenshotSchema),
});

/**
 * M8.T7 B3 — subscription.complete terminal success. Two outcomes share this
 * shape:
 *   - dryRun=true → STOPPED before the destructive Valider souscription click;
 *     `stoppedBefore='valider_souscription'`, comptant from the Garanties tab.
 *   - dryRun=false → ran to the Paiement page STOP (CB never filled);
 *     `souscripteurRef` / `montantComptantEur` / `comptantBreakdown` from the
 *     bancaires + paiement pages.
 * (The RIB-test-rejection path returns an `error` with
 * `maxance_subscription_rib_rejected`, not this success.)
 */
export const SubscriptionCompleteResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('subscription.complete.ok'),
  dryRun: z.boolean(),
  /** Present in dryRun: the step we stopped before. */
  stoppedBefore: z.literal('valider_souscription').optional(),
  /** Maxance souscripteur/instance ref (e.g. "T123456789012") — real mode. */
  souscripteurRef: z.string().optional(),
  /** Montant règlement read off the Paiement page — real mode. */
  montantComptantEur: z.number().nonnegative().optional(),
  /** Email the souscripteur will be notified at — real mode (Paiement page). */
  souscripteurEmail: z.string().optional(),
  /** "Comptant à régler" breakdown from the bancaires page (real mode), or
   *  null when not reached (dryRun stop, or paiement after a cross-nav). */
  comptantBreakdown: SubscriptionComptantSchema.nullable(),
  /**
   * Garanties-tab comptant breakdown (fractionnement row), captured at the
   * dryRun STOP (we're still on the Garanties tab). Mirrors devis.resume.ok's
   * field. Absent in real mode (the flow leaves the Garanties tab).
   */
  garantiesComptant: ComptantBreakdownSchema.optional(),
  screenshots: z.array(ScreenshotSchema),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

/** Mirror of QuotePreviewNavigatingResponseSchema for the subscription flow. */
export const SubscriptionCompleteNavigatingResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('subscription.complete.navigating'),
  fromScreen: z.string(),
  expectedScreen: z.string(),
  screenshots: z.array(ScreenshotSchema),
});

/**
 * Generic error response. Caller correlates via `id`.
 * `errorCode` mirrors the tagged-error scheme the Operator agent already
 * consumes (maxance_quote_*, maxance_confirm_*, maxance_resume_*,
 * maxance_subscription_* incl. maxance_subscription_rib_rejected /
 * maxance_subscription_wrong_state, login_*, etc.) so the existing
 * QUOTE.FAILED routing keeps working unchanged.
 *
 * P3b adds a distinct `maxance_devis_contact_duplicate` — the repeat-customer
 * "Ce contact existe déjà" alerte survived the single in-flow recovery retry;
 * the backend routes it to a human / reuse-existing-contact strategy rather
 * than treating it as a generic fill failure.
 */
export const ErrorResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('error'),
  errorCode: z.string().min(1),
  detail: z.string().optional(),
  /** Best-effort screenshots captured before the failure point. */
  screenshots: z.array(ScreenshotSchema).optional(),
});

export const ResponseSchema = z.discriminatedUnion('kind', [
  PongResponseSchema,
  LoginEnsureResponseSchema,
  QuotePreviewResponseSchema,
  QuotePreviewNavigatingResponseSchema,
  QuoteConfirmResponseSchema,
  QuoteConfirmNavigatingResponseSchema,
  DevisResumeResponseSchema,
  DevisResumeNavigatingResponseSchema,
  SubscriptionCompleteResponseSchema,
  SubscriptionCompleteNavigatingResponseSchema,
  ErrorResponseSchema,
]);
export type Response = z.infer<typeof ResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Spontaneous events (extension → backend, not paired with an id)           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Hello frame sent immediately after the WS opens. Lets the backend log
 * the extension version + URL state so it knows which Chrome tab is the
 * active Maxance one (useful when the user has multiple Maxance tabs open).
 */
export const HelloEventSchema = z.object({
  kind: z.literal('hello'),
  extensionVersion: z.string(),
  /** Currently-active Maxance tab URL, or null if none open. */
  activeMaxanceUrl: z.string().url().nullable(),
  capabilities: z.array(z.string()).default([]),
});

/**
 * Progress event during a long-running flow. The extension emits one per
 * material step so the backend can stream updates to the operator UI.
 */
export const ProgressEventSchema = z.object({
  kind: z.literal('progress'),
  /** Command id this progress relates to. */
  commandId: z.string().uuid(),
  step: z.string(),
  detail: z.string().optional(),
});

export const EventSchema = z.discriminatedUnion('kind', [HelloEventSchema, ProgressEventSchema]);
export type Event = z.infer<typeof EventSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Anything-on-the-wire helper                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Parse an inbound WS frame (string) into one of the three message shapes.
 * Throws a tagged error if the JSON is malformed or doesn't match any schema.
 * Used by both sides of the wire (extension's background.ts inbox, backend's
 * extension-client.ts inbox).
 */
export function parseFrame(
  text: string,
):
  | { side: 'command'; value: Command }
  | { side: 'response'; value: Response }
  | { side: 'event'; value: Event } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('extension_wire_invalid_json');
  }
  const asCommand = CommandSchema.safeParse(raw);
  if (asCommand.success) return { side: 'command', value: asCommand.data };
  const asResponse = ResponseSchema.safeParse(raw);
  if (asResponse.success) return { side: 'response', value: asResponse.data };
  const asEvent = EventSchema.safeParse(raw);
  if (asEvent.success) return { side: 'event', value: asEvent.data };
  throw new Error('extension_wire_unrecognised_frame');
}
