/**
 * Unit tests for the canonical Maxance selectors module (M8.T8 phase 2).
 *
 * `selectors.ts` is the single source of truth for the Maxance UI mapping.
 * Both the Stagehand (legacy) runtime and the V1 Chrome-extension driver
 * import from here. These tests pin every value live-verified during
 * M8.T3 + M8.T6 + the M8.T8 phase 2 investigation so accidental drift
 * surfaces in CI before it reaches a real customer.
 *
 * Pure data + pure functions — no DOM, no network. Runs in ~10ms.
 */
import { describe, it, expect } from 'vitest';
import {
  CIVILITE_VALUE,
  COMMISSION_INPUT_ID,
  COMPTANT_POPUP_ID_PREFIX,
  COURRIER_POPUP_FALLBACK_COORDS,
  COURRIER_POPUP_IFRAME_ID,
  COURRIER_POPUP_URL_PATH,
  CYLINDREE_TROTTINETTE,
  EMAIL_ROLE_GESTION,
  FORMULE_CODE,
  FORMULE_RADIO_NAME,
  FRACTIONNEMENT_CODE,
  FRACTIONNEMENT_SELECT_NAME,
  FRAIS_COMPTANT_REGEX,
  MARQUE_TROTTINETTE,
  PHONE_COUNTRY_FR,
  PHONE_TYPE_MOBILE,
  PHONE_USAGE_PERSO,
  PROFESSION_EMPLOYE_SECTEUR_PRIVE,
  PROFESSION_VALUE,
  PROXIMEO_SSO_URL,
  PROXIMEO_URL_SIGNATURES,
  TYPE_ACQUISITION_REMPLACEMENT,
  clampCommissionPct,
  formatDateFr,
  formatIsoDateFr,
  formuleLabel,
  fractionnementLabel,
  parseFraisComptant,
  stationnementOption,
  trottinetteVersionBand,
} from '../../src/maxance/selectors.js';

describe('Véhicule constants', () => {
  it('pins MARQUE_TROTTINETTE to the live-verified value', () => {
    expect(MARQUE_TROTTINETTE).toBe('TROTTINETTE');
  });
  it('pins CYLINDREE_TROTTINETTE to 25 (bridled)', () => {
    expect(CYLINDREE_TROTTINETTE).toBe('25');
  });
  it('pins TYPE_ACQUISITION_REMPLACEMENT to R', () => {
    expect(TYPE_ACQUISITION_REMPLACEMENT).toBe('R');
  });
});

describe('trottinetteVersionBand — full band table (live-verified)', () => {
  const cases: Array<[number, string]> = [
    [0, '8181'],
    [499, '8181'],
    [500, '8182'],
    [999, '8182'],
    [1000, '8183'],
    [1500, '8184'],
    [2000, '8185'],
    [3000, '8186'],
    [4000, '8187'],
    [5000, '8188'],
    [6000, '8189'],
    [7000, '8190'],
    [8000, '8191'],
    [9000, '8192'],
    [10000, '8192'], // clamps to top band — caller flags for review
    [25000, '8192'],
  ];
  for (const [price, band] of cases) {
    it(`maps ${price}€ → ${band}`, () => {
      expect(trottinetteVersionBand(price)).toBe(band);
    });
  }
  it('clamps negatives to the bottom band', () => {
    expect(trottinetteVersionBand(-100)).toBe('8181');
  });
});

describe('stationnementOption — full mapping (live-verified)', () => {
  it('garage_box → G + label', () => {
    expect(stationnementOption('garage_box')).toEqual({
      label: 'Garage ou box fermé',
      value: 'G',
    });
  });
  it('parking_prive_clos → P', () => {
    expect(stationnementOption('parking_prive_clos').value).toBe('P');
  });
  it('parking_prive_non_clos → O (Parking ouvert — closest semantic match)', () => {
    expect(stationnementOption('parking_prive_non_clos').value).toBe('O');
  });
  it('rue → V (Voie publique)', () => {
    expect(stationnementOption('rue').value).toBe('V');
  });
});

describe('PROFESSION_VALUE — full mapping (live-verified)', () => {
  it('employe_prive → 125 (the default — Achraf)', () => {
    expect(PROFESSION_VALUE.employe_prive).toBe('125');
    expect(PROFESSION_EMPLOYE_SECTEUR_PRIVE).toBe('125');
  });
  it('employe_public → 126', () => {
    expect(PROFESSION_VALUE.employe_public).toBe('126');
  });
  it('etudiant → 108', () => {
    expect(PROFESSION_VALUE.etudiant).toBe('108');
  });
  it('retraite → 109', () => {
    expect(PROFESSION_VALUE.retraite).toBe('109');
  });
  it('sans_profession → 130', () => {
    expect(PROFESSION_VALUE.sans_profession).toBe('130');
  });
});

describe('Devis-tab constants', () => {
  it('CIVILITE_VALUE maps monsieur → M., madame → MME', () => {
    expect(CIVILITE_VALUE.monsieur).toBe('M.');
    expect(CIVILITE_VALUE.madame).toBe('MME');
  });
  it('phone widget defaults to MOBILE + PERSO + FR', () => {
    expect(PHONE_TYPE_MOBILE).toBe('MOBILE');
    expect(PHONE_USAGE_PERSO).toBe('PERSO');
    expect(PHONE_COUNTRY_FR).toBe('FR');
  });
  it('email role defaults to ADMIN (Gestion)', () => {
    expect(EMAIL_ROLE_GESTION).toBe('ADMIN');
  });
});

describe('Garanties — formule + fractionnement labels', () => {
  it('formuleLabel returns the verbatim French label for each tier', () => {
    expect(formuleLabel('tiers_illimite')).toBe('Tiers illimité');
    expect(formuleLabel('vol_incendie')).toBe('Tiers illimité + Vol Incendie');
    expect(formuleLabel('dommages_tous_accidents')).toBe('Dommages tous accidents');
  });
  it('fractionnementLabel returns Mensuel / Annuel', () => {
    expect(fractionnementLabel('mensuel')).toBe('Mensuel');
    expect(fractionnementLabel('annuel')).toBe('Annuel');
  });
});

describe('clampCommissionPct', () => {
  it('clamps below-band to 9', () => {
    expect(clampCommissionPct(-5)).toBe(9);
    expect(clampCommissionPct(0)).toBe(9);
    expect(clampCommissionPct(8.4)).toBe(9);
  });
  it('clamps above-band to 22', () => {
    expect(clampCommissionPct(99)).toBe(22);
    expect(clampCommissionPct(23)).toBe(22);
  });
  it('rounds and passes through valid values', () => {
    expect(clampCommissionPct(15)).toBe(15);
    expect(clampCommissionPct(15.4)).toBe(15);
    expect(clampCommissionPct(15.6)).toBe(16);
  });
  it('defaults to 9 when undefined', () => {
    expect(clampCommissionPct(undefined)).toBe(9);
  });
});

describe('Garanties closing controls (M8.T7 B1, live-verified 2026-06-11)', () => {
  it('pins the formule radio group name', () => {
    expect(FORMULE_RADIO_NAME).toBe('codeFormuleSelected');
  });
  it('pins the formule radio values NV10/NV20/NV30', () => {
    expect(FORMULE_CODE.tiers_illimite).toBe('NV10');
    expect(FORMULE_CODE.vol_incendie).toBe('NV20');
    expect(FORMULE_CODE.dommages_tous_accidents).toBe('NV30');
  });
  it('pins the commission input id (id === name on the live portal)', () => {
    expect(COMMISSION_INPUT_ID).toBe('garantieTauxCommissionEffectif');
  });
  it('pins the fractionnement select name', () => {
    expect(FRACTIONNEMENT_SELECT_NAME).toBe('mouvement.codeFractionnement');
  });
  it('pins the fractionnement option values (M=Mensuel, A=Annuel)', () => {
    expect(FRACTIONNEMENT_CODE.mensuel).toBe('M');
    expect(FRACTIONNEMENT_CODE.annuel).toBe('A');
  });
  it("pins the frais-comptant popup id prefix (Maxance's own typo)", () => {
    expect(COMPTANT_POPUP_ID_PREFIX).toBe('commptant_');
  });
  it('FRAIS_COMPTANT_REGEX matches the live popup text shape', () => {
    const m = FRAIS_COMPTANT_REGEX.exec(
      '30.00 (Frais de gestion) + 0.39 (Commission) + 17.00 (Frais comptant) + 4.65 (Taxes)',
    );
    expect(m?.[1]).toBe('17.00');
  });
});

describe('parseFraisComptant', () => {
  it('extracts the EUR amount from the commptant popup text', () => {
    expect(
      parseFraisComptant('30.00 (Frais de gestion) + 17.00 (Frais comptant) + 4.65 (Taxes)'),
    ).toBe(17);
  });
  it('accepts a comma decimal separator', () => {
    expect(parseFraisComptant('17,50 (Frais comptant)')).toBe(17.5);
  });
  it('returns null on no match / null / empty', () => {
    expect(parseFraisComptant('30.00 (Frais de gestion)')).toBeNull();
    expect(parseFraisComptant(null)).toBeNull();
    expect(parseFraisComptant('')).toBeNull();
    expect(parseFraisComptant(undefined)).toBeNull();
  });
});

describe('Date formatting', () => {
  it('formatDateFr renders dd/mm/yyyy with leading zeros', () => {
    expect(formatDateFr(new Date(2026, 0, 5))).toBe('05/01/2026');
    expect(formatDateFr(new Date(1990, 5, 12))).toBe('12/06/1990');
  });
  it('formatIsoDateFr accepts plain YYYY-MM-DD', () => {
    expect(formatIsoDateFr('2026-01-15')).toBe('15/01/2026');
  });
  it('formatIsoDateFr accepts full ISO 8601', () => {
    expect(formatIsoDateFr('1990-06-12T00:00:00Z')).toBe('12/06/1990');
  });
  it('formatIsoDateFr throws on malformed input', () => {
    expect(() => formatIsoDateFr('not-a-date')).toThrow(/maxance_invalid_iso_date/);
    expect(() => formatIsoDateFr('26-01-15')).toThrow(/maxance_invalid_iso_date/);
  });
});

describe('Courrier popup constants (live-verified 2026-05-23)', () => {
  it('iframe id is window_nvCourrier (same-origin, contentDocument accessible)', () => {
    expect(COURRIER_POPUP_IFRAME_ID).toBe('window_nvCourrier');
  });
  it('popup URL path is listerModeleLettreAutorise.do', () => {
    expect(COURRIER_POPUP_URL_PATH).toBe('/Proximeo/listerModeleLettreAutorise.do');
  });
  it('fallback coords match the M8.T6 live captures', () => {
    expect(COURRIER_POPUP_FALLBACK_COORDS.envelopeIcon).toEqual([86, 33]);
    expect(COURRIER_POPUP_FALLBACK_COORDS.closeX).toEqual([474, 10]);
    expect(COURRIER_POPUP_FALLBACK_COORDS.mailComposer.adresseInput).toEqual([290, 50]);
    expect(COURRIER_POPUP_FALLBACK_COORDS.mailComposer.objetInput).toEqual([290, 95]);
    expect(COURRIER_POPUP_FALLBACK_COORDS.mailComposer.envoyerButton).toEqual([31, 115]);
  });
});

describe('URL signatures', () => {
  it('PROXIMEO_SSO_URL matches the live-verified endpoint', () => {
    expect(PROXIMEO_SSO_URL).toBe(
      'https://www.maxance.com/Proximeo/ConnexionCourtierSSOCallback.do',
    );
  });
  it('exposes path signatures for dashboard / proximeo home / edition à imprimer', () => {
    expect(PROXIMEO_URL_SIGNATURES.dashboard).toBe('/MaXance/');
    expect(PROXIMEO_URL_SIGNATURES.proximeoHome).toBe('/Proximeo/ConnexionCourtierSSOCallback.do');
    expect(PROXIMEO_URL_SIGNATURES.editionImprimer).toBe(
      '/Proximeo/souscriptionDevisValiderFinaleMoto.do',
    );
  });
});
