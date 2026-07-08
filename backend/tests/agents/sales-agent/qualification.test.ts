/**
 * Unit tests for the progressive quote-qualification slot memory. Pure — the
 * extractor's LLM call is stubbed and `db` is omitted (so it uses the default
 * prompt, no DB). Locks the "never re-ask / never drop collected fields"
 * behaviour and the ✓/✗ checklist rendering.
 */
import { describe, it, expect } from 'vitest';
import type { callClaude } from '../../../src/llm/claude.js';
import {
  extractQualification,
  missingQualFields,
  isQualificationComplete,
  type QualificationState,
} from '../../../src/agents/sales-agent/qualification.js';
import {
  buildTurnContextFragment,
  type SalesAgentTurnContext,
} from '../../../src/agents/sales-agent/prompts/index.js';

/** A callClaude stub that returns a fixed text (the extractor reads `.text` or the raw string). */
function stub(text: string): typeof callClaude {
  return (async () => text) as unknown as typeof callClaude;
}

describe('qualification extractor', () => {
  it("hands the extractor today's date + the agent's last message (2026-07-08 fix)", async () => {
    // Live failures without these: "il y a 5 jours" resolved to a
    // hallucinated year, and « oui c'est ça » confirming the agent's
    // corrected date updated nothing.
    let seenPrompt = '';
    const capture = (async (input: { userPrompt: string }) => {
      seenPrompt = input.userPrompt;
      return '{}';
    }) as unknown as typeof callClaude;
    await extractQualification({
      current: {},
      message: 'Oui oui c sa',
      lastAgentMessage: "La date d'achat, c'est bien le 3 juillet 2026 alors ?",
      callImpl: capture,
    });
    expect(seenPrompt).toContain('DATE DU JOUR');
    expect(seenPrompt).toMatch(/\d{4}-\d{2}-\d{2}/); // ISO today for relative-date math
    expect(seenPrompt).toContain("DERNIER MESSAGE DE L'AGENT");
    expect(seenPrompt).toContain('3 juillet 2026');
  });

  it('merges a newly-provided field into the current state', async () => {
    const out = await extractQualification({
      current: {},
      message: 'je vous ai noté ça vaut 600',
      callImpl: stub('{"purchasePriceEur": 600}'),
    });
    expect(out.purchasePriceEur).toBe(600);
  });

  it('preserves fields the model omits (never drops collected state)', async () => {
    const current: QualificationState = { purchasePriceEur: 600, clientDateOfBirth: '1999-02-10' };
    const out = await extractQualification({
      current,
      message: 'box',
      callImpl: stub('{"stationnement":"garage_box"}'),
    });
    expect(out.purchasePriceEur).toBe(600); // kept
    expect(out.clientDateOfBirth).toBe('1999-02-10'); // kept
    expect(out.stationnement).toBe('garage_box'); // added
  });

  it('drops an invalid field but keeps the valid ones', async () => {
    const out = await extractQualification({
      current: {},
      message: 'x',
      callImpl: stub('{"postalCode":"75019","purchaseDate":"pas une date"}'),
    });
    expect(out.postalCode).toBe('75019');
    expect(out.purchaseDate).toBeUndefined();
  });

  it('returns current unchanged on unparseable model output', async () => {
    const current: QualificationState = { postalCode: '75019' };
    const out = await extractQualification({
      current,
      message: 'x',
      callImpl: stub('no json here'),
    });
    expect(out).toEqual(current);
  });

  it('returns current unchanged on an empty message (no LLM call)', async () => {
    const current: QualificationState = { postalCode: '75019' };
    const out = await extractQualification({
      current,
      message: '   ',
      callImpl: stub('{"purchasePriceEur":1}'),
    });
    expect(out).toEqual(current);
  });

  it('missing + complete helpers', () => {
    expect(missingQualFields({})).toHaveLength(5);
    const full: QualificationState = {
      purchasePriceEur: 600,
      purchaseDate: '2026-07-17',
      postalCode: '75019',
      clientDateOfBirth: '1999-02-10',
      stationnement: 'garage_box',
    };
    expect(missingQualFields(full)).toEqual([]);
    expect(isQualificationComplete(full)).toBe(true);
    expect(isQualificationComplete({ purchasePriceEur: 600 })).toBe(false);
  });
});

describe('qualification checklist in the prompt', () => {
  const baseCtx = (qualification: QualificationState): SalesAgentTurnContext => ({
    customer: {
      id: 'c',
      fullName: 'A',
      civility: null,
      productLine: 'scooter',
      vehicleSummary: null,
      driverSummary: null,
    },
    lead: { id: 'l', source: 'meta', status: 'qualifying', score: 50, quoteState: 'none' },
    recentTurns: [],
    qualification,
    channel: 'whatsapp',
  });

  it('renders ✓ for collected fields and ✗ for missing ones', () => {
    const frag = buildTurnContextFragment(
      baseCtx({
        purchasePriceEur: 600,
        clientDateOfBirth: '1999-02-10',
        stationnement: 'garage_box',
      }),
    );
    expect(frag.text).toContain('État de la qualification');
    expect(frag.text).toContain("✓ Prix d'achat : 600 €");
    expect(frag.text).toContain('✓ Date de naissance : 1999-02-10');
    expect(frag.text).toContain('✓ Stationnement la nuit : garage_box');
    expect(frag.text).toContain('✗ Code postal : à demander');
    expect(frag.text).toContain("✗ Date d'achat : à demander");
  });

  it('omits the checklist for non-scooter product lines', () => {
    const ctx = baseCtx({});
    ctx.customer.productLine = 'car';
    const frag = buildTurnContextFragment(ctx);
    expect(frag.text).not.toContain('État de la qualification');
  });
});
