/**
 * LLM usage sink (admin costs 2026-07-08) — unit tests, no DB.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordLlmUsage,
  registerLlmUsageSink,
  usageTagsFromLogContext,
  type LlmUsageEvent,
} from '../../src/llm/usage-log.js';

afterEach(() => registerLlmUsageSink(null));

describe('recordLlmUsage', () => {
  it('is a no-op when no sink is registered', () => {
    expect(() =>
      recordLlmUsage({
        model: 'claude-haiku-4-5-20251001',
        tier: 'haiku',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).not.toThrow();
  });

  it('forwards the event to the registered sink', async () => {
    const seen: LlmUsageEvent[] = [];
    registerLlmUsageSink((e) => {
      seen.push(e);
      return Promise.resolve();
    });
    recordLlmUsage({
      model: 'claude-sonnet-4-6',
      tier: 'sonnet',
      agentRole: 'sales-agent',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      durationMs: 123,
      iterations: 2,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe('claude-sonnet-4-6');
    expect(seen[0]!.iterations).toBe(2);
  });

  it('swallows sink failures (never throws into the LLM call path)', async () => {
    registerLlmUsageSink(() => Promise.reject(new Error('db down')));
    expect(() =>
      recordLlmUsage({
        model: 'claude-haiku-4-5-20251001',
        tier: 'haiku',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('usageTagsFromLogContext', () => {
  it('returns empty tags without a context', () => {
    expect(usageTagsFromLogContext(undefined)).toEqual({});
  });

  it('picks agent + purpose from common logContext keys', () => {
    expect(usageTagsFromLogContext({ agent: 'sales-agent', purpose: 'reply' })).toEqual({
      agentRole: 'sales-agent',
      purpose: 'reply',
    });
    expect(usageTagsFromLogContext({ role: 'lead-scorer', op: 'score' })).toEqual({
      agentRole: 'lead-scorer',
      purpose: 'score',
    });
  });

  it('ignores non-string and oversized values', () => {
    expect(usageTagsFromLogContext({ agent: 42, purpose: 'x'.repeat(100) })).toEqual({});
  });
});
