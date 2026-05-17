/**
 * callClaude — LIVE integration tests against the real Anthropic API.
 *
 * Gated on ANTHROPIC_API_KEY. Skips entirely when the env var is absent so the
 * unit-test suite stays hermetic in CI without API credentials.
 *
 * Cost budget for the whole file (worst case): well under $0.01.
 *   - Test 1: Haiku, ~50 input tokens, ≤32 output tokens.
 *   - Test 2 (×2 calls): Sonnet, ~2.1k input tokens (mostly cached on call 2),
 *     ≤16 output tokens each.
 *
 * The cache test (test 2) is also the R2-routing validation: if
 * `cache_read_input_tokens > 0` on the second call, prompt caching is working
 * end-to-end through our wrapper — which is the architectural reason F16 uses
 * Anthropic-direct for Claude rather than routing through OpenRouter.
 */
import { describe, it, expect } from 'vitest';
import { callClaude, type ClaudeCallStructuredOutcome } from '../../src/llm/claude.js';

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const d = describe.skipIf(!hasKey);

d('callClaude (live)', () => {
  it('haiku responds to a short prompt with structured outcome', async () => {
    const out = (await callClaude({
      tier: 'haiku',
      systemPrompt: 'You are a concise French insurance helper. Respond in one short sentence.',
      userPrompt: 'Bonjour, juste dis-moi "OK" et rien d\'autre.',
      maxTokens: 32,
      structured: true,
    })) as ClaudeCallStructuredOutcome;

    expect(out.model).toBe('claude-haiku-4-5-20251001');
    expect(out.tier).toBe('haiku');
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.inputTokens).toBeGreaterThan(0);
    expect(out.outputTokens).toBeGreaterThan(0);
    expect(out.durationMs).toBeGreaterThan(0);
    // Non-streaming text-out should always have a stop reason.
    expect(out.stopReason).not.toBeNull();
  }, 60_000);

  it('plain string return (structured: false) yields the text directly', async () => {
    const out = await callClaude({
      tier: 'haiku',
      systemPrompt: 'Respond only with the single word "OK".',
      userPrompt: 'Say OK.',
      maxTokens: 16,
    });
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeGreaterThan(0);
  }, 60_000);

  it('sonnet honors cached system prompt across two calls (cache hit on call 2)', async () => {
    // Big enough to clear Anthropic's 1024-token minimum for cacheable blocks
    // and trigger an actual cache write on call 1.
    const longCachedPrefix =
      "You are Assuryal's French sales agent. Brand voice: warm, concise, factual. " +
      // Pad to ~5kB so we comfortably exceed the cache minimum even after tokenization.
      'A'.repeat(5000);
    const fragments = [{ text: longCachedPrefix, cache: true }];

    const call1 = (await callClaude({
      tier: 'sonnet',
      systemFragments: fragments,
      userPrompt: 'Dis exactement "1" et rien d\'autre.',
      maxTokens: 16,
      structured: true,
    })) as ClaudeCallStructuredOutcome;

    const call2 = (await callClaude({
      tier: 'sonnet',
      systemFragments: fragments,
      userPrompt: 'Dis exactement "2" et rien d\'autre.',
      maxTokens: 16,
      structured: true,
    })) as ClaudeCallStructuredOutcome;

    // Either call 1 writes to the cache (fresh prefix) OR it reads from a
    // cache primed by an earlier run within the 5-minute Anthropic cache TTL.
    // What matters for R2 validation is that SOMETHING participates with the
    // cache infrastructure on the first call.
    expect(call1.cacheCreationInputTokens + call1.cacheReadInputTokens).toBeGreaterThan(0);
    // Call 2 MUST read from the cache — this is the R2 validation: prompt
    // caching round-trips through our wrapper to the real Anthropic endpoint.
    // Without caching, cacheReadInputTokens would always be 0.
    expect(call2.cacheReadInputTokens).toBeGreaterThan(0);
    // And the cache read dominates: most of the prefix is re-used on call 2,
    // far more than any fresh per-turn metadata.
    expect(call2.cacheReadInputTokens).toBeGreaterThan(call2.cacheCreationInputTokens);
    // Sanity: both calls hit the correct model.
    expect(call1.model).toBe('claude-sonnet-4-6');
    expect(call2.model).toBe('claude-sonnet-4-6');
  }, 120_000);
});
