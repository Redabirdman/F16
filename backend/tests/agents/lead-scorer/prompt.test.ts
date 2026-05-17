/**
 * Lead Scorer prompt unit tests (M5.T3).
 *
 * Pure-function tests, no DB / no LLM. Verifies the prompt scaffolding so a
 * refactor that drops a line or stops marking the rubric as cacheable is
 * caught without paying for a Claude call.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLeadScorerSystemPrompt,
  buildLeadScorerUserPrompt,
} from '../../../src/agents/lead-scorer/prompt.js';

describe('buildLeadScorerSystemPrompt()', () => {
  it('returns a single cacheable SystemFragment', () => {
    const frags = buildLeadScorerSystemPrompt();
    expect(frags).toHaveLength(1);
    expect(frags[0]!.cache).toBe(true);
    // Sanity-check key rubric anchors so accidental truncation is loud.
    expect(frags[0]!.text).toContain('Assuryal');
    expect(frags[0]!.text).toContain('trottinette');
    expect(frags[0]!.text).toContain('JSON STRICT');
    expect(frags[0]!.text).toContain('"channel"');
  });
});

describe('buildLeadScorerUserPrompt()', () => {
  it('includes every populated field in the prompt body', () => {
    const out = buildLeadScorerUserPrompt({
      source: 'website',
      productLine: 'scooter',
      fullName: 'Marie Dupont',
      email: 'marie@example.com',
      phone: '+33612345678',
      vehicle: { type: 'trottinette', brand: 'Xiaomi' },
      driver: { malus: false, age: 32 },
      formAnswers: { gdpr: true, budget: '5-10€/mois' },
    });

    expect(out).toContain('- Source : website');
    expect(out).toContain('- Produit : scooter');
    expect(out).toContain('- Nom : Marie Dupont');
    expect(out).toContain('- Email : marie@example.com');
    expect(out).toContain('- Téléphone : +33612345678');
    expect(out).toContain('"trottinette"');
    expect(out).toContain('"Xiaomi"');
    expect(out).toContain('"malus":false');
    expect(out).toContain('"budget":"5-10€/mois"');
    // Ends on the instruction to evaluate, after a blank line.
    expect(out.endsWith('Évalue maintenant.')).toBe(true);
  });

  it('omits null/empty optional fields (no "Nom : null" leakage)', () => {
    const out = buildLeadScorerUserPrompt({
      source: 'organic',
      productLine: 'car',
      fullName: null,
      email: null,
      phone: null,
      vehicle: null,
      driver: {},
      formAnswers: null,
    });

    expect(out).toContain('- Source : organic');
    expect(out).toContain('- Produit : car');
    expect(out).not.toMatch(/- Nom/);
    expect(out).not.toMatch(/- Email/);
    expect(out).not.toMatch(/- Téléphone/);
    expect(out).not.toMatch(/- Véhicule/);
    // Empty driver object is also dropped (no "Conducteur : {}").
    expect(out).not.toMatch(/- Conducteur/);
    expect(out).not.toMatch(/- Réponses formulaire/);
    expect(out).not.toContain('null');
  });

  it('includes vehicle/driver lines only when the object has keys', () => {
    const withKeys = buildLeadScorerUserPrompt({
      source: 'website',
      productLine: 'car',
      fullName: null,
      email: null,
      phone: null,
      vehicle: { brand: 'Renault' },
      driver: { malus: true },
      formAnswers: null,
    });
    expect(withKeys).toContain('- Véhicule :');
    expect(withKeys).toContain('- Conducteur :');
    expect(withKeys).toContain('"Renault"');
  });
});
