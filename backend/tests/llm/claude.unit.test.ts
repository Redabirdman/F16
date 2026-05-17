/**
 * callClaude — unit tests against a stub Anthropic client. No network.
 *
 * Exercises the request-shaping contract (model id, max_tokens, system block
 * composition, message shape) and the response-shaping contract (text vs.
 * structured outcome, usage token fields, cache token defaults). Pairs with
 * `claude.live.test.ts` which exercises the same surface against the real API.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  callClaude,
  __setClaudeClientForTests,
  type ClaudeCallStructuredOutcome,
} from '../../src/llm/claude.js';

// Stub message shape — only the fields callClaude actually reads. Loose record
// keeps us decoupled from SDK type drift between minor versions.
type StubMessage = {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
};

interface StubRequest {
  model: string;
  max_tokens: number;
  system?: Array<{ type: string; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Array<{ role: string; content: string }>;
}

class StubAnthropic {
  public calls: StubRequest[] = [];
  public response: StubMessage = {
    content: [{ type: 'text', text: 'bonjour' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 42, output_tokens: 7 },
  };
  public messages = {
    create: async (req: StubRequest): Promise<StubMessage> => {
      this.calls.push(req);
      return this.response;
    },
  };
  get lastCall(): StubRequest {
    const r = this.calls[this.calls.length - 1];
    if (!r) throw new Error('StubAnthropic: no call recorded');
    return r;
  }
}

describe('callClaude (unit, stub Anthropic client)', () => {
  let stub: StubAnthropic;

  beforeEach(() => {
    stub = new StubAnthropic();
    __setClaudeClientForTests(stub);
  });

  afterEach(() => {
    __setClaudeClientForTests(null);
  });

  it('returns plain text when structured is not set', async () => {
    const result = await callClaude({ tier: 'haiku', userPrompt: 'salut' });
    expect(result).toBe('bonjour');
    expect(stub.lastCall.model).toBe('claude-haiku-4-5-20251001');
    expect(stub.lastCall.max_tokens).toBe(1024); // default
    expect(stub.lastCall.messages).toEqual([{ role: 'user', content: 'salut' }]);
  });

  it('honors maxTokens — passed as a hard cap to the SDK', async () => {
    await callClaude({ tier: 'haiku', userPrompt: 'x', maxTokens: 300 });
    expect(stub.lastCall.max_tokens).toBe(300);
  });

  it('returns a structured outcome with usage tokens when requested', async () => {
    const result = (await callClaude({
      tier: 'sonnet',
      userPrompt: 'salut',
      structured: true,
    })) as ClaudeCallStructuredOutcome;
    expect(result.text).toBe('bonjour');
    expect(result.tier).toBe('sonnet');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(7);
    expect(result.cacheReadInputTokens).toBe(0);
    expect(result.cacheCreationInputTokens).toBe(0);
    expect(result.stopReason).toBe('end_turn');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('composes systemPrompt + systemFragments into the system field', async () => {
    await callClaude({
      tier: 'sonnet',
      systemPrompt: 'You are F16',
      systemFragments: [{ text: 'Cached rubric', cache: true }, { text: 'Per-turn note' }],
      userPrompt: 'hi',
    });
    const sys = stub.lastCall.system!;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys.length).toBe(3);
    expect(sys[0]!.text).toBe('You are F16');
    expect(sys[0]!.cache_control).toBeUndefined();
    expect(sys[1]!.text).toBe('Cached rubric');
    expect(sys[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[2]!.text).toBe('Per-turn note');
    expect(sys[2]!.cache_control).toBeUndefined();
  });

  it('emits cache_control on the LAST cached fragment only', async () => {
    await callClaude({
      tier: 'sonnet',
      systemFragments: [{ text: 'A', cache: true }, { text: 'B', cache: true }, { text: 'C' }],
      userPrompt: 'hi',
    });
    const sys = stub.lastCall.system!;
    expect(sys[0]!.cache_control).toBeUndefined();
    expect(sys[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[2]!.cache_control).toBeUndefined();
  });

  it('omits system when neither systemPrompt nor systemFragments are given', async () => {
    await callClaude({ tier: 'haiku', userPrompt: 'x' });
    expect(stub.lastCall.system).toBeUndefined();
  });

  it('reports cache tokens when the SDK returns them', async () => {
    stub.response = {
      ...stub.response,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 50,
      },
    };
    const result = (await callClaude({
      tier: 'sonnet',
      userPrompt: 'x',
      structured: true,
    })) as ClaudeCallStructuredOutcome;
    expect(result.cacheReadInputTokens).toBe(50);
    expect(result.cacheCreationInputTokens).toBe(10);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
  });

  it('aggregates multiple text blocks in the response', async () => {
    stub.response = {
      ...stub.response,
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
    };
    const result = await callClaude({ tier: 'haiku', userPrompt: 'x' });
    expect(result).toBe('hello world');
  });

  it('propagates SDK errors with no secret leakage in the message', async () => {
    __setClaudeClientForTests({
      messages: {
        create: async (): Promise<never> => {
          throw new Error('rate_limit_exceeded');
        },
      },
    });
    await expect(callClaude({ tier: 'haiku', userPrompt: 'x' })).rejects.toThrow(
      /rate_limit_exceeded/,
    );
  });

  it('throws if ANTHROPIC_API_KEY is unset and no stub client is injected', async () => {
    __setClaudeClientForTests(null);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(callClaude({ tier: 'haiku', userPrompt: 'x' })).rejects.toThrow(
        /ANTHROPIC_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('maps each tier to the correct model id', async () => {
    await callClaude({ tier: 'haiku', userPrompt: 'x' });
    expect(stub.lastCall.model).toBe('claude-haiku-4-5-20251001');
    await callClaude({ tier: 'sonnet', userPrompt: 'x' });
    expect(stub.lastCall.model).toBe('claude-sonnet-4-6');
    await callClaude({ tier: 'opus', userPrompt: 'x' });
    expect(stub.lastCall.model).toBe('claude-opus-4-7');
  });
});
