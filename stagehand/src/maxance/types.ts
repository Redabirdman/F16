/**
 * Shared types for the M8.T2 Maxance login + heartbeat module.
 *
 * Kept separate from `src/types.ts` (which carries HTTP-surface contracts) so
 * the Maxance-specific surface can evolve without churning unrelated callers.
 */

/**
 * Outcome of one `extract` call against the live page. The page-type label is
 * narrow on purpose — the login flow's branching switch only handles these
 * cases. Anything Stagehand returns outside this set collapses to `unknown`
 * and escalates.
 */
export type MaxancePageType =
  | 'login_form'
  | 'password_form'
  | 'dashboard'
  | 'sms_prompt'
  | 'proximeo_home'
  | 'error_page'
  | 'unknown';

/**
 * One screenshot captured during the login flow. `step` is a short slug
 * (`login_form_pre`, `dashboard_post`, `proximeo_home`) for audit-log
 * correlation; `url` is the served path (`/v1/static/screenshots/...`).
 */
export interface MaxanceLoginScreenshot {
  step: string;
  url: string;
}

/**
 * Success payload returned by `loginMaxance`. On any unrecoverable failure
 * the function throws (sanitised — never carrying creds) instead of returning
 * a partial result.
 */
export interface MaxanceLoginResult {
  sessionId: string;
  durationMs: number;
  screenshots: MaxanceLoginScreenshot[];
  alreadyLoggedIn: boolean;
  requiredHumanAction: boolean;
  /** Should match the Proximéo home URL on success. */
  finalUrl: string;
}

/**
 * The human-action resolver is wired by the HTTP layer (or M8.T4 directly)
 * to the backend's HUMAN_ACTION.REQUESTED flow. The login function calls it
 * once on a 2FA prompt and AWAITS the returned promise — when the human
 * supplies the code (via admin UI or WhatsApp), the resolver resolves.
 *
 * On timeout (login flow's responsibility, 15min default) the caller should
 * race a timeout and throw so the user-data dir doesn't sit half-authenticated.
 */
export type HumanActionResolver = (req: HumanActionRequest) => Promise<string>;

export interface HumanActionRequest {
  /** Short human-readable summary for the operator. */
  summary: string;
  /** Allowed response options. For 2FA: a free-text code. */
  options: { type: 'free_text'; label: string }[];
  /** Correlation id to attach to the HUMAN_ACTION row. */
  correlationId: string;
}

export interface MaxanceLoginOptions {
  /** Resolver invoked on 2FA SMS prompt. Required — there is no automatic fallback. */
  humanActionResolver: HumanActionResolver;
  /** Where to write screenshots. Defaults to STAGEHAND_DATA_DIR. */
  dataRoot?: string;
  /**
   * Override the 2FA wait budget. Default 15min. Tests override to ~50ms.
   * The login function throws `maxance_2fa_timeout` if exceeded.
   */
  twoFactorTimeoutMs?: number;
  /** Optional callback fired after each screenshot capture (for streaming UIs). */
  screenshotCallback?: (shot: MaxanceLoginScreenshot) => void;
  /**
   * When true, the function does NOT try to fill / submit the MFA code itself.
   * It pauses on the SMS prompt and polls the page until a human has manually
   * typed the code, ticked "Se souvenir 30 jours", and clicked Continuer in
   * the visible browser. Use for the first-of-the-month bootstrap when SMS
   * codes expire faster than we can route them through chat.
   *
   * Polls every `manualSmsPollIntervalMs` (default 2000ms) up to
   * `twoFactorTimeoutMs`. Throws `maxance_2fa_timeout` if exceeded.
   */
  manualSmsHandling?: boolean;
  /** Poll interval for manualSmsHandling mode. Default 2000ms. */
  manualSmsPollIntervalMs?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  M8.T3 — quote flow                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Supported vehicle types in the M8.T3 quote-flow library. The intent
 * library is bootstrapped for EDPM trottinettes only; the other product
 * lines (auto, moto, habitation, etc.) ride on the same Proximéo skeleton
 * but each has its own field sequence — they'll be added per-product as
 * Achraf signs off on each walkthrough.
 */
export type MaxanceVehicleKind = 'trottinette';

/** Optional payment cadence at the Garanties tab. Default `mensuel`. */
export type MaxanceFractionnement = 'mensuel' | 'annuel';

/** Coverage tier. Achraf's default is `tiers_illimite`. */
export type MaxanceFormule = 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';

/**
 * Where the trottinette is stored overnight. Drives risk pricing; must be
 * asked from the client up-front because we cannot guess it. The labels
 * match what Maxance shows in its dropdown (verbatim French) — translating
 * them here keeps the intent layer language-agnostic.
 */
export type MaxanceStationnement =
  | 'garage_box'
  | 'parking_prive_clos'
  | 'parking_prive_non_clos'
  | 'rue';

/**
 * Parameters for one quote run. The intent library reads these from the
 * caller (M8.T4 sources them from the QUOTE.REQUESTED payload).
 *
 * Everything Achraf flagged as "auto-fill default" is baked into the
 * intent steps directly — those values are NOT exposed here so they can't
 * accidentally drift per-quote.
 */
export interface MaxanceQuoteParams {
  /** EDPM trottinette only for M8.T3. */
  vehicleKind: MaxanceVehicleKind;
  /**
   * Purchase price in EUR, drives the "Version" price band. Achraf's PDF
   * lists the bands (≤200€, 200-400€, 400-700€, …). The intent layer maps
   * the raw price to the right band label via Stagehand `act` + a hint.
   */
  purchasePriceEur: number;
  /**
   * Acquisition date — used for both "Première mise en circulation" and
   * "Date d'acquisition". Achraf's rule: identical values, sourced from the
   * client's invoice.
   */
  purchaseDate: Date;
  postalCode: string;
  /** Optional — Maxance auto-fills from CP, but pass through if the caller has it. */
  city?: string;
  stationnement: MaxanceStationnement;
  /** Date of birth — only required field on the Conducteur tab. */
  clientDateOfBirth: Date;
  /**
   * Coverage tier. Default `tiers_illimite` (Achraf's recommended starter
   * formula). The Sales Agent can upgrade per the client's preference.
   */
  formule?: MaxanceFormule;
  /**
   * Commission percentage, slider 9 → 22 on the Garanties tab. Default 9
   * (the lowest — Achraf's directive is to start low and raise on appetite).
   */
  commissionPct?: number;
  /** Payment cadence. Default `mensuel`. */
  fractionnement?: MaxanceFractionnement;
}

/**
 * One screenshot from the quote flow. Shape matches the login module's
 * screenshot type — both serve the same `/v1/static/screenshots/...` URL.
 */
export interface MaxanceQuoteScreenshot {
  step: string;
  url: string;
}

/**
 * Terminal payload from a successful quote run. Until M8.T6 wires the
 * "Envoyer par email" PDF capture, this stops at the price-preview screen
 * (price visible, no Valider clicked).
 */
export interface MaxanceQuoteResult {
  sessionId: string;
  durationMs: number;
  screenshots: MaxanceQuoteScreenshot[];
  /** Whether the run was a dry run (stopped before Valider souscription). */
  dryRun: boolean;
  /**
   * Headline price extracted from the Garanties tab. The exact label varies
   * by formule + fractionnement — we store both monthly and annual when
   * visible. Both nullable so the caller can decide what to surface.
   */
  pricePreviewEur: {
    monthly?: number;
    annual?: number;
  };
  /** URL at the moment of result return — used for downstream audit logs. */
  finalUrl: string;
}

export interface MaxanceQuoteOptions {
  /** Where to write screenshots. Defaults to STAGEHAND_DATA_DIR. */
  dataRoot?: string;
  /** Optional callback fired after each screenshot capture (for streaming UIs). */
  screenshotCallback?: (shot: MaxanceQuoteScreenshot) => void;
  /**
   * When true (the M8.T3 default during dev), the flow halts at the
   * price-preview screen — NEVER clicks "Valider souscription". This is
   * non-negotiable: a Valider creates a real record in Maxance and
   * notifies the inspector. Set false only after Achraf has approved the
   * first end-to-end live submission.
   */
  dryRun: boolean;
  /**
   * Wall-clock budget for the whole quote flow. Default 5 min. Long
   * because the form has ~12 substantive act/extract calls and each round-
   * trips through Anthropic.
   */
  timeoutMs?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  M8.T6 — Valider devis + email send                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Civilité — Maxance's salutation dropdown on the Devis tab. Verbatim French
 * values; Madame/Monsieur are the only ones we ship for trottinettes.
 */
export type MaxanceCivilite = 'monsieur' | 'madame';

/**
 * Subscriber-info payload for the Devis tab. Per Achraf's walkthrough
 * (`ETAPE MAXANCE AI.pdf`, step 5), these are the fields the broker fills
 * once the price has been previewed. All are required by Maxance — the
 * Devis tab refuses to advance without them.
 *
 * PII boundary: the backend Operator decrypts customer.phone, customer.email,
 * customer.fullName at call time and passes them here; this struct lives
 * only in-memory inside the Stagehand process and is not logged.
 */
export interface MaxanceSubscriberInfo {
  civilite: MaxanceCivilite;
  /** Family name (NOM). Uppercase preferred but Maxance accepts mixed-case. */
  lastName: string;
  /** First name (PRÉNOM). */
  firstName: string;
  /** Civic address, single line. e.g. "12 RUE DE LA PAIX". */
  addressLine: string;
  /** Apartment / floor / building info — optional. */
  addressComplement?: string;
  postalCode: string;
  city: string;
  /** Customer's mobile, French format. e.g. "+33612345678" or "0612345678". */
  phoneMobile: string;
  /** Customer's email — Maxance will email the quote PDF to this address. */
  email: string;
  /**
   * Profession dropdown — defaults to Achraf's "Employé secteur privé" if
   * unset. Most trottinette customers fit that bucket; the broker can
   * override at run time when they have explicit info.
   */
  profession?: 'employe_prive' | 'employe_public' | 'etudiant' | 'retraite' | 'sans_profession';
}

/**
 * Input to `confirmQuote` — the operator-side wrapper that takes the
 * preview-ready Stagehand session through Valider devis → Devis tab fill →
 * Edition à imprimer → email send → devisNumber capture.
 *
 * Pre-condition: the caller has just received a successful
 * `MaxanceQuoteResult` from `startQuote` on the SAME session. The session
 * is sitting on the Garanties tab with the price visible.
 */
export interface MaxanceConfirmQuoteParams {
  subscriber: MaxanceSubscriberInfo;
}

/**
 * Result of a successful `confirmQuote`. Maxance does the actual email
 * dispatch internally (the broker doesn't get a PDF download URL — Maxance
 * mails it directly from its server), so we surface `pdfSentTo` instead of
 * a pdfUrl. The devisNumber is the broker-facing reference printed on the
 * Edition à imprimer screen — it's the lookup key for "Reprendre devis"
 * later when the customer accepts.
 */
export interface MaxanceConfirmQuoteResult {
  sessionId: string;
  durationMs: number;
  screenshots: MaxanceQuoteScreenshot[];
  /** Devis number Maxance prints on the Edition à imprimer page. */
  devisNumber: string;
  /** Email address Maxance sent the PDF to (echoes back so the caller can audit). */
  pdfSentTo: string;
  /** URL at the moment of result return. */
  finalUrl: string;
}

export interface MaxanceConfirmQuoteOptions {
  /** Where to write screenshots. Defaults to STAGEHAND_DATA_DIR. */
  dataRoot?: string;
  /** Optional callback fired after each screenshot capture. */
  screenshotCallback?: (shot: MaxanceQuoteScreenshot) => void;
  /**
   * When true (default during M8.T6 dev), the flow STOPS just before the
   * final Envoyer click — captures the prepared email-send dialog state
   * but doesn't actually dispatch. Set false for production runs after
   * Achraf has signed off on the live email path.
   *
   * Note: this differs from `MaxanceQuoteOptions.dryRun` which halts at
   * the price preview. M8.T6's dryRun halts ONE step earlier than Achraf's
   * locked guardrail (Valider souscription) — sending a quote PDF is
   * still a real action with customer-facing consequences, so we ship it
   * dry-by-default until verified.
   */
  dryRun: boolean;
  /** Wall-clock budget. Default 3 min — fewer LLM calls than the quote flow. */
  timeoutMs?: number;
}
