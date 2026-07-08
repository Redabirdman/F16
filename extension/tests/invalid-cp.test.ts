/**
 * Invalid-postal-code classifier (2026-07-08, Achraf's CP 75091 live run).
 *
 * Pure-core test, same posture as maintenance.test.ts: the DOM probe
 * (visibleAlerteText) and the fail-fast throw are covered by live runs.
 */
import { describe, expect, it } from 'vitest';
import { isInvalidCpSituation } from '../src/flows/quote-preview.js';

const VILLE_ALERTE = `ALERTE La valeur du champ 'Ville' est obligatoire. OK`;

describe('isInvalidCpSituation', () => {
  it('flags no-commune + Ville-obligatoire ALERTE', () => {
    expect(isInvalidCpSituation('no_options', VILLE_ALERTE)).toBe(true);
    expect(isInvalidCpSituation('timeout', VILLE_ALERTE)).toBe(true);
  });

  it('does NOT flag a healthy zonier even with an ALERTE on screen', () => {
    expect(isInvalidCpSituation('ok', VILLE_ALERTE)).toBe(false);
    expect(isInvalidCpSituation('selected:75011|75111|PARIS 11', VILLE_ALERTE)).toBe(false);
  });

  it('does NOT flag slow AJAX without the Ville ALERTE (first pass)', () => {
    expect(isInvalidCpSituation('timeout', '')).toBe(false);
    expect(isInvalidCpSituation('no_options', 'La vitesse du NVEI doit être limitée')).toBe(false);
  });

  it('requires BOTH the Ville word and obligatoire', () => {
    expect(isInvalidCpSituation('timeout', `Le champ 'Téléphone' est obligatoire`)).toBe(false);
  });
});
