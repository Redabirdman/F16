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

  it('keeps the four cached fragments under ~6 kB for a typical context', () => {
    const frags = buildSalesAgentSystemPrompt(minimalCtx);
    const totalBytes = frags.reduce((sum, f) => sum + Buffer.byteLength(f.text, 'utf8'), 0);
    expect(totalBytes).toBeLessThan(6000);
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
