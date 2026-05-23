/**
 * Maxance Proximéo selectors + constants (canonical reference, live-verified).
 *
 * 🔑 SINGLE SOURCE OF TRUTH for the Maxance UI mapping. Imported by BOTH:
 *   - stagehand/src/maxance/quote-form.ts (legacy Playwright runtime, dead in prod)
 *   - extension/src/flows/* (V1 Chrome-extension driver — actually runs)
 *
 * PURE module: no runtime imports — only type imports from types.ts. Bundleable
 * in a browser context (no node:fs, no logger, no Stagehand). This means the
 * extension can `import { ... } from '@f16/stagehand/maxance/selectors'`
 * without dragging Playwright into a Chrome MV3 service worker.
 *
 * Verified live 2026-05-22 (M8.T3) + 2026-05-23 (M8.T6) against the real
 * Maxance broker portal driven via the Claude in Chrome extension. Per
 * Ridaa: Maxance UI is stable for 12+ months — these constants are safe.
 */
import type {
  MaxanceFractionnement,
  MaxanceFormule,
  MaxanceQuoteParams,
  MaxanceStationnement,
  MaxanceSubscriberInfo,
} from './types.js';

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

/* ────────────────────────────────────────────────────────────────────────── */
/*  Re-export the param type for downstream consumers                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** Re-export so a single import from selectors covers most downstream needs. */
export type { MaxanceQuoteParams };
