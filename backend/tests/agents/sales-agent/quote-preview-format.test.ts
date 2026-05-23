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
