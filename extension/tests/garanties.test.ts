/**
 * Garanties closing controls — parse-helper unit tests (M8.T7 B1).
 *
 * Pure-text parsing only: the fractionnement summary row from the
 * Garanties tab's innerText and the "Frais comptant" line from the hidden
 * commptant_<code> popup. No DOM, no Chrome — the DOM-touching paths
 * (applyGarantiesConfig / extractComptantBreakdown) are exercised live.
 *
 * Sample strings mirror the 2026-06-11 live survey verbatim.
 */
import { describe, it, expect } from 'vitest';
import { parseFractionnementRow } from '../src/flows/garanties-controls.js';
import { parseFraisComptant } from '../src/maxance/selectors.js';

describe('parseFractionnementRow', () => {
  it('parses the live-verified single-line body text shape', () => {
    // Verbatim from the 2026-06-11 survey: the select renders its three
    // option labels, then comptant / terme suivant / coût annuel brut.
    const body =
      'Fractionnement Comptant Terme suivant Coût annuel brut** Mensuel Semestriel Annuel 21.58 7.97 95.71';
    expect(parseFractionnementRow(body)).toEqual({
      comptantEur: 21.58,
      termeSuivantEur: 7.97,
      coutAnnuelBrutEur: 95.71,
    });
  });

  it('tolerates newlines/tabs between the cells (innerText table render)', () => {
    const body =
      'Fractionnement\tComptant\tTerme suivant\tCoût annuel brut**\nMensuel\nSemestriel\nAnnuel\t25.99\t7.57\t90.85';
    expect(parseFractionnementRow(body)).toEqual({
      comptantEur: 25.99,
      termeSuivantEur: 7.57,
      coutAnnuelBrutEur: 90.85,
    });
  });

  it('accepts comma decimal separators', () => {
    const body = 'Mensuel Semestriel Annuel 21,58 7,97 95,71';
    expect(parseFractionnementRow(body)).toEqual({
      comptantEur: 21.58,
      termeSuivantEur: 7.97,
      coutAnnuelBrutEur: 95.71,
    });
  });

  it('returns {} when the row is absent / input empty', () => {
    expect(parseFractionnementRow('Formules de garanties Montant Tiers illimité 83.71')).toEqual(
      {},
    );
    expect(parseFractionnementRow('')).toEqual({});
    expect(parseFractionnementRow(null)).toEqual({});
    expect(parseFractionnementRow(undefined)).toEqual({});
  });
});

describe('parseFraisComptant (re-exported from the canonical selectors module)', () => {
  it('extracts the frais comptant from a realistic commptant_M popup text', () => {
    const popup =
      'Détail du comptant : 30.00 (Frais de gestion) + 0.39 (Commission) + 17.00 (Frais comptant) + 4.65 (Taxes)';
    expect(parseFraisComptant(popup)).toBe(17);
  });
  it('returns null when the line is missing', () => {
    expect(parseFraisComptant('Détail du comptant : 30.00 (Frais de gestion)')).toBeNull();
  });
});
