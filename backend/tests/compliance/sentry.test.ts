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
  /** Per-call replies consumed FIFO before falling back to `nextText` — lets the retry tests vary the first vs second attempt. */
  public textQueue: string[] = [];
  public nextError: Error | null = null;
  public messages = {
    create: async (req: { model: string; max_tokens: number }) => {
      this.calls.push({ model: req.model, max_tokens: req.max_tokens });
      if (this.nextError) throw this.nextError;
      const text = this.textQueue.length > 0 ? this.textQueue.shift()! : this.nextText;
      return {
        content: [{ type: 'text' as const, text }],
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

  // 9 — no severity in the LLM output = 'critical' by default (fail-safe):
  // an old-format block keeps the pre-send hold.
  it('test 9: server-clean + LLM block (no severity → critical) → verdict block', async () => {
    stub.nextText = '{"verdict":"block","reasons":["sort du périmètre"]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Aujourd’hui il fait beau, parlons météo plutôt.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.reasons).toEqual(['sort du périmètre']);
    expect(stub.callCount).toBe(1);
  });

  // 9b — restructure 2026-07-07: a MINOR block is advisory — the message
  // sends, flagged for after-the-fact review, never a management approval.
  it('test 9b: LLM block with severity minor → verdict pass + flagged', async () => {
    stub.nextText = '{"verdict":"block","severity":"minor","reasons":["tournure à revoir"]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.flagged).toBe(true);
    expect(out.reasons).toEqual(['tournure à revoir']);
  });

  // 9c — critical explicitly stated still blocks.
  it('test 9c: LLM block with severity critical → verdict block', async () => {
    stub.nextText = '{"verdict":"block","severity":"critical","reasons":["contrat annoncé actif"]}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Votre dossier avance bien.',
      ctx,
    });
    expect(out.verdict).toBe('block');
  });

  // 10 — restructure 2026-07-07: an LLM outage must not silence the sales
  // conversation (hard server rules already passed) — send + flag.
  it('test 10: LLM transport error → pass + flagged (send, audit for review)', async () => {
    stub.nextError = new Error('network timeout');
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.flagged).toBe(true);
    expect(out.reasons.join(' ')).toMatch(/unavailable/i);
    expect(out.llmRationale).toBe('network timeout');
    expect(stub.callCount).toBe(1);
  });

  // 11 — unparseable ×2 was the "technical glitch" approval noise: now the
  // message sends, flagged.
  it('test 11: LLM returns garbage (no JSON) twice → pass + flagged after one retry', async () => {
    stub.nextText = 'pas du tout du JSON, juste du texte libre';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.flagged).toBe(true);
    expect(out.reasons.join(' ')).toMatch(/not parseable/i);
    expect(stub.callCount).toBe(2);
  });

  // 12
  it('test 12: LLM schema violation twice → pass + flagged after one retry', async () => {
    stub.nextText = '{"verdict":"maybe"}';
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.flagged).toBe(true);
    expect(out.reasons.join(' ')).toMatch(/schema mismatch/i);
    expect(stub.callCount).toBe(2);
  });

  // 12b — the whole point of the retry: one flake must not block a clean draft.
  it('test 12b: garbage first attempt + clean pass on retry → verdict pass', async () => {
    stub.textQueue = ['pas du JSON du tout', '{"verdict":"pass","reasons":[]}'];
    const out = await checkComplianceFor(noDb, {
      draft: 'Bonjour, je peux vous aider.',
      ctx,
    });
    expect(out.verdict).toBe('pass');
    expect(out.reasons).toEqual([]);
    expect(stub.callCount).toBe(2);
  });

  // 12c — the retry keeps fail-closed teeth: a real block on retry still blocks.
  it('test 12c: garbage first attempt + block on retry → verdict block with LLM reasons', async () => {
    stub.textQueue = ['###', '{"verdict":"block","reasons":["sort du périmètre"]}'];
    const out = await checkComplianceFor(noDb, {
      draft: 'Aujourd’hui il fait beau, parlons météo plutôt.',
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.reasons).toEqual(['sort du périmètre']);
    expect(stub.callCount).toBe(2);
  });

  // 12d — the closing rules' forbidden "taxe" presentation is now a HARD rule.
  it('test 12d: presenting frais as a state tax → hard block, no LLM call', async () => {
    const out = await checkComplianceFor(noDb, {
      draft: "Ces 50 € sont une taxe imposée par l'État, rien à voir avec nous.",
      ctx,
    });
    expect(out.verdict).toBe('block');
    expect(out.ruleHits).toContain('frais-as-tax');
    expect(stub.callCount).toBe(0);
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
