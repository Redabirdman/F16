/**
 * Sales Agent prompt unit tests (M6.T2).
 *
 * Pure-function tests, no DB / no LLM. Verifies:
 *   - The four-cached + one-dynamic fragment structure is intact.
 *   - The per-turn fragment includes / omits sections based on input.
 *   - The composer is pure (deterministic for fixed input).
 *   - Total prompt size stays under the budget we set for M6 (~6 kB typical).
 */
import { describe, it, expect } from 'vitest';
import {
  buildSalesAgentSystemPrompt,
  buildTurnContextFragment,
  BRAND_VOICE_FRAGMENT,
  PRODUCTS_FRAGMENT,
  PLAYBOOK_FRAGMENT,
  GUARDRAILS_FRAGMENT,
  type SalesAgentTurnContext,
} from '../../../src/agents/sales-agent/prompts/index.js';

const minimalCtx: SalesAgentTurnContext = {
  customer: {
    id: 'cus_1',
    fullName: null,
    civility: null,
    productLine: 'scooter',
    vehicleSummary: null,
    driverSummary: null,
  },
  lead: {
    id: 'lead_1',
    source: 'website',
    status: 'NEW',
    score: null,
    quoteState: 'none',
  },
  recentTurns: [],
  channel: 'whatsapp',
};

describe('buildSalesAgentSystemPrompt()', () => {
  it('returns exactly 5 fragments', () => {
    const frags = buildSalesAgentSystemPrompt(minimalCtx);
    expect(frags).toHaveLength(5);
  });

  it('marks the first 4 fragments as cached and the per-turn fragment as not cached', () => {
    const frags = buildSalesAgentSystemPrompt(minimalCtx);
    expect(frags[0]!.cache).toBe(true);
    expect(frags[1]!.cache).toBe(true);
    expect(frags[2]!.cache).toBe(true);
    expect(frags[3]!.cache).toBe(true);
    expect(frags[4]!.cache).toBe(false);

    // Exact identity — the four cached fragments are the exported singletons.
    expect(frags[0]).toBe(BRAND_VOICE_FRAGMENT);
    expect(frags[1]).toBe(PRODUCTS_FRAGMENT);
    expect(frags[2]).toBe(PLAYBOOK_FRAGMENT);
    expect(frags[3]).toBe(GUARDRAILS_FRAGMENT);
  });

  it('is pure — calling twice with the same input returns identical output', () => {
    const a = buildSalesAgentSystemPrompt(minimalCtx);
    const b = buildSalesAgentSystemPrompt(minimalCtx);
    expect(a.map((f) => f.text)).toEqual(b.map((f) => f.text));
    expect(a.map((f) => f.cache)).toEqual(b.map((f) => f.cache));
  });

  it('keeps the four cached fragments under ~12 kB for a typical context', () => {
    // Cap was 6 kB through M6, 8 kB after M8.T8 (five trottinette
    // qualification fields). M8.T7 (closing) bumped to 10 kB: the closing
    // phase now carries the souscription guidance (IBAN/BIC/titulaire/ville
    // de naissance collection, fractionnement mechanics, the ONLY-approved
    // frais formulations, garanties additionnelles, escalation) — ~1.5 kB of
    // intentional growth so the agent can actually close. 2026-07-02 bumped
    // to 12 kB: Achraf's pricing method (mensualité vs montant-annuel
    // semantics, the 2 options, the pack pitch) + the quote.confirm phase —
    // without it the agent quoted the ANNUAL premium as monthly and re-ran
    // quote.request on every objection. Token cost amortised by prompt
    // caching as before. 2026-07-07 bumped to 12.3 kB: human mini-reactions
    // (Ridaa's human-touch mandate), the ask-WHEN follow-up rule (hot lead
    // cools in 24h), and the real "Date du jour" line (the model told a
    // customer "19 décembre 2024" in July 2026 without it). 2026-07-08 bumped
    // to 12.6 kB: the conversation.schedule_followup cadence rule — the agent
    // promised « je vous retrouve dans 10 minutes » with no mechanism behind
    // it (Achraf live test); the rule makes the promise system-backed. Later
    // same day, 12.9 kB: the minor-customer rule (inform + continue with a
    // parent, NO management approval — Ridaa's calibration mandate; the Jean
    // Bidet run escalated a perfectly correct message). Same evening,
    // 13.3 kB: PRE-validation rules Ridaa asked for after live Maxance
    // rejections — no product for street/open parking (ask for a secured
    // spot BEFORE quoting) and no quote.request before the parent's details
    // are stored on a minor dossier.
    // Same evening again, 13.5 kB: never name internal team members to
    // customers (« un conseiller Assuryal », jamais un prénom — live: the
    // agent said "Ridaa ou Achraf vous appelle").
    const frags = buildSalesAgentSystemPrompt(minimalCtx);
    const totalBytes = frags.reduce((sum, f) => sum + Buffer.byteLength(f.text, 'utf8'), 0);
    expect(totalBytes).toBeLessThan(13500);
  });

  it('playbook closing phase carries the compliant frais framing and collection list', () => {
    const text = PLAYBOOK_FRAGMENT.text;
    // The three approved formulations are present…
    expect(text).toContain("frais d'inscription au contrat");
    expect(text).toContain('honoraires de gestion du dossier');
    expect(text).toContain('accompagnement administratif personnalisé');
    // …and the forbidden state-tax framing is NOT (compliance: Ridaa 2026-06-11).
    expect(text).not.toContain('taxe imposée par l’État');
    expect(text).not.toContain("taxe imposée par l'État");
    // Closing data collection + fractionnement mechanics + escalation hook.
    expect(text).toContain('IBAN');
    expect(text).toContain('BIC');
    expect(text).toContain('titulaire du compte');
    expect(text).toContain('ville de naissance');
    expect(text).toContain('prorata du mois en cours');
    expect(text).toContain('prélevée le 5');
    expect(text).toContain('human.escalate');
    // Tool-agnostic on purpose: the subscription tool lands in a later task.
    expect(text).not.toContain('subscription.request');
  });

  it('guardrails forbid tax-framing of frais and cross-channel bank data leaks', () => {
    const text = GUARDRAILS_FRAGMENT.text;
    expect(text).toContain('Présenter les frais comme une taxe ou une obligation légale');
    expect(text).toContain('Communiquer une donnée bancaire en clair dans un autre canal');
  });
});

describe('buildTurnContextFragment()', () => {
  it('includes civility line when civility is present', () => {
    const frag = buildTurnContextFragment({
      ...minimalCtx,
      customer: { ...minimalCtx.customer, civility: 'Monsieur', fullName: 'Jean Dupont' },
    });
    expect(frag.text).toContain('Civilité : Monsieur');
    expect(frag.text).toContain('Nom : Jean Dupont');
  });

  it('omits civility line when civility is null', () => {
    const frag = buildTurnContextFragment(minimalCtx);
    expect(frag.text).not.toContain('Civilité');
    expect(frag.text).not.toContain('Nom :');
  });

  it('renders recalled facts as bullet points under their header', () => {
    const frag = buildTurnContextFragment({
      ...minimalCtx,
      recalledFacts: ['Client a déjà refusé voiture Sept 2024', 'Préfère être contacté en soirée'],
    });
    expect(frag.text).toContain('## Faits mémorisés sur ce client');
    expect(frag.text).toContain('- Client a déjà refusé voiture Sept 2024');
    expect(frag.text).toContain('- Préfère être contacté en soirée');
  });

  it('renders recent turns with direction tag, channel, timestamp, and content', () => {
    const at = new Date('2026-05-17T10:30:00.000Z');
    const frag = buildTurnContextFragment({
      ...minimalCtx,
      recentTurns: [
        { direction: 'inbound', channel: 'whatsapp', content: 'Bonjour je veux un devis', at },
        { direction: 'outbound', channel: 'whatsapp', content: 'Bonjour, avec plaisir.', at },
      ],
    });
    expect(frag.text).toContain('## Échanges récents');
    expect(frag.text).toContain(
      '[CLIENT] (whatsapp, 2026-05-17T10:30:00.000Z): Bonjour je veux un devis',
    );
    expect(frag.text).toContain(
      '[ASSURYAL] (whatsapp, 2026-05-17T10:30:00.000Z): Bonjour, avec plaisir.',
    );
  });

  it('omits the recent-turns header when there are no turns (clean first-turn welcome)', () => {
    const frag = buildTurnContextFragment(minimalCtx);
    expect(frag.text).not.toContain('Échanges récents');
  });

  it('includes the suggested opening when present', () => {
    const frag = buildTurnContextFragment({
      ...minimalCtx,
      suggestedOpening: 'Bonjour ! Vous avez demandé un devis trottinette sur notre site.',
    });
    expect(frag.text).toContain("## Suggestion d'ouverture (du Lead Scorer)");
    expect(frag.text).toContain('Bonjour ! Vous avez demandé un devis trottinette sur notre site.');
  });

  it('always includes the channel hint for this turn', () => {
    const wa = buildTurnContextFragment({ ...minimalCtx, channel: 'whatsapp' });
    expect(wa.text).toContain('## Canal de cette réponse');
    expect(wa.text).toContain('joint sur **whatsapp**');

    const email = buildTurnContextFragment({ ...minimalCtx, channel: 'email' });
    expect(email.text).toContain('joint sur **email**');
  });

  it('ends with the "no wrapper, raw message only" instruction', () => {
    const frag = buildTurnContextFragment(minimalCtx);
    expect(frag.text.trimEnd().endsWith('Ne renvoie QUE le texte du message.')).toBe(true);
  });
});
