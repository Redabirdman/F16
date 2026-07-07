/**
 * Claude wrapper — F16 M3.T5 / M6.T1.
 *
 * Thin single-turn text-in / text-out facade over the raw `@anthropic-ai/sdk`.
 *
 * Why the raw SDK and not `@anthropic-ai/claude-agent-sdk` (M6.T1 swap):
 *   - The Agent SDK spawns the bundled `claude` CLI as a subprocess per call
 *     (~200-500ms cold start) and ignores `max_tokens` (advisory only). M5.T3
 *     surfaced this — a Haiku call with maxTokens=300 burned 2291 output tokens.
 *   - The Agent SDK also injects ~95 tokens of fresh per-call dynamic content,
 *     fighting prompt caching.
 *   - The raw SDK is pure HTTP — no subprocess, `max_tokens` is a real hard
 *     cap, and per-block `cache_control: { type: 'ephemeral' }` works natively
 *     against the same Anthropic endpoints, billing, and caching pricing.
 *
 * Public surface (`callClaude`, `ClaudeCallInput`, `ClaudeCallStructuredOutcome`)
 * is preserved verbatim so downstream callers (Lead Scorer M5.T3, future
 * Sales Agent M6.T3) do not need to change.
 *
 * R2 routing: this wrapper goes Anthropic-direct (the SDK reads `ANTHROPIC_API_KEY`
 * from the env). OpenRouter is reserved for non-Claude calls (e.g. Nano Banana Pro
 * image gen in M12), because OpenRouter does not preserve prompt caching.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs';
import type { ModelTier } from '../agents/base.js';
import { modelIdForTier } from './router.js';
import { buildSystemPrompt, type SystemFragment } from './cache.js';
import { maybeAlertLlmBillingError } from './billing-alert.js';
import { logger } from '../logger.js';

export interface ClaudeCallInput {
  tier: ModelTier;
  /** Plain-string system prompt — combinable with `systemFragments`. */
  systemPrompt?: string;
  /**
   * Ordered fragments with cache markers. The LAST fragment marked
   * `cache: true` carries the `cache_control` breakpoint; everything before
   * it sits inside the implicitly cached prefix; everything after it is
   * dynamic per-turn content.
   */
  systemFragments?: readonly SystemFragment[];
  userPrompt: string;
  /**
   * Hard cap on output tokens. With the raw SDK this is the real Anthropic
   * `max_tokens` knob (unlike the Agent SDK, where it was advisory only).
   * Defaults to 1024 when omitted.
   */
  maxTokens?: number;
  /** When true, returns a structured outcome object. When false (default), returns just the text. */
  structured?: boolean;
  /**
   * Optional AbortSignal — forwarded to the SDK request. The raw SDK accepts
   * `signal` directly so no AbortController adapter is needed.
   */
  signal?: AbortSignal;
  /** Optional log context — never sent to the model. */
  logContext?: Record<string, unknown>;
}

export interface ClaudeCallStructuredOutcome {
  text: string;
  model: string;
  tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /**
   * Total cost in USD. The raw SDK does not report this directly; we report
   * 0 here so the shape stays stable for callers. Cost is best derived from
   * token usage × tier price tables at the call site.
   */
  costUsd: number;
  /** `'end_turn'`, `'max_tokens'`, `'stop_sequence'`, `'tool_use'`, or null. */
  stopReason: string | null;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
}

/**
 * Lazily-constructed singleton Anthropic client. Re-created the first time
 * `callClaude` runs after `__setClaudeClientForTests(null)` resets it.
 */
let _client: Anthropic | null = null;

/** Minimal contract we need from the SDK at runtime — kept narrow so tests can stub it. */
interface AnthropicLike {
  messages: {
    create: (
      req: Parameters<Anthropic['messages']['create']>[0],
    ) => Promise<Awaited<ReturnType<Anthropic['messages']['create']>>>;
  };
}

function getClient(): AnthropicLike {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — required for callClaude. Set it in the environment.',
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Test-only seam. Lets unit tests inject a stub Anthropic-like client so the
 * code path can be exercised without an API key or network call. Pass `null`
 * to reset back to the lazily-constructed real client.
 *
 * Typed as `unknown` so tests can hand in minimal stub objects that only
 * implement the surface `callClaude` actually touches (`messages.create`).
 */
export function __setClaudeClientForTests(client: unknown): void {
  _client = client as Anthropic | null;
}

/**
 * Accessor for the same lazily-constructed Anthropic client `callClaude` uses
 * internally. M6.T5's tool-loop wrapper goes through this so it shares the
 * `__setClaudeClientForTests` injection seam — tests don't need a second stub
 * hook for the tool-using path. Returns the narrow `AnthropicLike` shape; the
 * cast to `Anthropic` at the call site is fine since both `callClaude` and the
 * tool-loop only touch `messages.create`.
 */
export function getClaudeClientForToolLoop(): AnthropicLike {
  return getClient();
}

/**
 * Compose the request's `system` field. The raw SDK accepts a plain string OR
 * an array of `TextBlockParam`s. We always emit blocks when we have either
 * fragments OR a mix of fragments + plain prompt, so cache_control can land on
 * the right block. Returns `undefined` if there is no system content at all.
 */
function composeSystemBlocks(
  systemPrompt: string | undefined,
  systemFragments: readonly SystemFragment[] | undefined,
): TextBlockParam[] | undefined {
  const blocks: TextBlockParam[] = [];

  // A plain string prompt becomes the first block (no cache_control). When
  // combined with fragments, this lets callers put a tiny role preamble in
  // front of a long cached rubric without touching cache.ts.
  if (systemPrompt && systemPrompt.length > 0) {
    blocks.push({ type: 'text', text: systemPrompt });
  }

  if (systemFragments && systemFragments.length > 0) {
    // buildSystemPrompt already returns `TextBlockParam`-shaped blocks with
    // cache_control on the LAST fragment marked `cache: true`. No translation
    // needed for the raw SDK.
    for (const block of buildSystemPrompt(systemFragments)) {
      blocks.push(block as TextBlockParam);
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Run a single Claude completion via the raw Anthropic SDK.
 *
 * Returns the assistant text (default) or a structured outcome with usage
 * stats when `structured: true`. Throws on transport / API errors — the SDK
 * surfaces these as typed exceptions, no result-shape inspection needed.
 */
export async function callClaude(
  input: ClaudeCallInput,
): Promise<string | ClaudeCallStructuredOutcome> {
  const modelId = modelIdForTier(input.tier);
  const system = composeSystemBlocks(input.systemPrompt, input.systemFragments);

  const messages: MessageParam[] = [{ role: 'user', content: input.userPrompt }];

  const maxTokens = input.maxTokens ?? 1024;

  const startedAt = Date.now();
  logger.debug(
    { tier: input.tier, model: modelId, ...(input.logContext ?? {}) },
    'claude.call.start',
  );

  let resp: Message;
  try {
    // We never pass `stream: true`, so the SDK returns a `Message` (not a
    // `Stream<...>`). The cast narrows the union for downstream code.
    resp = (await getClient().messages.create({
      model: modelId,
      max_tokens: maxTokens,
      ...(system !== undefined ? { system } : {}),
      messages,
      ...(input.signal ? { signal: input.signal } : {}),
    })) as Message;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        tier: input.tier,
        model: modelId,
        err: errMsg,
        ...(input.logContext ?? {}),
      },
      'claude.call.error',
    );
    // Credits-exhausted / key-revoked = the ENTIRE brain is down and customers
    // get silence — wake management directly (LLM-free, throttled 1/h).
    maybeAlertLlmBillingError(errMsg);
    throw err;
  }

  // Aggregate text from response.content blocks. Tool use is out of scope for
  // M6.T1 — M6.T5 will extend this.
  let textOut = '';
  for (const block of resp.content) {
    if (block.type === 'text') textOut += block.text;
  }

  const usage = resp.usage;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const durationMs = Date.now() - startedAt;

  logger.debug(
    {
      tier: input.tier,
      model: modelId,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      stopReason: resp.stop_reason,
      durationMs,
      ...(input.logContext ?? {}),
    },
    'claude.call.ok',
  );

  if (input.structured) {
    return {
      text: textOut,
      model: modelId,
      tier: input.tier,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      // Cost is not reported by the raw SDK. Callers that need it should
      // derive from tokens × tier price tables.
      costUsd: 0,
      stopReason: resp.stop_reason,
      durationMs,
    };
  }
  return textOut;
}
