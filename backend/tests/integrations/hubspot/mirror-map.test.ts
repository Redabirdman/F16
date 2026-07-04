import { describe, it, expect } from 'vitest';
import {
  stageKeyForStatus,
  buildContactProps,
  buildDealProps,
  type MirrorInput,
} from '../../../src/integrations/hubspot/mirror-map.js';

function base(): MirrorInput {
  return {
    lead: {
      id: 'lead-1',
      status: 'new',
      source: 'meta',
      productLine: 'scooter',
      score: 80,
      preferredChannel: 'call',
      preferredTime: 'matin',
    },
    customer: {
      fullName: 'Achraf Mortady',
      email: 'a@example.fr',
      phone: '+33612345678',
      address: JSON.stringify({
        line1: '12 Rue de la Roquette',
        city: 'Paris',
        postalCode: '75011',
      }),
      vehicle: { brand: 'Xiaomi', model: 'Pro 2' },
    },
    latestQuote: null,
  };
}

describe('stageKeyForStatus', () => {
  it('maps each lead status to a stage key', () => {
    expect(stageKeyForStatus('new')).toBe('nouveau');
    expect(stageKeyForStatus('scored')).toBe('nouveau');
    expect(stageKeyForStatus('qualifying')).toBe('qualifie');
    expect(stageKeyForStatus('quoting')).toBe('devis_en_cours');
    expect(stageKeyForStatus('negotiating')).toBe('devis_envoye');
    expect(stageKeyForStatus('awaiting_payment')).toBe('attente_paiement');
    expect(stageKeyForStatus('closed_won')).toBe('gagne');
    expect(stageKeyForStatus('closed_lost')).toBe('perdu');
  });
  it('returns null for dormant (leave stage unchanged)', () => {
    expect(stageKeyForStatus('dormant')).toBeNull();
  });
});

describe('buildContactProps', () => {
  it('splits name + maps address + f16 fields, omitting missing', () => {
    const p = buildContactProps(base());
    expect(p.firstname).toBe('Achraf');
    expect(p.lastname).toBe('Mortady');
    expect(p.email).toBe('a@example.fr');
    expect(p.phone).toBe('+33612345678');
    expect(p.address).toBe('12 Rue de la Roquette');
    expect(p.city).toBe('Paris');
    expect(p.zip).toBe('75011');
    expect(p.f16_lead_id).toBe('lead-1');
    expect(p.f16_source).toBe('meta');
    expect(p.f16_preferred_channel).toBe('call');
    expect(p.f16_preferred_time).toBe('matin');
  });
  it('omits keys with no value (never sends empty strings)', () => {
    const input = base();
    input.customer.address = null;
    input.customer.phone = null;
    const p = buildContactProps(input);
    expect('address' in p).toBe(false);
    expect('city' in p).toBe(false);
    expect('phone' in p).toBe(false);
  });
});

describe('buildDealProps', () => {
  it('builds deal name + f16 fields; amount omitted with no quote', () => {
    const p = buildDealProps(base());
    expect(p.dealname).toBe('Trottinette — Achraf Mortady');
    expect(p.product_line).toBe('scooter');
    expect(p.f16_lead_id).toBe('lead-1');
    expect(p.f16_lead_score).toBe(80);
    expect(p.f16_vehicle).toBe('Xiaomi Pro 2');
    expect(p.f16_dormant).toBe('false');
    expect('amount' in p).toBe(false);
  });
  it('fills amount (annual premium) + monthly + comptant + devis number from the latest quote', () => {
    const input = base();
    input.latestQuote = {
      status: 'ready',
      monthlyPremium: '6.51',
      comptantDue: '90.85',
      annualPremium: '66.20',
      maxanceDevisNumber: 'DR0000973638',
      productVariant: 'tiers',
    };
    const p = buildDealProps(input);
    // 2026-07-04 decision: amount = ANNUAL premium (commissionable base),
    // the real monthly goes to f16_monthly_premium.
    expect(p.amount).toBe(66.2);
    expect(p.f16_monthly_premium).toBe(6.51);
    expect(p.f16_comptant_due).toBe(90.85);
    expect(p.f16_devis_number).toBe('DR0000973638');
  });
  it('falls back amount → comptantDue (coût annuel brut) for pre-migration rows without annualPremium', () => {
    const input = base();
    input.latestQuote = {
      status: 'ready',
      monthlyPremium: '6.51',
      comptantDue: '90.85',
      annualPremium: null,
      maxanceDevisNumber: null,
      productVariant: 'tiers',
    };
    const p = buildDealProps(input);
    // NEVER the monthly — an annual-ish figure or nothing.
    expect(p.amount).toBe(90.85);
    expect(p.f16_monthly_premium).toBe(6.51);
    expect(p.f16_comptant_due).toBe(90.85);
  });
  it('omits amount + f16_monthly_premium entirely when no price parsed', () => {
    const input = base();
    input.latestQuote = {
      status: 'ready',
      monthlyPremium: null,
      comptantDue: null,
      annualPremium: null,
      maxanceDevisNumber: 'DR0000973638',
      productVariant: 'tiers',
    };
    const p = buildDealProps(input);
    expect('amount' in p).toBe(false);
    expect('f16_monthly_premium' in p).toBe(false);
    expect('f16_comptant_due' in p).toBe(false);
    expect(p.f16_devis_number).toBe('DR0000973638');
  });
  it('sets f16_dormant true when status is dormant', () => {
    const input = base();
    input.lead.status = 'dormant';
    expect(buildDealProps(input).f16_dormant).toBe('true');
  });
});
