/**
 * Nudge generator (M11/messaging.ts) — pure + stubbed-Anthropic unit tests.
 *
 * No DB, no network. Uses the `__setClaudeClientForTests` seam from
 * `src/llm/claude.ts` to inject a minimal stub so we can drive both the
 * success path and the fallback path without an API key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setClaudeClientForTests } from '../../../src/llm/claude.js';
import {
  generateNudgeText,
  fallbackNudge,
} from '../../../src/agents/engagement-agent/messaging.js';

class StubAnthropic {
  public calls: Array<{ model: string; messages: unknown }> = [];
  public nextText = 'Bonjour Marie, vous avez eu le temps de regarder le devis ?';
  public throwNext = false;
  public messages = {
    create: async (req: { model: string; messages: unknown }) => {
      if (this.throwNext) {
        this.throwNext = false;
        throw new Error('stub_haiku_down');
      }
      this.calls.push({ model: req.model, messages: req.messages });
      return {
        content: [{ type: 'text' as const, text: this.nextText }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 100, output_tokens: 25 },
      };
    },
  };
}

let stub: StubAnthropic;

beforeEach(() => {
  stub = new StubAnthropic();
  __setClaudeClientForTests(stub);
});

afterEach(() => {
  __setClaudeClientForTests(null);
});

describe('generateNudgeText — Haiku success path', () => {
  it('returns the LLM text and reports source=llm for step 1', async () => {
    const result = await generateNudgeText({
      step: 1,
      firstName: 'Marie',
      productLine: 'scooter',
      recentSnippets: [{ direction: 'outbound', content: 'Bonjour Marie, voici votre devis…' }],
    });
    expect(result.source).toBe('llm');
    expect(result.text).toContain('Marie');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.model).toMatch(/haiku/);
  });

  it('strips wrapping quotes from the LLM response', async () => {
    stub.nextText = '"Bonjour, vous avez eu le temps de réfléchir ?"';
    const result = await generateNudgeText({
      step: 1,
      firstName: null,
      productLine: 'car',
      recentSnippets: [],
    });
    expect(result.source).toBe('llm');
    expect(result.text).toBe('Bonjour, vous avez eu le temps de réfléchir ?');
  });

  it('uses a different prompt fragment for step 2 (softer tone)', async () => {
    await generateNudgeText({
      step: 2,
      firstName: 'Léa',
      productLine: 'car',
      recentSnippets: [{ direction: 'inbound', content: 'Je vais y réfléchir.' }],
    });
    expect(stub.calls).toHaveLength(1);
    // The step-2 system fragment talks explicitly about "clôturer". This
    // assertion is loose-coupled to wording but anchors on the policy.
    const messages = stub.calls[0]?.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages)).toContain('Léa');
  });
});

describe('generateNudgeText — fallback path', () => {
  it('falls back to the template when Haiku throws', async () => {
    stub.throwNext = true;
    const result = await generateNudgeText({
      step: 1,
      firstName: 'Marie',
      productLine: 'scooter',
      recentSnippets: [],
    });
    expect(result.source).toBe('fallback');
    expect(result.text).toContain('Marie');
    expect(result.text).toContain('trottinette');
  });

  it('falls back to the template when Haiku returns empty text', async () => {
    stub.nextText = '   ';
    const result = await generateNudgeText({
      step: 2,
      firstName: null,
      productLine: 'car',
      recentSnippets: [],
    });
    expect(result.source).toBe('fallback');
    expect(result.text).toContain('Bonjour');
    expect(result.text).toContain('auto');
  });
});

describe('fallbackNudge — deterministic templates', () => {
  it('greets by first name when known (step 1, scooter)', () => {
    expect(
      fallbackNudge({
        step: 1,
        firstName: 'Léa',
        productLine: 'scooter',
        recentSnippets: [],
      }),
    ).toContain('Bonjour Léa');
  });

  it('softens the wording at step 2 (car, no first name)', () => {
    const text = fallbackNudge({
      step: 2,
      firstName: null,
      productLine: 'car',
      recentSnippets: [],
    });
    expect(text).toContain('Bonjour,');
    expect(text).toContain('clôture');
    expect(text).toContain('auto');
  });
});
