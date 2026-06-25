/**
 * Subscription closing flow — parse-helper unit tests (M8.T7 B3).
 *
 * Pure-text parsing only: the "Comptant à régler" block from the Coordonnées +
 * bancaires page body text. No DOM, no Chrome — the DOM-touching paths
 * (the MAIN-world fill + the doSubmitConfirm submit) are exercised live at P6.
 *
 * Sample strings mirror Achraf's screenshot 10/11 figures verbatim.
 */
import { describe, it, expect } from 'vitest';
import { parseSubscriptionComptant } from '../src/flows/subscription.js';

describe('parseSubscriptionComptant', () => {
  it('parses the full Comptant à régler block (Achraf screenshot 10, Mensuel)', () => {
    const body =
      'Comptant à régler Frais de gestion 30.00 € Commission 0.39 € Frais de dossier 17.00 € Comptant dû 52.04 €';
    expect(parseSubscriptionComptant(body)).toEqual({
      fraisGestionEur: 30,
      commissionEur: 0.39,
      fraisDossierEur: 17,
      comptantDuEur: 52.04,
    });
  });

  it('accepts comma decimal separators and newlines between cells', () => {
    const body =
      'Frais de gestion\n30,00 €\nCommission\n0,39 €\nFrais de dossier\n17,00 €\nComptant dû\n52,04 €';
    expect(parseSubscriptionComptant(body)).toEqual({
      fraisGestionEur: 30,
      commissionEur: 0.39,
      fraisDossierEur: 17,
      comptantDuEur: 52.04,
    });
  });

  it('returns nulls for missing lines / empty input', () => {
    expect(parseSubscriptionComptant('Comptant à régler Frais de gestion 30.00 €')).toEqual({
      fraisGestionEur: 30,
      commissionEur: null,
      fraisDossierEur: null,
      comptantDuEur: null,
    });
    expect(parseSubscriptionComptant('')).toEqual({
      fraisGestionEur: null,
      commissionEur: null,
      fraisDossierEur: null,
      comptantDuEur: null,
    });
    expect(parseSubscriptionComptant(null)).toEqual({
      fraisGestionEur: null,
      commissionEur: null,
      fraisDossierEur: null,
      comptantDuEur: null,
    });
  });
});
