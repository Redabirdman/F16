/**
 * Unit tests for src/lib/iban.ts — pure-function IBAN validation/normalize/mask.
 * Valid fixtures are the published ISO 13616 / ECBS example IBANs (not real
 * accounts).
 */
import { describe, it, expect } from 'vitest';
import { validateIban, normalizeIban, maskIban } from '../../src/lib/iban.js';

// Published example IBANs with valid checksums.
const VALID = {
  FR: 'FR1420041010050500013M02606',
  DE: 'DE89370400440532013000',
  BE: 'BE68539007547034',
  ES: 'ES9121000418450200051332',
  IT: 'IT60X0542811101000000123456',
  GB: 'GB29NWBK60161331926819',
  NL: 'NL91ABNA0417164300',
  MA: 'MA64011519000001205000534921',
};

describe('normalizeIban', () => {
  it('strips spaces and uppercases', () => {
    expect(normalizeIban('fr14 2004 1010 0505 0001 3m02 606')).toBe(VALID.FR);
  });

  it('strips tabs/newlines and interior runs of whitespace', () => {
    expect(normalizeIban(' FR14\t2004 1010\n0505 0001 3M02 606 ')).toBe(VALID.FR);
  });

  it('is idempotent', () => {
    expect(normalizeIban(normalizeIban(VALID.DE))).toBe(VALID.DE);
  });
});

describe('validateIban', () => {
  it.each(Object.entries(VALID))('accepts a valid %s IBAN', (_cc, iban) => {
    expect(validateIban(iban)).toBe(true);
  });

  it('accepts spaced + lowercase input (normalizes first)', () => {
    expect(validateIban('fr14 2004 1010 0505 0001 3m02 606')).toBe(true);
  });

  it('rejects a single-digit corruption (checksum)', () => {
    // Flip one BBAN digit — mod-97 must catch it.
    expect(validateIban('FR1420041010050500013M02607')).toBe(false);
  });

  it('rejects transposed characters (checksum)', () => {
    expect(validateIban('DE89370400440532013100')).toBe(false);
  });

  it('rejects wrong check digits', () => {
    expect(validateIban('FR0020041010050500013M02606')).toBe(false);
  });

  it('rejects wrong length for a known country', () => {
    expect(validateIban('FR1420041010050500013M0260')).toBe(false); // 26, FR needs 27
    expect(validateIban(`${VALID.FR}1`)).toBe(false); // 28
  });

  it('rejects structurally invalid input', () => {
    expect(validateIban('')).toBe(false);
    expect(validateIban('NOT-AN-IBAN')).toBe(false);
    expect(validateIban('1234567890123456')).toBe(false); // no country code
    expect(validateIban('FRAA20041010050500013M02606')).toBe(false); // letters as check digits
    expect(validateIban('FR14')).toBe(false); // below min length
    expect(validateIban('FR14' + '0'.repeat(40))).toBe(false); // above max length
  });

  it('applies the generic checksum to unknown country codes', () => {
    // XK (Kosovo) is absent from our length registry but checksum-valid.
    expect(validateIban('XK051212012345678906')).toBe(true);
    expect(validateIban('XK051212012345678907')).toBe(false);
  });
});

describe('maskIban', () => {
  it('keeps country + check digits and the last 4 only', () => {
    expect(maskIban(VALID.FR)).toBe('FR14 •••• 2606');
    expect(maskIban('FR7630006000011234567890189')).toBe('FR76 •••• 0189');
  });

  it('masks spaced/lowercase input identically', () => {
    expect(maskIban('fr76 3000 6000 0112 3456 7890 189')).toBe('FR76 •••• 0189');
  });

  it('never echoes the middle of the IBAN', () => {
    const masked = maskIban(VALID.DE);
    expect(masked).toBe('DE89 •••• 3000');
    expect(masked).not.toContain('37040044');
  });

  it('degrades to a full mask on degenerate input', () => {
    expect(maskIban('FR76')).toBe('••••');
    expect(maskIban('')).toBe('••••');
  });
});
