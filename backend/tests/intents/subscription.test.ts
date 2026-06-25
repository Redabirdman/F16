/**
 * Unit tests for the SUBSCRIPTION.* intent payloads (M8.T7 closing).
 *
 * Key invariant under test: bank PII (IBAN/BIC/titulaire) must NOT be
 * expressible in SUBSCRIPTION.REQUESTED — the schema only carries
 * `bankRef: 'customer'`, the operator reads the encrypted details from
 * the customer row.
 */
import { describe, it, expect } from 'vitest';
// Barrel import triggers all intent registrations (incl. subscription.ts).
import { validateIntentPayload } from '../../src/intents/index.js';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';

describe('SUBSCRIPTION.REQUESTED', () => {
  const base = {
    quoteId: QUOTE_ID,
    customerId: CUSTOMER_ID,
    leadId: LEAD_ID,
    devisNumber: 'DR0000971882',
    formule: 'tiers_illimite',
    fractionnement: 'mensuel',
    birthPlaceCity: 'Paris',
    bankRef: 'customer',
  };

  it('accepts a complete payload', () => {
    const parsed = validateIntentPayload('SUBSCRIPTION.REQUESTED', base) as typeof base;
    expect(parsed.devisNumber).toBe('DR0000971882');
    expect(parsed.formule).toBe('tiers_illimite');
    expect(parsed.bankRef).toBe('customer');
  });

  it('accepts a missing or null leadId', () => {
    const { leadId: _omit, ...withoutLead } = base;
    expect(() => validateIntentPayload('SUBSCRIPTION.REQUESTED', withoutLead)).not.toThrow();
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, leadId: null }),
    ).not.toThrow();
  });

  it.each(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents'] as const)(
    'accepts formule %s',
    (formule) => {
      expect(() =>
        validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, formule }),
      ).not.toThrow();
    },
  );

  it('rejects an unknown formule and fractionnement', () => {
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, formule: 'tous_risques' }),
    ).toThrow();
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, fractionnement: 'trimestriel' }),
    ).toThrow();
  });

  it('rejects empty devisNumber / birthPlaceCity and non-uuid ids', () => {
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, devisNumber: '' }),
    ).toThrow();
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, birthPlaceCity: '' }),
    ).toThrow();
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, quoteId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('rejects any bankRef other than the literal "customer" (PII discipline)', () => {
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', { ...base, bankRef: 'inline' }),
    ).toThrow();
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.REQUESTED', {
        ...base,
        bankRef: { iban: 'FR7630006000011234567890189' },
      }),
    ).toThrow();
  });
});

describe('SUBSCRIPTION.READY', () => {
  const base = {
    quoteId: QUOTE_ID,
    customerId: CUSTOMER_ID,
    souscripteurRef: 'T0001234',
    montantComptantEur: 52.04,
    fraisComptantEur: 17,
    fraisDossierTotalEur: 50,
    assuryalFraisEur: 33,
    paymentLinkUrl: 'https://buy.stripe.com/test_abc123',
    dryRun: false,
  };

  it('accepts a complete real-mode payload', () => {
    const parsed = validateIntentPayload('SUBSCRIPTION.READY', base) as typeof base;
    expect(parsed.assuryalFraisEur).toBe(33);
    expect(parsed.dryRun).toBe(false);
  });

  it('accepts a dryRun payload with the optional fields absent + null link', () => {
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.READY', {
        quoteId: QUOTE_ID,
        customerId: CUSTOMER_ID,
        fraisDossierTotalEur: 60,
        assuryalFraisEur: 43,
        paymentLinkUrl: null,
        dryRun: true,
      }),
    ).not.toThrow();
  });

  it('rejects negative amounts, a non-url link and a missing dryRun', () => {
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.READY', { ...base, assuryalFraisEur: -1 }),
    ).toThrow();
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.READY', { ...base, paymentLinkUrl: 'not a url' }),
    ).toThrow();
    const { dryRun: _omit, ...withoutDryRun } = base;
    expect(() => validateIntentPayload('SUBSCRIPTION.READY', withoutDryRun)).toThrow();
  });
});

describe('SUBSCRIPTION.FAILED', () => {
  const base = {
    quoteId: QUOTE_ID,
    customerId: CUSTOMER_ID,
    errorCode: 'maxance_subscription_wrong_state',
  };

  it('accepts minimal payload (screenshots optional)', () => {
    expect(() => validateIntentPayload('SUBSCRIPTION.FAILED', base)).not.toThrow();
  });

  it('accepts detail + screenshots in the QUOTE.FAILED shape', () => {
    const parsed = validateIntentPayload('SUBSCRIPTION.FAILED', {
      ...base,
      detail: 'tab was not on Garanties',
      screenshots: [{ step: 'garanties', url: 'http://127.0.0.1:8080/v1/static/x.png' }],
    }) as { screenshots: Array<{ step: string; url: string }> };
    expect(parsed.screenshots).toHaveLength(1);
    expect(parsed.screenshots[0]!.step).toBe('garanties');
  });

  it('rejects an empty errorCode and malformed screenshots', () => {
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.FAILED', { ...base, errorCode: '' }),
    ).toThrow();
    expect(() =>
      validateIntentPayload('SUBSCRIPTION.FAILED', { ...base, screenshots: [{ step: 'x' }] }),
    ).toThrow();
  });
});
