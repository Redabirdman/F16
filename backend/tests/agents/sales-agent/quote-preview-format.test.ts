/**
 * Pure-function tests for the French quote-preview / quote-failed message
 * formatters used by SalesAgent.handleQuotePreviewReady / handleQuoteFailed.
 *
 * No DB, no Anthropic, no Redis. Each case asserts the exact text the
 * customer would see so Achraf can lock the wording once and we don't
 * silently drift it.
 */
import { describe, expect, it } from 'vitest';
import {
  formatQuotePreviewMessage,
  formatQuoteFailedMessage,
  formatQuoteReadyMessage,
} from '../../../src/agents/sales-agent/agent.js';

describe('formatQuotePreviewMessage', () => {
  it('formats the canonical Tiers Illimité mensuel quote', () => {
    const out = formatQuotePreviewMessage({
      firstName: 'Sami',
      monthly: 18.95,
      annual: 90.85,
      formule: 'tiers_illimite',
      quoteId: 'abc12345-6789-4abc-def0-123456789012',
    });
    expect(out).toContain('Bonjour Sami,');
    expect(out).toContain('Voici votre devis trottinette :');
    expect(out).toContain('• Mensuel : 18,95 €');
    expect(out).toContain('• Annuel : 90,85 €');
    expect(out).toContain('• Formule : Tiers Illimité');
    expect(out).toContain('Souhaitez-vous que je vous envoie le devis officiel par mail ?');
    expect(out).toContain('(réf #abc12345)'); // 8-char prefix
  });

  it('handles missing monthly (annual-only quotes)', () => {
    const out = formatQuotePreviewMessage({
      firstName: 'Alex',
      annual: 142.5,
      formule: 'tiers_illimite',
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out).not.toContain('Mensuel :');
    expect(out).toContain('• Annuel : 142,50 €');
  });

  it('handles missing annual (monthly-only quotes)', () => {
    const out = formatQuotePreviewMessage({
      firstName: 'Maya',
      monthly: 9.99,
      formule: 'tiers_illimite',
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out).toContain('• Mensuel : 9,99 €');
    expect(out).not.toContain('Annuel :');
  });

  it('capitalizes a lowercase firstName in the greeting (live 2026-07-02)', () => {
    const out = formatQuotePreviewMessage({
      firstName: 'achraf',
      monthly: 6.51,
      formule: 'tiers_illimite',
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out.startsWith('Bonjour Achraf,')).toBe(true);
  });

  it('uses generic greeting when firstName is empty', () => {
    const out = formatQuotePreviewMessage({
      firstName: '',
      monthly: 10,
      formule: 'tiers_illimite',
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out.startsWith('Bonjour,')).toBe(true);
    expect(out).not.toMatch(/Bonjour\s+,/);
  });

  it.each([
    ['vol_incendie', 'Tiers Illimité + Vol & Incendie'],
    ['dommages_tous_accidents', 'Tous Risques'],
    ['tiers_illimite', 'Tiers Illimité'],
  ] as const)('renders formule label for %s as %s', (formule, expected) => {
    const out = formatQuotePreviewMessage({
      firstName: 'Test',
      monthly: 1,
      formule,
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out).toContain(`• Formule : ${expected}`);
  });

  it('renders the Achraf sales script when formulePricing is present (2026-07-02)', () => {
    // Numbers verbatim from the live 2026-07-02 NVEI garanties screenshot.
    const out = formatQuotePreviewMessage({
      firstName: 'Achraf',
      monthly: 6.51,
      annual: 78.2,
      formule: 'tiers_illimite',
      quoteId: 'abc12345-6789-4abc-def0-123456789012',
      formulePricing: [
        {
          formule: 'tiers_illimite',
          annualPremiumEur: 66.2,
          comptantEur: 22.45,
          termeSuivantEur: 6.51,
          coutAnnuelBrutEur: 78.2,
        },
        { formule: 'vol_incendie', annualPremiumEur: 141.66, termeSuivantEur: 12.87 },
        { formule: 'dommages_tous_accidents', annualPremiumEur: 211.45, termeSuivantEur: 18.73 },
      ],
      addOns: { assistanceAnnualEur: 13.04, garantiePersonnelleAnnualEur: 17.72 },
    });
    expect(out).toContain('Bonjour Achraf,');
    expect(out).toContain('Voici vos tarifs trottinette (par mois) :');
    // The 3 formules as MONTHLIES (terme suivant), in the canonical order.
    expect(out).toContain('• Tiers Illimité : 6,51 €/mois');
    expect(out).toContain('• Tiers Illimité + Vol & Incendie : 12,87 €/mois');
    expect(out).toContain('• Tous Risques : 18,73 €/mois');
    // The ANNUAL premium must NEVER be presented as a monthly price.
    expect(out).not.toContain('66,20 €/mois');
    // Add-ons at annual/12 (13.04/12 = 1.09, 17.72/12 = 1.48).
    expect(out).toContain('• Assistance Mobilité : +1,09 €/mois');
    expect(out).toContain('• Garantie Personnelle du Conducteur : +1,48 €/mois');
    // Pack recommendation = tiers monthly + both add-on monthlies.
    expect(out).toContain('💡 Notre conseil : Tiers Illimité + les 2 options');
    // 6.51 + 13.04/12 + 17.72/12 = 9.0733… → formatted 9,07 (unrounded sum).
    expect(out).toContain('9,07 €/mois');
    // First payment (comptant) of the requested formule.
    expect(out).toContain('Premier paiement : 22,45 €, puis mensualités.');
    expect(out).toContain('(réf #abc12345)');
  });

  it('falls back to the legacy body when formulePricing has no monthlies', () => {
    const out = formatQuotePreviewMessage({
      firstName: 'Sami',
      monthly: 6.51,
      formule: 'tiers_illimite',
      quoteId: 'abc12345-6789-4abc-def0-123456789012',
      formulePricing: [{ formule: 'tiers_illimite', annualPremiumEur: 66.2 }],
    });
    expect(out).toContain('Voici votre devis trottinette :');
    expect(out).toContain('• Mensuel : 6,51 €');
  });

  it('omits pack + options sections when addOns are absent', () => {
    const out = formatQuotePreviewMessage({
      firstName: 'Lina',
      formule: 'tiers_illimite',
      quoteId: 'abc12345-6789-4abc-def0-123456789012',
      formulePricing: [{ formule: 'tiers_illimite', termeSuivantEur: 6.51, comptantEur: 22.45 }],
    });
    expect(out).toContain('• Tiers Illimité : 6,51 €/mois');
    expect(out).not.toContain('Options ajoutables');
    expect(out).not.toContain('💡');
    expect(out).toContain('Premier paiement : 22,45 €');
  });

  it('uses French decimal comma + two decimals consistently', () => {
    const out = formatQuotePreviewMessage({
      firstName: 'X',
      monthly: 1234.5,
      annual: 9999,
      formule: 'tiers_illimite',
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out).toContain('1234,50 €');
    expect(out).toContain('9999,00 €');
  });
});

describe('formatQuoteReadyMessage', () => {
  it('confirms quote sent + includes devis number + email + ref tag', () => {
    const out = formatQuoteReadyMessage({
      firstName: 'Sami',
      pdfSentTo: 'sami@example.com',
      devisNumber: 'AB12345678',
      quoteId: 'abc12345-6789-4abc-def0-123456789012',
    });
    expect(out).toContain('Bonjour Sami,');
    expect(out).toContain("C'est envoyé !");
    expect(out).toContain('sami@example.com');
    expect(out).toContain('Référence du devis : AB12345678');
    expect(out).toContain('Vérifiez aussi vos spams');
    expect(out).toContain('(réf #abc12345 envoyé)'); // The "envoyé" marker is what
    // handleQuoteReady scans for to
    // detect already-sent.
  });

  it('falls back to generic greeting without firstName', () => {
    const out = formatQuoteReadyMessage({
      pdfSentTo: 'x@y.fr',
      devisNumber: 'X1',
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out.startsWith('Bonjour,')).toBe(true);
  });
});

describe('formatQuoteFailedMessage', () => {
  it('formats an apologetic French notice with the ref tag', () => {
    const out = formatQuoteFailedMessage({
      firstName: 'Sami',
      quoteId: 'abc12345-6789-4abc-def0-123456789012',
    });
    expect(out).toContain('Bonjour Sami,');
    expect(out).toContain("J'ai un petit souci technique pour finaliser votre devis trottinette.");
    expect(out).toContain('Un conseiller revient vers vous très rapidement.');
    expect(out).toContain('(réf #abc12345)');
    // Must NOT leak any internal jargon.
    expect(out).not.toMatch(/cloudflare|stagehand|playwright|auth0/i);
    expect(out).not.toMatch(/error/i);
  });

  it('falls back to generic greeting without firstName', () => {
    const out = formatQuoteFailedMessage({
      quoteId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    });
    expect(out.startsWith('Bonjour,')).toBe(true);
  });
});
