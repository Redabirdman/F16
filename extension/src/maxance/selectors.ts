/**
 * Maxance Proximéo selectors + constants (canonical reference, live-verified).
 *
 * 🔑 SINGLE SOURCE OF TRUTH for the Maxance UI mapping. Imported by the
 * extension/src/flows/* (V1 Chrome-extension driver — the actual production
 * Maxance driver).
 *
 * PURE module: no runtime imports — only the inlined param-shaped types
 * below. Bundleable in a browser context (no node:fs, no logger, no
 * Stagehand / Playwright). This file is self-contained: the handful of
 * Maxance param enums it references (formerly imported from the dropped
 * Playwright-driver workspace's maxance types) are inlined here so the
 * extension drags nothing extra into a Chrome MV3 service worker.
 *
 * Verified live 2026-05-22 (M8.T3) + 2026-05-23 (M8.T6) against the real
 * Maxance broker portal driven via the Claude in Chrome extension. Per
 * Ridaa: Maxance UI is stable for 12+ months — these constants are safe.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/*  Maxance param enums (inlined — previously a separate maxance/types module) */
/* ────────────────────────────────────────────────────────────────────────── */

/** Supported vehicle types in the quote-flow library (EDPM trottinette only). */
export type MaxanceVehicleKind = 'trottinette';

/** Optional payment cadence at the Garanties tab. Default `mensuel`. */
export type MaxanceFractionnement = 'mensuel' | 'annuel';

/** Coverage tier. Achraf's default is `tiers_illimite`. */
export type MaxanceFormule = 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';

/**
 * Where the trottinette is stored overnight. Drives risk pricing; must be
 * asked from the client up-front because we cannot guess it.
 */
export type MaxanceStationnement =
  | 'garage_box'
  | 'parking_prive_clos'
  | 'parking_prive_non_clos'
  | 'rue';

/** Civilité — Maxance's salutation dropdown on the Devis tab. */
export type MaxanceCivilite = 'monsieur' | 'madame';

/**
 * Parameters for one quote run. The intent library reads these from the
 * caller (sourced from the QUOTE.REQUESTED payload).
 */
export interface MaxanceQuoteParams {
  /** EDPM trottinette only. */
  vehicleKind: MaxanceVehicleKind;
  /** Purchase price in EUR — drives the "Version" price band. */
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
  /** Coverage tier. Default `tiers_illimite`. */
  formule?: MaxanceFormule;
  /** Commission percentage, slider 9 → 22 on the Garanties tab. Default 9. */
  commissionPct?: number;
  /** Payment cadence. Default `mensuel`. */
  fractionnement?: MaxanceFractionnement;
}

/**
 * Subscriber-info payload for the Devis tab — the fields the broker fills
 * once the price has been previewed. All are required by Maxance.
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
   * unset.
   */
  profession?: 'employe_prive' | 'employe_public' | 'etudiant' | 'retraite' | 'sans_profession';
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  URLs                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Standalone Proximéo SSO entry URL. Reached via "Accès Proximéo" sidebar
 * on the extranet dashboard. Used as a fallback when the sidebar click misses.
 */
export const PROXIMEO_SSO_URL = 'https://www.maxance.com/Proximeo/ConnexionCourtierSSOCallback.do';

/**
 * URL pathname signatures the extension uses to detect which Proximéo screen
 * is currently visible. We match by `endsWith` so URL params don't break the
 * detection.
 */
export const PROXIMEO_URL_SIGNATURES = {
  dashboard: '/MaXance/',
  proximeoHome: '/Proximeo/ConnexionCourtierSSOCallback.do',
  /** Edition à imprimer after Valider devis (M8.T6 terminal). */
  editionImprimer: '/Proximeo/souscriptionDevisValiderFinaleMoto.do',
} as const;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Véhicule tab (M8.T3)                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Marque dropdown option for our EDPM portfolio. */
export const MARQUE_TROTTINETTE = 'TROTTINETTE' as const;

/** Cylindrée — all trottinettes bridled at 25 km/h per Achraf. */
export const CYLINDREE_TROTTINETTE = '25' as const;

/** Type d'acquisition: R = "Achat d'un véhicule de remplacement". Hard-coded default. */
export const TYPE_ACQUISITION_REMPLACEMENT = 'R' as const;

/**
 * Maxance's Version dropdown groups the purchase price into 12 bands, each
 * backed by a stable numeric option value. Verified live 2026-05-22:
 *
 *   [0 – 500[      → 8181
 *   [500 – 1000[   → 8182
 *   [1000 – 1500[  → 8183
 *   [1500 – 2000[  → 8184
 *   [2000 – 3000[  → 8185
 *   [3000 – 4000[  → 8186
 *   [4000 – 5000[  → 8187
 *   [5000 – 6000[  → 8188
 *   [6000 – 7000[  → 8189
 *   [7000 – 8000[  → 8190
 *   [8000 – 9000[  → 8191
 *   [9000 – 10000[ → 8192
 *
 * Prices > 10000€ clamp to the top band (8192) — caller should flag for
 * manual review (atypical trottinette price).
 */
export function trottinetteVersionBand(priceEur: number): string {
  const p = Math.max(0, Math.floor(priceEur));
  if (p < 500) return '8181';
  if (p < 1000) return '8182';
  if (p < 1500) return '8183';
  if (p < 2000) return '8184';
  if (p < 3000) return '8185';
  if (p < 4000) return '8186';
  if (p < 5000) return '8187';
  if (p < 6000) return '8188';
  if (p < 7000) return '8189';
  if (p < 8000) return '8190';
  if (p < 9000) return '8191';
  return '8192';
}

/**
 * Translate the param-shaped stationnement enum to the verified live values:
 *   G = Garage ou box fermé
 *   O = Parking ouvert
 *   P = Propriété entièrement close
 *   V = Voie publique
 *
 * `parking_prive_non_clos` maps to "Parking ouvert" (O) — closest semantic match.
 */
export function stationnementOption(s: MaxanceStationnement): {
  label: string;
  value: 'G' | 'O' | 'P' | 'V';
} {
  switch (s) {
    case 'garage_box':
      return { label: 'Garage ou box fermé', value: 'G' };
    case 'parking_prive_clos':
      return { label: 'Propriété entièrement close', value: 'P' };
    case 'parking_prive_non_clos':
      return { label: 'Parking ouvert', value: 'O' };
    case 'rue':
      return { label: 'Voie publique', value: 'V' };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Conducteur tab (M8.T3)                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Profession dropdown option codes — verified live. Default `employe_prive`
 * (125) covers most trottinette customers (Achraf's directive).
 */
export const PROFESSION_VALUE: Record<NonNullable<MaxanceSubscriberInfo['profession']>, string> = {
  employe_prive: '125',
  employe_public: '126',
  etudiant: '108',
  retraite: '109',
  sans_profession: '130',
};

/** Convenience constant for the "Employé secteur privé" default. */
export const PROFESSION_EMPLOYE_SECTEUR_PRIVE = PROFESSION_VALUE.employe_prive;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Garanties tab (M8.T3)                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** Verbatim French labels for the Garanties tab formule radios. */
export function formuleLabel(f: MaxanceFormule): string {
  switch (f) {
    case 'tiers_illimite':
      return 'Tiers illimité';
    case 'vol_incendie':
      return 'Tiers illimité + Vol Incendie';
    case 'dommages_tous_accidents':
      return 'Dommages tous accidents';
  }
}

/** Fractionnement dropdown labels. */
export function fractionnementLabel(f: MaxanceFractionnement): string {
  return f === 'annuel' ? 'Annuel' : 'Mensuel';
}

/**
 * Commission slider band. Per Achraf: 9 (low) → 22 (high). Default 9.
 * Caller passes a number; clamp here.
 */
export function clampCommissionPct(raw: number | undefined): number {
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 9;
  return Math.max(9, Math.min(22, Math.round(v)));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Garanties closing controls (M8.T7 B1) — live-verified 2026-06-11           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Formule radio group name on the Garanties tab. Each radio carries an
 * inline `onclick="submitFormule();"` (page-global fn) that triggers the
 * AJAX price re-render.
 */
export const FORMULE_RADIO_NAME = 'codeFormuleSelected' as const;

/** Formule radio `value` attributes, live-verified 2026-06-11. */
export const FORMULE_CODE: Record<MaxanceFormule, 'NV10' | 'NV20' | 'NV30'> = {
  tiers_illimite: 'NV10',
  vol_incendie: 'NV20',
  dommages_tous_accidents: 'NV30',
};

/**
 * Commission text input — id AND name are both this value. Default "9.0",
 * max 22. Set mechanism (verified live): native value setter + dispatch
 * input/change/blur — the generated inline onblur handler
 * (`garantieTauxCommissionEffectifsetSliderValue0`) runs the AJAX
 * re-render (~5-6s, "Chargement" indicator in body text while in-flight).
 */
export const COMMISSION_INPUT_ID = 'garantieTauxCommissionEffectif' as const;

/**
 * Fractionnement select on the Garanties tab. Inline
 * `onchange=doSubmitFormCustomWithCacheAJAX(...)` — set value + dispatch
 * a change event, then wait for the AJAX re-render.
 */
export const FRACTIONNEMENT_SELECT_NAME = 'mouvement.codeFractionnement' as const;

/**
 * Fractionnement option values: M=Mensuel / S=Semestriel / A=Annuel.
 * V1 only ever sets M or A (semestriel unused commercially).
 */
export const FRACTIONNEMENT_CODE: Record<MaxanceFractionnement, 'M' | 'A'> = {
  mensuel: 'M',
  annuel: 'A',
};

/**
 * Hidden frais-comptant popup div id prefix. Full id = prefix + the
 * CURRENT fractionnement code (e.g. `commptant_M` when Mensuel,
 * `commptant_A` when Annuel). NB: Maxance's typo ("commptant") is theirs.
 */
export const COMPTANT_POPUP_ID_PREFIX = 'commptant_' as const;

/**
 * Matches the "Frais comptant" line inside the commptant_<code> popup
 * textContent, e.g. "… + 17.00 (Frais comptant) + …".
 */
export const FRAIS_COMPTANT_REGEX = /(\d+[.,]\d{2})\s*\(Frais comptant\)/i;

/** Parse the frais-comptant EUR amount from the popup text. Null on no match. */
export function parseFraisComptant(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = FRAIS_COMPTANT_REGEX.exec(text);
  if (!m?.[1]) return null;
  return Number.parseFloat(m[1].replace(',', '.'));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Devis tab (M8.T6)                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Civilité dropdown — verified live 2026-05-23. The <option value=> attribute
 * carries the abbreviation (M., MME, MLLE) NOT the spelled-out label.
 */
export const CIVILITE_VALUE: Record<MaxanceSubscriberInfo['civilite'], 'M.' | 'MME'> = {
  monsieur: 'M.',
  madame: 'MME',
};

/**
 * Phone widget — three dropdowns + textbox. Verified live: trottinette
 * customers default to Mobile + Personnel + FR.
 */
export const PHONE_TYPE_MOBILE = 'MOBILE' as const;
export const PHONE_USAGE_PERSO = 'PERSO' as const;
export const PHONE_COUNTRY_FR = 'FR' as const;

/**
 * E-mail widget — dropdown of role + textbox. ADMIN (Gestion) is the one
 * Achraf uses for quote-PDF send + future contract emails.
 */
export const EMAIL_ROLE_GESTION = 'ADMIN' as const;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Courrier popup (M8.T6) — legacy widget                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Live investigation (2026-05-23, M8.T8) proved the Courrier popup is a
 * SAME-ORIGIN nested iframe at #window_nvCourrier > #nvCourrier. The
 * extension drives it via `iframe.contentDocument.querySelector(...)` —
 * NOT via the coordinate-click path the M8.T6 Stagehand step planner used.
 *
 * The pixel coordinates below are kept ONLY as fallback documentation in
 * case Maxance ever rewrites the popup with an opaque <object> embed that
 * blocks iframe traversal. Not used by the V1 extension flows.
 */
export const COURRIER_POPUP_FALLBACK_COORDS = {
  envelopeIcon: [86, 33] as const,
  closeX: [474, 10] as const,
  mailComposer: {
    adresseInput: [290, 50] as const,
    objetInput: [290, 95] as const,
    envoyerButton: [31, 115] as const,
  },
} as const;

/**
 * Courrier popup URL pattern. `mdiWindNet.window(...)` opens an iframe with
 * this URL inside #window_nvCourrier. The `ligneSelected=DR` query says
 * "I'm sending a Devis Reçu letter" — matches the devisNumber's DR prefix.
 */
export const COURRIER_POPUP_URL_PATH = '/Proximeo/listerModeleLettreAutorise.do';
export const COURRIER_POPUP_IFRAME_ID = 'window_nvCourrier';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Date formatting                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/** Format Date as Maxance's dd/mm/yyyy input mask. */
export function formatDateFr(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Format an ISO date string (YYYY-MM-DD) as Maxance's dd/mm/yyyy mask.
 * The wire format uses ISO strings (JSON-safe); the DOM helpers accept
 * pre-formatted strings. This is the extension-side equivalent of
 * `formatDateFr` for use when no Date object is in scope.
 */
export function formatIsoDateFr(iso: string): string {
  // Accept full ISO 8601 too — split on T and grab the date portion.
  const [datePart] = iso.split('T');
  const safe = datePart ?? '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(safe);
  if (!m) throw new Error(`maxance_invalid_iso_date:${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}
