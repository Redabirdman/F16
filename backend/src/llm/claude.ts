/**
 * Claude wrapper — F16 M3.T5.
 *
 * Thin single-turn text-in / text-out facade over `@anthropic-ai/claude-agent-sdk`.
 * Tool use, sub-agents, MCP servers, and full agent loops land in M3.T6+ / M6;
 * this module exists so M3 agents can already invoke the right model tier with
 * proper prompt caching and predictable structured outcomes.
 *
 * SDK shape (Agent SDK 0.3.143):
 *   - `query({ prompt, options })` returns an async iterable of `SDKMessage`s.
 *   - The Agent SDK spawns the bundled `claude` binary as a subprocess and
 *     streams messages back over stdout. To keep that subprocess inert (no
 *     filesystem writes, no permission prompts, no Claude.md auto-loading) we
 *     pin `settingSources: []`, `tools: []`, and `permissionMode: 'bypassPermissions'`.
 *   - Prompt-caching uses `systemPrompt: string[]` with the SDK-exported sentinel
 *     `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` to split the cacheable prefix from the
 *     per-turn dynamic suffix.
 *   - Usage stats (input/output/cache tokens) arrive on the terminal
 *     `SDKResultSuccess` message.
 *
 * R2 routing: this wrapper goes Anthropic-direct (the SDK reads `ANTHROPIC_API_KEY`
 * from the env). OpenRouter is reserved for non-Claude calls (e.g. Nano Banana Pro
 * image gen in M12), because OpenRouter does not preserve prompt caching.
 */
import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type Options as QueryOptions,
  type SDKMessage,
  type SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import type { ModelTier } from '../agents/base.js';
import { modelIdForTier } from './router.js';
import type { SystemFragment } from './cache.js';
import { logger } from '../logger.js';

export interface ClaudeCallInput {
  tier: ModelTier;
  /** Plain-string system prompt — mutually exclusive with `systemFragments`. */
  systemPrompt?: string;
  /**
   * Ordered fragments with cache markers. The last fragment marked `cache: true`
   * becomes the cache breakpoint; everything before is cached, everything after
   * is dynamic per-turn content.
   */
  systemFragments?: readonly SystemFragment[];
  userPrompt: string;
  /**
   * Cap on output tokens. The Agent SDK does not expose a direct max_tokens
   * knob, so this maps to `maxTurns: 1` plus a `maxBudgetUsd` derived from the
   * tier's output price. For M3.T5 this is purely advisory — the live tests
   * keep prompts short, so a single turn produces ≤ this many tokens in practice.
   */
  maxTokens?: number;
  /** When true, returns a structured outcome object. When false (default), returns just the text. */
  structured?: boolean;
  /**
   * Optional AbortSignal — pass through to cancel mid-call. The SDK accepts an
   * `AbortController`; we adapt the signal here.
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
  /** Total cost in USD, as reported by the SDK's result message. */
  costUsd: number;
  /** `'end_turn'`, `'max_tokens'`, `'stop_sequence'`, `'tool_use'`, or null. */
  stopReason: string | null;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
}

/**
 * Compose the SDK's `systemPrompt` argument from a plain string or cache-aware
 * fragments. Returns `undefined` if there is no system content at all.
 */
function composeSystemPrompt(
  systemPrompt: string | undefined,
  systemFragments: readonly SystemFragment[] | undefined,
): string | string[] | undefined {
  if (systemFragments && systemFragments.length > 0) {
    // Walk fragments; insert SYSTEM_PROMPT_DYNAMIC_BOUNDARY right after the last
    // cached fragment. Everything up to and including the cached fragment is the
    // cacheable prefix; everything after the boundary is dynamic.
    let lastCacheIdx = -1;
    systemFragments.forEach((f, i) => {
      if (f.cache) lastCacheIdx = i;
    });

    const out: string[] = [];
    systemFragments.forEach((f, i) => {
      out.push(f.text);
      // Insert the boundary AFTER the last cached fragment (only if there are
      // dynamic fragments after it; otherwise the whole prompt is cacheable and
      // the boundary adds nothing).
      if (i === lastCacheIdx && i < systemFragments.length - 1) {
        out.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      }
    });

    // If a plain `systemPrompt` was also supplied, append it as a final dynamic block.
    if (systemPrompt) {
      // If there's no boundary yet (i.e. nothing was marked cacheable), there's
      // nothing to cache — fall through and just join with the dynamic prompt.
      if (lastCacheIdx === -1) {
        out.push(systemPrompt);
      } else {
        // Ensure a boundary separates cache from this trailing dynamic content.
        if (!out.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
          out.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
        }
        out.push(systemPrompt);
      }
    }

    return out;
  }
  if (systemPrompt && systemPrompt.length > 0) return systemPrompt;
  return undefined;
}

/**
 * Run a single Claude completion via the Agent SDK.
 *
 * Returns the assistant text (default) or a structured outcome with usage
 * stats when `structured: true`. Throws if the SDK reports an error result.
 */
export async function callClaude(
  input: ClaudeCallInput,
): Promise<string | ClaudeCallStructuredOutcome> {
  const modelId = modelIdForTier(input.tier);
  const systemPrompt = composeSystemPrompt(input.systemPrompt, input.systemFragments);

  // Adapt AbortSignal → AbortController (SDK option).
  let abortController: AbortController | undefined;
  if (input.signal) {
    abortController = new AbortController();
    if (input.signal.aborted) abortController.abort();
    else input.signal.addEventListener('abort', () => abortController?.abort(), { once: true });
  }

  // Lock the subprocess down to a single inert turn. The SDK still spawns the
  // bundled `claude` binary; these flags keep it from loading user/project
  // settings, prompting for permissions, or invoking built-in tools.
  const options: QueryOptions = {
    model: modelId,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    maxTurns: 1,
    tools: [],
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    ...(abortController ? { abortController } : {}),
  };

  const startedAt = Date.now();
  logger.debug(
    { tier: input.tier, model: modelId, ...(input.logContext ?? {}) },
    'claude.call.start',
  );

  let textOut = '';
  let result: SDKResultSuccess | undefined;
  let errorResult: { subtype: string; message?: string } | undefined;

  try {
    for await (const msg of query({
      prompt: input.userPrompt,
      options,
    }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'assistant') {
        // The assistant message holds a BetaMessage with a `content` array.
        // Each content block is either {type:'text', text} or {type:'tool_use', ...}.
        // We disabled tools, so only text is expected.
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              textOut += block.text;
            }
          }
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          result = msg;
        } else {
          const errMsg = (msg as { result?: string }).result;
          errorResult =
            errMsg !== undefined
              ? { subtype: msg.subtype, message: errMsg }
              : { subtype: msg.subtype };
        }
      }
      // Other message types (system init, status, partial assistant) are ignored
      // for M3.T5 — they're observability noise for a single-turn text call.
    }
  } catch (err) {
    logger.error(
      {
        tier: input.tier,
        model: modelId,
        err: err instanceof Error ? err.message : String(err),
        ...(input.logContext ?? {}),
      },
      'claude.call.error',
    );
    throw err;
  }

  if (errorResult) {
    throw new Error(`claude.call.failed: ${errorResult.subtype} ${errorResult.message ?? ''}`);
  }
  if (!result) {
    throw new Error('claude.call.failed: no result message received');
  }

  const usage = result.usage;
  const durationMs = Date.now() - startedAt;

  logger.debug(
    {
      tier: input.tier,
      model: modelId,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      costUsd: result.total_cost_usd,
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
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      costUsd: result.total_cost_usd,
      stopReason: result.stop_reason,
      durationMs,
    };
  }
  return textOut;
}
