/**
 * Compliance Sentry unit tests (M6.T4).
 *
 * Pure-logic + stub-Claude. No DB, no Redis, no ANTHROPIC_API_KEY needed —
 * we inject a `StubAnthropic` via `__setClaudeClientForTests` and pass `null`
 * for the database argument (the sentry never touches it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkComplianceFor, SERVER_RULES } from '../../src/compliance/sentry.js';
import { __setClaudeClientForTests } from '../../src/llm/claude.js';
import type { Database } from '../../src/db/index.js';

/**
 * Minimal Anthropic stub — records each request and replays a canned text
 * (or throws if `nextError` is set). Mirrors the shape used by the M6.T3
 * Sales Agent suite.
 */
class StubAnthropic {
  public calls: Array<{ model: string; max_tokens: number }> = [];
  public nextText = '{"verdict":"pass","reasons":[]}';
  public nextError: Error | null = null;
  public messages = {
    create: async (req: { model: string; max_tokens: number }) => {
      this.calls.push({ model: req.model, max_tokens: req.max_tokens });
      if (this.nextError) throw this.nextError;
      return {
        content: [{ type: 'text' as const, text: this.nextText }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 50, output_tokens: 20 },
      };
    },
  };
  get callCount(): number {
    return this.calls.length;
  }
}

// Fixture ctx — kept identical across tests so we only vary `draft`.
const ctx = {
  customerId: '11111111-1111-1111-1111-111111111111',
  channel: 'whatsapp' as const,
  productLine: 'scooter' as const,
  leadStatus: 'scored',
  lastInboundContent: "C'est combien ?",
};

// The sentry never touches the DB — `null as unknown as Database` is safe
// for these unit tests and keeps the type signature honest.
const noDb = null as unknown as Database;

describe('checkComplianceFor() — server-side hard rules (fast-path, no LLM)', () => {
  let stub: StubAnthropic;
  beforeEach(() => {
    stub = new StubAnthropic();
    __setClaudeClientForTests(stub);
  });
  afterEach(() => {
    __setClaudeClientForTests(null);
  });

  // 1
  it('test 1: "Votre contrat est validé" → block, no LLM call', async () => {
    const out = await checkComplianceFor(noDb, { draft: 'Votre contrat est validé.', ctx });
    expect(out.verdict).toBe('block');
    expect(out.ruleHits).toContain('contract-already-bound');
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(stub.callCount).toBe(0);
  });

  // 2
  it('test 2: "vous êtes assuré" → block (insurance-active rule)', async () => {
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonne nouvelle, vous êtes assuré dès demain.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.ruleHits).toContain('insurance-active');
    expect(stub.callCount).toBe(0);
  });

  // 3
  it('test 3: asks for SMS code → block (asks-password-otp)', async () => {
    const out = await checkComplianceFor(noDb, {
      draft: 'Pouvez-vous me donner votre code SMS ?',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.ruleHits).toContain('asks-password-otp');
    expect(stub.callCount).toBe(0);
  });

  // 4
  it('test 4: medical advice → block (medical-advice)', async () => {
    const out = await checkComplianceFor(noDb, {
      draft: 'Pour votre toux, consultez un médecin rapidement.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.ruleHits).toContain('medical-advice');
    expect(stub.callCount).toBe(0);
  });
});

describe('checkComplianceFor() — soft rules go through LLM', () => {
  let stub: StubAnthropic;
  beforeEach(() => {
    stub = new StubAnthropic();
    __setClaudeClientForTests(stub);
  });
  afterEach(() => {
    __setClaudeClientForTests(null);
  });

  // 5
  it('test 5: legal-advice soft hit → LLM consulted (passes here)', async () => {
    stub.nextText = '{"verdict":"pass","reasons":[]}';
    const out = await checkComplianceFor(noDb, {
      draft: "D'un point de vue légal, vous restez libre de choisir.",
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.ruleHits).toContain('legal-advice');
    expect(stub.callCount).toBe(1);
  });

  // 6
  it('test 6: full IBAN in clear → LLM consulted', async () => {
    stub.nextText = '{"verdict":"pass","reasons":[]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Pour info votre IBAN reste FR76 3000 4000 5000 6000 7000 123.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.ruleHits).toContain('iban-full');
    expect(stub.callCount).toBe(1);
  });

  // 7
  it('test 7: exact price (soft) → LLM consulted (passes here)', async () => {
    stub.nextText = '{"verdict":"pass","reasons":[]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Votre cotisation sera de 14,50 € par mois selon le devis Maxance reçu.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.ruleHits).toContain('exact-price-no-devis');
    expect(stub.callCount).toBe(1);
  });
});

describe('checkComplianceFor() — LLM outcomes', () => {
  let stub: StubAnthropic;
  beforeEach(() => {
    stub = new StubAnthropic();
    __setClaudeClientForTests(stub);
  });
  afterEach(() => {
    __setClaudeClientForTests(null);
  });

  // 8
  it('test 8: server-clean + LLM pass → verdict pass, reasons empty', async () => {
    stub.nextText = '{"verdict":"pass","reasons":[]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider à comparer les formules.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.reasons).toEqual([]);
    expect(out.ruleHits).toEqual([]);
    expect(stub.callCount).toBe(1);
  });

  // 9
  it('test 9: server-clean + LLM block → verdict block with LLM reasons', async () => {
    stub.nextText = '{"verdict":"block","reasons":["sort du périmètre"]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Aujourd’hui il fait beau, parlons météo plutôt.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.reasons).toEqual(['sort du périmètre']);
    expect(stub.callCount).toBe(1);
  });

  // 10
  it('test 10: LLM transport error → fail-closed block', async () => {
    stub.nextError = new Error('network timeout');
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.reasons.join(' ')).toMatch(/unavailable/i);
    expect(out.llmRationale).toBe('network timeout');
  });

  // 11
  it('test 11: LLM returns garbage (no JSON) → fail-closed block', async () => {
    stub.nextText = 'pas du tout du JSON, juste du texte libre';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.reasons.join(' ')).toMatch(/not parseable/i);
  });

  // 12
  it('test 12: LLM schema violation → fail-closed block', async () => {
    stub.nextText = '{"verdict":"maybe"}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.reasons.join(' ')).toMatch(/schema mismatch/i);
  });

  // 13
  it('test 13: durationMs is a non-negative finite number', async () => {
    stub.nextText = '{"verdict":"pass","reasons":[]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(out.durationMs).toBeLessThan(10_000);
  });

  // 14
  it('test 14: soft hit + LLM pass → verdict pass, ruleHits non-empty, reasons empty', async () => {
    stub.nextText = '{"verdict":"pass","reasons":[]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Votre cotisation sera de 14,50 € par mois selon le devis Maxance reçu.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.ruleHits.length).toBeGreaterThan(0);
    expect(out.reasons).toEqual([]);
  });

  // 15 — sanity: rule book is non-trivial
  it('test 15 (sanity): SERVER_RULES is populated and well-formed', () => {
    expect(SERVER_RULES.length).toBeGreaterThan(0);
    for (const r of SERVER_RULES) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.pattern).toBeInstanceOf(RegExp);
      expect(typeof r.hard).toBe('boolean');
    }
  });

  // 16 — LLM response wrapped in ```json fences is still parsed
  it('test 16: LLM JSON wrapped in ```json fences → parsed correctly', async () => {
    stub.nextText = '```json\n{"verdict":"block","reasons":["risque"]}\n```';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.reasons).toEqual(['risque']);
  });
});
