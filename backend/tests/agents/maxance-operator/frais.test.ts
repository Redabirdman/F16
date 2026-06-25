/**
 * Unit tests for the frais de dossier business rules (M8.T7 closing).
 * Total per formule − Maxance's comptant portion = Assuryal's payment-link
 * amount, floored at 0, rounded to the cent.
 */
import { describe, it, expect } from 'vitest';
import {
  FRAIS_DOSSIER_TOTAL_EUR,
  computeAssuryalFrais,
} from '../../../src/agents/maxance-operator/frais.js';

describe('FRAIS_DOSSIER_TOTAL_EUR', () => {
  it('carries the locked totals per formule (50/60/65)', () => {
    expect(FRAIS_DOSSIER_TOTAL_EUR.tiers_illimite).toBe(50);
    expect(FRAIS_DOSSIER_TOTAL_EUR.vol_incendie).toBe(60);
    expect(FRAIS_DOSSIER_TOTAL_EUR.dommages_tous_accidents).toBe(65);
  });
});

describe('computeAssuryalFrais', () => {
  it('returns total − fraisComptant for each formule', () => {
    // Achraf's worked example: 50 total, 17 collected by Maxance → 33 Assuryal.
    expect(computeAssuryalFrais('tiers_illimite', 17)).toBe(33);
    expect(computeAssuryalFrais('vol_incendie', 17)).toBe(43);
    expect(computeAssuryalFrais('dommages_tous_accidents', 17)).toBe(48);
  });

  it('handles a zero comptant portion (full amount via the link)', () => {
    expect(computeAssuryalFrais('tiers_illimite', 0)).toBe(50);
  });

  it('floors at 0 when the portal frais meets or exceeds our total', () => {
    expect(computeAssuryalFrais('tiers_illimite', 50)).toBe(0);
    expect(computeAssuryalFrais('tiers_illimite', 72.5)).toBe(0);
  });

  it('rounds to the cent', () => {
    expect(computeAssuryalFrais('tiers_illimite', 16.999)).toBe(33);
    expect(computeAssuryalFrais('tiers_illimite', 17.005)).toBe(33); // 32.995 rounds half-up
    expect(computeAssuryalFrais('tiers_illimite', 17.004)).toBe(33); // 32.996 → 33.00
    expect(computeAssuryalFrais('tiers_illimite', 17.014)).toBe(32.99); // 32.986 → 32.99
    expect(computeAssuryalFrais('vol_incendie', 0.1)).toBe(59.9);
  });

  it('throws on non-finite or negative fraisComptantEur', () => {
    expect(() => computeAssuryalFrais('tiers_illimite', Number.NaN)).toThrow(/invalid/);
    expect(() => computeAssuryalFrais('tiers_illimite', Number.POSITIVE_INFINITY)).toThrow(
      /invalid/,
    );
    expect(() => computeAssuryalFrais('tiers_illimite', -1)).toThrow(/invalid/);
  });

  it('throws on an unknown formule smuggled past the types', () => {
    expect(() =>
      computeAssuryalFrais('tous_risques' as Parameters<typeof computeAssuryalFrais>[0], 10),
    ).toThrow(/unknown formule/);
  });
});
