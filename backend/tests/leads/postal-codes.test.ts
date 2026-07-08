/**
 * French postal-code index tests (2026-07-08) — pure, no DB.
 *
 * The committed asset comes from La Poste's official base; these pin the
 * live cases from today's runs + the helper's shape contract.
 */
import { describe, expect, it } from 'vitest';
import { checkFrenchPostalCode, communesForPostalCode } from '../../src/leads/postal-codes.js';

describe('checkFrenchPostalCode', () => {
  it('accepts real codes (Paris, Limoges multi-commune case)', () => {
    expect(checkFrenchPostalCode('75001')).toBe('valid');
    expect(checkFrenchPostalCode('87100')).toBe('valid');
  });

  it("rejects today's live fakes 75091 and 75030", () => {
    expect(checkFrenchPostalCode('75091')).toBe('invalid');
    expect(checkFrenchPostalCode('75030')).toBe('invalid');
  });

  it('rejects malformed input outright', () => {
    expect(checkFrenchPostalCode('7500')).toBe('invalid');
    expect(checkFrenchPostalCode('ABCDE')).toBe('invalid');
    expect(checkFrenchPostalCode('750011')).toBe('invalid');
  });
});

describe('communesForPostalCode', () => {
  it('returns commune names for a valid code and [] for an invalid one', () => {
    expect(communesForPostalCode('87100')).toContain('LIMOGES');
    expect(communesForPostalCode('75091')).toEqual([]);
  });
});
