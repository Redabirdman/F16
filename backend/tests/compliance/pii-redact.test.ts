/**
 * Unit tests for the PII redactor (option C / Compliance Sentry V0).
 *
 * Pure-function tests — no DB, no LLM. Runs in <10ms.
 *
 * Coverage:
 *   - email shapes (simple, plus-tagged, subdomain)
 *   - French phone shapes (E.164, national, dotted, spaced, dashed)
 *   - IBAN with checksum filtering (valid French IBAN vs random shape)
 *   - 16-digit credit card with Luhn filtering (real-test PAN vs lookalike)
 *   - mixed text with multiple PII categories
 *   - report counts + total
 *   - containsPII convenience
 */
import { describe, expect, it } from 'vitest';
import { redactPII, containsPII } from '../../src/compliance/pii-redact.js';

describe('redactPII — email', () => {
  it('redacts a simple email', () => {
    const { text, report } = redactPII('Contactez-moi à jean.dupont@example.fr svp');
    expect(text).toBe('Contactez-moi à [EMAIL] svp');
    expect(report.counts.email).toBe(1);
    expect(report.total).toBe(1);
  });

  it('redacts plus-tagged + subdomain', () => {
    const { text } = redactPII('me+invoice@mail.assuryal.fr');
    expect(text).toBe('[EMAIL]');
  });

  it('redacts multiple emails in one message', () => {
    const { text, report } = redactPII('a@b.fr et c@d.com');
    expect(text).toBe('[EMAIL] et [EMAIL]');
    expect(report.counts.email).toBe(2);
  });
});

describe('redactPII — French phone shapes', () => {
  const cases: Array<[string, string]> = [
    ['Mon numéro est 06 12 34 56 78', 'Mon numéro est [PHONE]'],
    ['Numéro : 0612345678', 'Numéro : [PHONE]'],
    ['Appelez le 06.12.34.56.78', 'Appelez le [PHONE]'],
    ['06-12-34-56-78', '[PHONE]'],
    ['+33 6 12 34 56 78', '[PHONE]'],
    ['+33612345678', '[PHONE]'],
    ['0033 6 12 34 56 78', '[PHONE]'],
  ];
  for (const [input, expected] of cases) {
    it(`redacts ${JSON.stringify(input)}`, () => {
      const { text, report } = redactPII(input);
      expect(text).toBe(expected);
      expect(report.counts.phone).toBe(1);
    });
  }

  it('does NOT match a 10-digit number that does not start with 0/+33', () => {
    const { text, report } = redactPII('Référence client 1234567890');
    expect(text).toBe('Référence client 1234567890');
    expect(report.counts.phone).toBe(0);
  });

  it('does NOT match a 5-digit postal code', () => {
    const { text, report } = redactPII('Code postal 75001');
    expect(report.counts.phone).toBe(0);
    expect(text).toBe('Code postal 75001');
  });
});

describe('redactPII — IBAN', () => {
  // Real, well-formed French test IBAN (passes ISO 13616 checksum).
  const VALID_FR = 'FR14 2004 1010 0505 0001 3M02 606';

  it('redacts a valid French IBAN', () => {
    const { text, report } = redactPII(`IBAN : ${VALID_FR} merci`);
    expect(text).toBe('IBAN : [IBAN] merci');
    expect(report.counts.iban).toBe(1);
  });

  it('does NOT redact a wrong-checksum IBAN (filters false positives)', () => {
    const { text, report } = redactPII('FR99 2004 1010 0505 0001 3M02 606');
    expect(report.counts.iban).toBe(0);
    expect(text).toContain('FR99');
  });

  it('redacts IBAN even when concatenated without spaces', () => {
    const { text, report } = redactPII('FR1420041010050500013M02606');
    expect(text).toBe('[IBAN]');
    expect(report.counts.iban).toBe(1);
  });
});

describe('redactPII — credit card', () => {
  // Visa test PAN — passes Luhn.
  const VALID_CC = '4111 1111 1111 1111';

  it('redacts a Luhn-valid 16-digit card with spaces', () => {
    const { text, report } = redactPII(`Carte ${VALID_CC} expire 12/27`);
    expect(text).toBe('Carte [CC] expire 12/27');
    expect(report.counts.cc).toBe(1);
  });

  it('redacts a Luhn-valid 16-digit card with dashes', () => {
    const { text } = redactPII('4111-1111-1111-1111');
    expect(text).toBe('[CC]');
  });

  it('does NOT redact a 16-digit string that fails Luhn (e.g. order id)', () => {
    const { text, report } = redactPII('Commande 1234 5678 9012 3456');
    expect(report.counts.cc).toBe(0);
    expect(text).toContain('1234');
  });
});

describe('redactPII — mixed text', () => {
  it('redacts every category in one pass + reports counts correctly', () => {
    const input =
      'Voici mes coordonnées : email contact@assuryal.fr, tél 06 12 34 56 78, ' +
      'IBAN FR14 2004 1010 0505 0001 3M02 606, et ma carte 4111 1111 1111 1111.';
    const { text, report } = redactPII(input);
    expect(text).toContain('[EMAIL]');
    expect(text).toContain('[PHONE]');
    expect(text).toContain('[IBAN]');
    expect(text).toContain('[CC]');
    expect(report.counts).toEqual({ email: 1, phone: 1, iban: 1, cc: 1 });
    expect(report.total).toBe(4);
  });

  it('returns the original text + zero counts when no PII is present', () => {
    const input = 'Bonjour, je voudrais un devis pour ma trottinette électrique.';
    const { text, report } = redactPII(input);
    expect(text).toBe(input);
    expect(report.total).toBe(0);
  });
});

describe('containsPII', () => {
  it('returns true when any category matches', () => {
    expect(containsPII('mon mail est x@y.fr')).toBe(true);
  });
  it('returns false on clean text', () => {
    expect(containsPII('Bonjour, ça va ?')).toBe(false);
  });
});
