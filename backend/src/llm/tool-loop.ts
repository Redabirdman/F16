/**
 * Claude tool-use loop — F16 M6.T5.
 *
 * Generic wrapper around `callClaude` that lets the model call our typed tools
 * mid-turn. Lives next to `claude.ts` so both share the same Anthropic client
 * singleton + test seam (see `getClaudeClientForToolLoop`).
 *
 * Loop shape (Anthropic tool-use protocol):
 *   1. Send the user prompt + the agent's allowed tools.
 *   2. If the response has `tool_use` blocks → for each, invoke the matching
 *      registered tool via `invokeTool` and append a `tool_result` block
 *      (keyed by `tool_use_id`) to the next request's user message.
 *   3. Loop until the response is text-only (no `tool_use` blocks), capped at
 *      `maxIterations` (default 8) so a buggy / adversarial model can't burn
 *      tokens forever.
 *
 * Name translation:
 *   Our registry uses dotted names (`customer.read_profile`); Anthropic's tool
 *   name regex is `[a-zA-Z0-9_-]+`. We swap `.` ↔ `_` at the boundary and keep
 *   a per-call map so the response's anthropic-name maps back to the real
 *   registry name when we invoke.
 *
 * Tool errors:
 *   A throw from `invokeTool` is captured into a `tool_result` block with
 *   `is_error: true` so the model can self-correct, NOT propagated up. The
 *   loop continues. The trace records `ok: false` for observability.
 *
 * Out of scope (deferred):
 *   - Streaming tool calls — V1 waits for the full response per iteration.
 *   - Real JSON Schema generation from zod — V1 emits `{type:'object',
 *     additionalProperties:true}` and relies on the tool description. M16 can
 *     swap in `zod-to-json-schema` once a tool's contract needs strict shape.
 *   - Per-tool / per-conversation tool quotas — caller curates the tools list.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ToolUseBlock,
  TextBlock,
  Tool as AnthropicTool,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/messages.mjs';
import { z } from 'zod';
import type { ModelTier } from '../agents/base.js';
import { modelIdForTier } from './router.js';
import { buildSystemPrompt, type SystemFragment } from './cache.js';
import type { Tool, ToolContext } from '../tools/registry.js';
import { invokeTool } from '../tools/registry.js';
import { logger } from '../logger.js';
import { getClaudeClientForToolLoop } from './claude.js';
import { maybeAlertLlmBillingError } from './billing-alert.js';
import { recordLlmUsage, usageTagsFromLogContext } from './usage-log.js';

export interface ToolLoopInput {
  tier: ModelTier;
  /** Ordered, cache-aware fragments — same shape as `callClaude`. */
  systemFragments?: readonly SystemFragment[];
  /** Plain-string system preamble, combinable with `systemFragments`. */
  systemPrompt?: string;
  userPrompt: string;
  /** Tools available to the model. Pass an empty array to behave like `callClaude`. */
  tools: readonly Tool[];
  /** Context handed to every tool invocation. */
  toolContext: ToolContext;
  /** Hard cap on output tokens per Anthropic call. Defaults to 1024. */
  maxTokens?: number;
  /** Hard cap on tool-call iterations. Default 8. */
  maxIterations?: number;
  /** Optional log context — never sent to the model. */
  logContext?: Record<string, unknown>;
}

export interface ToolCallTraceEntry {
  /** 1-indexed loop iteration in which this tool was invoked. */
  iteration: number;
  /** Registry name (dotted), NOT the anthropic-mangled name. */
  toolName: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ToolLoopOutput {
  /** Final assistant text. Empty string when the loop hit `maxIterations`. */
  text: string;
  /** Number of `messages.create` round-trips. */
  iterations: number;
  toolCalls: ToolCallTraceEntry[];
  /** Last response's `stop_reason`, or `'max_iterations'` if budget exhausted. */
  stopReason: string | null;
  /** Cumulative usage across every iteration. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  model: string;
  tier: ModelTier;
}

/**
 * Translate F16 registry name → Anthropic tool name. Anthropic accepts only
 * `[a-zA-Z0-9_-]+`; our registry uses dotted names.
 */
function toAnthropicName(name: string): string {
  return name.replace(/\./g, '_');
}

/**
 * Permissive zod→JSON-Schema bridge. V1 emits a wide object schema — Claude is
 * robust to this and learns shape from the tool description. M16 may swap in
 * the `zod-to-json-schema` package for callers that need strict validation
 * before the tool's own `inputSchema.safeParse` runs inside `invokeTool`.
 */
const PERMISSIVE_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as unknown as AnthropicTool['input_schema'];

/**
 * Convert a tool's zod input schema into the JSON Schema Anthropic hands to the
 * model, so it knows the exact arguments to pass (field names, enums, formats)
 * instead of guessing from the prose description.
 *
 * Two deliberate transforms:
 *   - Internal identity fields (`customerId`/`leadId`) are STRIPPED from the
 *     model-facing schema: they're injected server-side from ToolContext (see
 *     registry.invokeTool), never supplied — or trustable — from the model.
 *   - On any conversion failure (an unrepresentable zod construct), fall back to
 *     the permissive `{type:'object'}` stub so a tool can never break the loop.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): AnthropicTool['input_schema'] {
  try {
    const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
    if (!json || json['type'] !== 'object') return PERMISSIVE_SCHEMA;
    const props = json['properties'];
    if (props && typeof props === 'object') {
      delete (props as Record<string, unknown>)['customerId'];
      delete (props as Record<string, unknown>)['leadId'];
    }
    if (Array.isArray(json['required'])) {
      json['required'] = (json['required'] as string[]).filter(
        (r) => r !== 'customerId' && r !== 'leadId',
      );
    }
    return json as unknown as AnthropicTool['input_schema'];
  } catch {
    return PERMISSIVE_SCHEMA;
  }
}

/**
 * Compose the system field same way `callClaude` does — plain preamble first,
 * then cache-aware fragments. Returns `undefined` when neither is present so
 * we can omit the field entirely from the request.
 */
function composeSystemBlocks(
  systemPrompt: string | undefined,
  systemFragments: readonly SystemFragment[] | undefined,
): Anthropic.Messages.TextBlockParam[] | undefined {
  const blocks: Anthropic.Messages.TextBlockParam[] = [];
  if (systemPrompt && systemPrompt.length > 0) {
    blocks.push({ type: 'text', text: systemPrompt });
  }
  if (systemFragments && systemFragments.length > 0) {
    for (const block of buildSystemPrompt(systemFragments)) {
      blocks.push(block as Anthropic.Messages.TextBlockParam);
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Run a tool-using Claude completion. Handles the request → response → tool
 * invocation → response loop until the model returns text-only or the
 * iteration budget is exhausted.
 */
export async function callClaudeWithTools(input: ToolLoopInput): Promise<ToolLoopOutput> {
  const client = getClaudeClientForToolLoop();
  const modelId = modelIdForTier(input.tier);
  const maxIterations = input.maxIterations ?? 8;
  const maxTokens = input.maxTokens ?? 1024;
  const system = composeSystemBlocks(input.systemPrompt, input.systemFragments);

  // Build the anthropic-side tools list + reverse map for name translation.
  const anthropicTools: AnthropicTool[] = input.tools.map((tool) => ({
    name: toAnthropicName(tool.name),
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  }));
  const nameMap = new Map<string, string>();
  for (const tool of input.tools) {
    nameMap.set(toAnthropicName(tool.name), tool.name);
  }

  const messages: MessageParam[] = [{ role: 'user', content: input.userPrompt }];
  const trace: ToolCallTraceEntry[] = [];
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let lastStopReason: string | null = null;
  let iteration = 0;
  const startedAt = Date.now();

  // Persist cumulative token usage for the admin costs page — fire-and-forget,
  // no-op when no sink is registered (tests / scripts).
  const recordUsage = (): void => {
    recordLlmUsage({
      model: modelId,
      tier: input.tier,
      ...usageTagsFromLogContext(input.logContext),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheCreationTokens: usage.cacheCreationInputTokens,
      durationMs: Date.now() - startedAt,
      iterations: iteration,
    });
  };

  while (iteration < maxIterations) {
    iteration += 1;

    const req: Parameters<typeof client.messages.create>[0] = {
      model: modelId,
      max_tokens: maxTokens,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    };
    let resp: Anthropic.Messages.Message;
    try {
      resp = (await client.messages.create(req)) as Anthropic.Messages.Message;
    } catch (err) {
      // Credits-exhausted / key-revoked kills the whole sales brain silently —
      // wake management directly (LLM-free, throttled 1/h), then rethrow.
      maybeAlertLlmBillingError(err instanceof Error ? err.message : String(err));
      throw err;
    }

    // Accumulate usage across iterations so the caller sees the full cost.
    const u = resp.usage;
    usage.inputTokens += u.input_tokens;
    usage.outputTokens += u.output_tokens;
    usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
    usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
    lastStopReason = resp.stop_reason ?? null;

    // Always append the assistant turn (entire content[]) so the next request
    // carries the model's tool_use ids alongside the matching tool_result.
    messages.push({ role: 'assistant', content: resp.content });

    const toolUseBlocks = resp.content.filter(
      (b: ContentBlock): b is ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      // Final turn — collect text and return.
      const text = resp.content
        .filter((b: ContentBlock): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      recordUsage();
      return {
        text,
        iterations: iteration,
        toolCalls: trace,
        stopReason: lastStopReason,
        usage,
        model: modelId,
        tier: input.tier,
      };
    }

    // Execute every tool_use block in order. Each gets its own tool_result.
    const toolResults: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const block of toolUseBlocks) {
      const t0 = Date.now();
      const f16Name = nameMap.get(block.name) ?? block.name;
      try {
        const result = await invokeTool(input.toolContext, f16Name, block.input);
        const durationMs = Date.now() - t0;
        trace.push({ iteration, toolName: f16Name, durationMs, ok: true });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result ?? {}),
        });
      } catch (err) {
        const durationMs = Date.now() - t0;
        const errMsg = err instanceof Error ? err.message : String(err);
        trace.push({ iteration, toolName: f16Name, durationMs, ok: false, error: errMsg });
        // is_error tells Claude the tool failed; the next iteration usually
        // sees the model retry with corrected input or recover gracefully.
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ error: errMsg }),
          is_error: true,
        });
        logger.warn(
          { tool: f16Name, err: errMsg, iteration, ...(input.logContext ?? {}) },
          'tool-loop: tool invocation failed',
        );
      }
    }

    // tool_result blocks go in a user-role message — that's the protocol.
    messages.push({ role: 'user', content: toolResults });
  }

  // Iteration budget exhausted — log + return what we have. Empty text signals
  // the caller (Sales Agent) to fall through to its "empty reply" branch.
  logger.warn(
    {
      iterations: iteration,
      maxIterations,
      ...(input.logContext ?? {}),
    },
    'tool-loop: max iterations reached without end_turn',
  );
  recordUsage();
  return {
    text: '',
    iterations: iteration,
    toolCalls: trace,
    stopReason: 'max_iterations',
    usage,
    model: modelId,
    tier: input.tier,
  };
}
