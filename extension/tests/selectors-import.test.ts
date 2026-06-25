/**
 * Selectors smoke test (M8.T8 phase 2).
 *
 * Asserts that the extension can resolve its local
 * `src/maxance/selectors.ts` and that the canonical Maxance values
 * (Marque, Version bands, Civilité codes, etc.) are present and correct.
 * The selectors module is the SINGLE SOURCE OF TRUTH for the Maxance UI
 * mapping; this guards against accidental edits to those live-verified
 * constants.
 *
 * (Historically these constants lived in a separate Playwright-driver
 * workspace and were imported cross-workspace; that workspace has been
 * removed and the selectors now live here in the extension.)
 */
import { describe, it, expect } from 'vitest';
import {
  MARQUE_TROTTINETTE,
  CYLINDREE_TROTTINETTE,
  PROFESSION_VALUE,
  CIVILITE_VALUE,
  trottinetteVersionBand,
  stationnementOption,
  formatIsoDateFr,
  COURRIER_POPUP_IFRAME_ID,
} from '../src/maxance/selectors.js';

describe('maxance selectors (extension/src/maxance/selectors)', () => {
  it('imports the verified Marque + Cylindrée constants', () => {
    expect(MARQUE_TROTTINETTE).toBe('TROTTINETTE');
    expect(CYLINDREE_TROTTINETTE).toBe('25');
  });

  it('imports the full PROFESSION_VALUE map', () => {
    expect(PROFESSION_VALUE.employe_prive).toBe('125');
    expect(PROFESSION_VALUE.etudiant).toBe('108');
  });

  it('imports CIVILITE_VALUE for the Devis tab', () => {
    expect(CIVILITE_VALUE.monsieur).toBe('M.');
    expect(CIVILITE_VALUE.madame).toBe('MME');
  });

  it('imports the pure Version-band function', () => {
    expect(trottinetteVersionBand(350)).toBe('8181');
    expect(trottinetteVersionBand(600)).toBe('8182');
  });

  it('imports stationnementOption with both label and value', () => {
    const s = stationnementOption('garage_box');
    expect(s).toEqual({ label: 'Garage ou box fermé', value: 'G' });
  });

  it('imports the ISO-date formatter (extension-side equivalent of formatDateFr)', () => {
    expect(formatIsoDateFr('2026-01-15')).toBe('15/01/2026');
  });

  it('imports the Courrier popup iframe id (live-verified, M8.T8)', () => {
    expect(COURRIER_POPUP_IFRAME_ID).toBe('window_nvCourrier');
  });
});
