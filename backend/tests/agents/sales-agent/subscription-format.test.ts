/**
 * Pure-function tests for the French subscription-ready / subscription-failed
 * message formatters used by SalesAgent.handleSubscriptionReady /
 * handleSubscriptionFailed (M8.T7 closing, task D1).
 *
 * No DB, no Anthropic, no Redis. Asserts the exact closing wording the
 * customer sees — including the COMPLIANT frais framing (never "frais de
 * dossier" bluntly, never "taxe d'État") and the payment link.
 */
import { describe, expect, it } from 'vitest';
import {
  formatSubscriptionReadyMessage,
  formatSubscriptionFailedMessage,
} from '../../../src/agents/sales-agent/agent.js';

const QUOTE_ID = 'abc12345-6789-4abc-def0-123456789012';
const LINK = 'https://pay.stripe.com/test_abc123';

describe('formatSubscriptionReadyMessage', () => {
  it('builds the closing message with the real figures + the payment link', () => {
    const out = formatSubscriptionReadyMessage({
      firstName: 'Sami',
      montantComptantEur: 52.04,
      fraisDossierTotalEur: 50,
      assuryalFraisEur: 33,
      paymentLinkUrl: LINK,
      quoteId: QUOTE_ID,
    });
    expect(out).toContain('Bonjour Sami,');
    // Assuryal frais figure (the part the customer pays now).
    expect(out).toContain('33,00 €');
    // Comptant restant prélevé.
    expect(out).toContain('52,04 €');
    expect(out).toContain('le 5 du mois prochain');
    // The payment link itself.
    expect(out).toContain(LINK);
    // Idempotency marker the handler scans for.
    expect(out).toContain('(réf #abc12345 paiement)');
  });

  it('uses COMPLIANT frais wording — never "frais de dossier" / "taxe d\'État"', () => {
    const out = formatSubscriptionReadyMessage({
      firstName: 'Sami',
      assuryalFraisEur: 33,
      fraisDossierTotalEur: 50,
      paymentLinkUrl: LINK,
      quoteId: QUOTE_ID,
    });
    expect(out.toLowerCase()).not.toContain('frais de dossier');
    expect(out.toLowerCase()).not.toContain('taxe');
    expect(out).toContain("honoraires d'accompagnement administratif");
  });

  it('falls back to a "conseiller transmet le lien" line when Stripe is unconfigured', () => {
    const out = formatSubscriptionReadyMessage({
      firstName: 'Sami',
      assuryalFraisEur: 33,
      fraisDossierTotalEur: 50,
      paymentLinkUrl: null,
      quoteId: QUOTE_ID,
    });
    expect(out).not.toContain('https://');
    expect(out).toContain('Votre conseiller vous transmet le lien');
  });

  it('omits the comptant line when montantComptantEur is absent', () => {
    const out = formatSubscriptionReadyMessage({
      firstName: 'Sami',
      assuryalFraisEur: 33,
      fraisDossierTotalEur: 50,
      paymentLinkUrl: LINK,
      quoteId: QUOTE_ID,
    });
    expect(out).not.toContain('prélevé sur votre compte');
  });

  it('falls back to a generic greeting without firstName', () => {
    const out = formatSubscriptionReadyMessage({
      assuryalFraisEur: 33,
      fraisDossierTotalEur: 50,
      paymentLinkUrl: LINK,
      quoteId: QUOTE_ID,
    });
    expect(out.startsWith('Bonjour,')).toBe(true);
  });
});

describe('formatSubscriptionFailedMessage', () => {
  it('formats an apologetic French notice with the ref tag, no internal jargon', () => {
    const out = formatSubscriptionFailedMessage({ firstName: 'Sami', quoteId: QUOTE_ID });
    expect(out).toContain('Bonjour Sami,');
    expect(out).toContain("J'ai un petit souci technique pour finaliser votre souscription.");
    expect(out).toContain('Un conseiller revient vers vous');
    expect(out).toContain('(réf #abc12345)');
    expect(out).not.toMatch(/cloudflare|stagehand|maxance|iban|error/i);
  });

  it('falls back to a generic greeting without firstName', () => {
    const out = formatSubscriptionFailedMessage({ quoteId: QUOTE_ID });
    expect(out.startsWith('Bonjour,')).toBe(true);
  });
});
