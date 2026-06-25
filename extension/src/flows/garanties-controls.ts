/**
 * Garanties closing controls — content-script side (M8.T7 B1).
 *
 * Two responsibilities:
 *   1. `applyGarantiesConfig(cfg)` — ask the SW to apply formule /
 *      commission / fractionnement on the Garanties tab via the
 *      `garanties.configure-mw` main-world handler (same content→SW
 *      side-channel as devisFillAndSubmitMainWorld in dom.ts). Maps the
 *      param-shaped enums to the live-verified Maxance codes from the
 *      canonical selectors module before sending.
 *   2. `extractComptantBreakdown()` — pure DOM read (isolated world is
 *      fine, no framework interaction): the fractionnement-row numbers
 *      from the body text, the currently-selected fractionnement, and
 *      the "Frais comptant" amount from the hidden `commptant_<code>`
 *      popup div.
 *
 * Used by quote.preview (always — commission defaults to 22) and reused
 * by the upcoming devis.resume (B2) / subscription.complete (B3) flows.
 */
import {
  COMPTANT_POPUP_ID_PREFIX,
  FORMULE_CODE,
  FRACTIONNEMENT_CODE,
  FRACTIONNEMENT_SELECT_NAME,
  parseFraisComptant,
} from '../maxance/selectors.js';
import type { GarantiesConfigureRequest, GarantiesConfigureResponse } from '../content-protocol.js';
import type { ComptantBreakdown } from '../wire.js';

/** Param-shaped Garanties configuration (wire enums, not Maxance codes). */
export interface GarantiesConfig {
  formule?: 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';
  /** Target commission % — caller clamps (clampCommissionPct, default 22). */
  commissionPct: number;
  fractionnement?: 'mensuel' | 'annuel';
}

/**
 * Apply the Garanties closing controls via the SW's main-world handler.
 * Throws a tagged `maxance_garanties_config_failed:<reason>` error on any
 * failure so the flow's catch-all maps it to the standard errorCode shape.
 */
export async function applyGarantiesConfig(
  cfg: GarantiesConfig,
): Promise<{ log: string[]; finalCommission: string }> {
  const msg: GarantiesConfigureRequest = {
    kind: 'garanties.configure-mw',
    payload: {
      commissionPct: cfg.commissionPct,
      ...(cfg.formule !== undefined ? { formuleCode: FORMULE_CODE[cfg.formule] } : {}),
      ...(cfg.fractionnement !== undefined
        ? { fractionnementCode: FRACTIONNEMENT_CODE[cfg.fractionnement] }
        : {}),
    },
  };
  const resp = (await chrome.runtime.sendMessage(msg)) as GarantiesConfigureResponse | undefined;
  if (!resp) throw new Error('maxance_garanties_config_failed:no_response');
  if (resp.kind !== 'garanties.ok') {
    throw new Error(`maxance_garanties_config_failed:${resp.error} [${resp.log.join(',')}]`);
  }
  return { log: resp.log, finalCommission: resp.finalCommission };
}

/** Maxance fractionnement option value → wire enum. */
const FRACTIONNEMENT_BY_CODE: Record<string, 'mensuel' | 'semestriel' | 'annuel'> = {
  M: 'mensuel',
  S: 'semestriel',
  A: 'annuel',
};

/**
 * Parse the fractionnement summary row out of the Garanties body text.
 * innerText renders the table as (live-verified 2026-06-11):
 *
 *   "Fractionnement Comptant Terme suivant Coût annuel brut**
 *    Mensuel Semestriel Annuel 21.58 7.97 95.71"
 *
 * The select renders its three option labels first, then the three decimal
 * numbers = Comptant, Terme suivant, Coût annuel brut. Exported separately
 * so unit tests can pin the parse without a DOM.
 */
export function parseFractionnementRow(bodyText: string | null | undefined): {
  comptantEur?: number;
  termeSuivantEur?: number;
  coutAnnuelBrutEur?: number;
} {
  if (!bodyText) return {};
  const m =
    /Mensuel\s+Semestriel\s+Annuel\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})/i.exec(
      bodyText,
    );
  if (!m) return {};
  const num = (s: string | undefined): number =>
    s ? Number.parseFloat(s.replace(',', '.')) : Number.NaN;
  const comptant = num(m[1]);
  const terme = num(m[2]);
  const brut = num(m[3]);
  return {
    ...(Number.isFinite(comptant) ? { comptantEur: comptant } : {}),
    ...(Number.isFinite(terme) ? { termeSuivantEur: terme } : {}),
    ...(Number.isFinite(brut) ? { coutAnnuelBrutEur: brut } : {}),
  };
}

/**
 * Read the comptant breakdown from the (already-configured) Garanties tab.
 * Pure DOM read from the content script — no main world needed:
 *   - which fractionnement is selected (select value M/S/A),
 *   - the Comptant / Terme suivant / Coût annuel brut row numbers,
 *   - the "Frais comptant" amount from the hidden popup div whose id is
 *     `commptant_<code>` (suffix = CURRENT fractionnement code).
 * Best-effort: absent pieces are simply omitted (fraisComptantEur → null).
 */
export function extractComptantBreakdown(): ComptantBreakdown {
  const sel = document.querySelector<HTMLSelectElement>(
    `select[name="${FRACTIONNEMENT_SELECT_NAME}"]`,
  );
  const code = sel?.value ?? '';
  const fractionnement = FRACTIONNEMENT_BY_CODE[code];
  const row = parseFractionnementRow(document.body.innerText);
  const popup = code ? document.getElementById(`${COMPTANT_POPUP_ID_PREFIX}${code}`) : null;
  return {
    ...(fractionnement !== undefined ? { fractionnement } : {}),
    ...row,
    fraisComptantEur: parseFraisComptant(popup?.textContent),
  };
}
