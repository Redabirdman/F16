/**
 * Typed tool registry (design §6.3 / M3.T6).
 *
 * Tools are the surface an agent uses to *do* things. Each tool declares
 *   - a stable name (e.g. `customer.read_profile`),
 *   - a zod schema for its input (also the basis for the JSON Schema we hand
 *     to the Claude Agent SDK / any MCP client),
 *   - an optional zod schema for its output (defense-in-depth: callers cannot
 *     accidentally exfiltrate fields the contract didn't promise), and
 *   - a handler `(ctx, input) -> Promise<output>`.
 *
 * The registry is process-wide (module-level Map) — tools self-register at
 * import time via `registerTool({...})`. The `builtins/index.ts` barrel exists
 * specifically so importing it triggers registration of the in-tree starters.
 *
 * Invocation always flows through `invokeTool` so that:
 *   - the input is validated against the tool's zod schema BEFORE the handler
 *     runs (the agent can't poke past the contract),
 *   - the handler return value is validated against the output schema if one
 *     is declared (so a buggy handler can't accidentally leak extra fields),
 *   - errors carry the tool name (legible audit trails).
 *
 * Out of scope for M3.T6 (deferred):
 *   - Wiring tools into the Claude Agent SDK as MCP tools (lands in M6 when the
 *     Sales Agent first invokes them through the SDK).
 *   - zod-to-json-schema conversion in `describeForLLM` — right now we emit a
 *     placeholder `{ type: 'object' }` and rely on the description for the LLM.
 *     M6 will swap in real JSON Schema generation.
 *   - Per-call permission policy beyond the agent's static `allowedTools` list.
 */
import type { z } from 'zod';
import type { Database } from '../db/index.js';

/**
 * Execution context passed to every tool handler.
 *
 * Carries the DB handle (already opened by the caller — tools do not own
 * connection lifecycle), the agent identity (used for audit_log and for
 * `created_by_agent` on human_actions), and an optional correlation id that
 * downstream side effects (agent_messages, audit rows) should carry forward.
 */
export interface ToolContext {
  db: Database;
  /** Static agent role, e.g. `sales-agent`. */
  agentRole: string;
  /** Per-process instance discriminator, e.g. `sales-agent#abc123`. */
  agentInstance: string;
  /** Free-form correlation key — lead_id, customer_id, conversation_id, ... */
  correlationId?: string;
  /**
   * Server-authoritative customer id. When set, `invokeTool` injects it into
   * the tool input, OVERRIDING any value the LLM supplied. The LLM is never
   * told these internal UUIDs (they're stripped from the JSON Schema it sees),
   * and identity must never be trusted from the model — this prevents a tool
   * from acting on the wrong customer.
   */
  customerId?: string;
  /** Server-authoritative lead id — injected + override, same rationale as customerId. */
  leadId?: string;
}

/**
 * A tool an agent can invoke. Generic over its input + output types so callers
 * that use the registry directly (tests, internal orchestration) get full
 * type-safety on the return shape — at runtime, the registry uses zod to
 * police the boundary.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Stable dotted name, e.g. `customer.read_profile`. */
  name: string;
  /** Short prose surfaced to the LLM — describe *what* and *when*, not how. */
  description: string;
  /** zod schema validating the input. */
  inputSchema: z.ZodType<TInput>;
  /** Optional zod schema validating the handler return value. */
  outputSchema?: z.ZodType<TOutput>;
  handler: (ctx: ToolContext, input: TInput) => Promise<TOutput>;
}

// Internal — never expose the Map; force all reads through the helpers below.
const _registry = new Map<string, Tool<unknown, unknown>>();

/**
 * Register a tool at import time. Throws on duplicate names so accidental
 * shadowing (two files registering the same tool) is loud rather than silent.
 */
export function registerTool<TInput, TOutput>(tool: Tool<TInput, TOutput>): void {
  if (_registry.has(tool.name)) {
    throw new Error(`Tool ${tool.name} already registered`);
  }
  _registry.set(tool.name, tool as unknown as Tool<unknown, unknown>);
}

/** Look up a tool by name. Returns undefined for unknown tools (caller decides). */
export function getTool(name: string): Tool | undefined {
  return _registry.get(name);
}

/**
 * List all registered tools, optionally filtered to a whitelist.
 *
 * Pass `{ allowed }` to scope to the agent's `allowedTools` list — this is
 * the hook the Claude Agent SDK wiring will use (M6) so that the LLM is only
 * told about tools its agent role can call.
 */
export function listTools(filter?: { allowed?: readonly string[] }): Tool[] {
  const all = [..._registry.values()];
  if (filter?.allowed) {
    const set = new Set(filter.allowed);
    return all.filter((t) => set.has(t.name));
  }
  return all;
}

/**
 * Invoke a tool by name. Validates input + output via zod and returns the
 * typed result.
 *
 * Throws when:
 *   - the tool is unknown,
 *   - the input fails the input schema (issues serialized into the message),
 *   - the output fails the output schema (deliberately vague — the output may
 *     contain PII, so we do NOT leak its shape into the error).
 */
export async function invokeTool(
  ctx: ToolContext,
  name: string,
  rawInput: unknown,
): Promise<unknown> {
  const tool = _registry.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  // Inject server-authoritative identity (customerId/leadId) from the context,
  // OVERRIDING anything the model supplied. The LLM never sees these internal
  // UUIDs (they're stripped from the JSON Schema handed to it), so it can't
  // pass them — and even if it tried, it must not be trusted to. For tools
  // that don't declare these fields, zod's default object parsing strips them.
  const effectiveInput = withContextIds(ctx, rawInput);

  const inputParse = tool.inputSchema.safeParse(effectiveInput);
  if (!inputParse.success) {
    throw new Error(`Invalid input for tool ${name}: ${JSON.stringify(inputParse.error.issues)}`);
  }

  const output = await tool.handler(ctx, inputParse.data as never);

  if (tool.outputSchema) {
    const outputParse = tool.outputSchema.safeParse(output);
    if (!outputParse.success) {
      // Intentionally vague — output may contain decrypted PII.
      throw new Error(`Tool ${name} returned data that doesn't match its outputSchema`);
    }
    return outputParse.data;
  }
  return output;
}

/**
 * Merge the context's server-authoritative `customerId`/`leadId` onto the raw
 * tool input, with the CONTEXT winning. Returns the input unchanged when the
 * context carries neither id. Keys the tool schema doesn't declare are dropped
 * by zod's default object parsing, so this is safe to apply to every tool.
 */
function withContextIds(ctx: ToolContext, rawInput: unknown): unknown {
  if (ctx.customerId === undefined && ctx.leadId === undefined) return rawInput;
  const base =
    rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
  return {
    ...base,
    ...(ctx.customerId !== undefined ? { customerId: ctx.customerId } : {}),
    ...(ctx.leadId !== undefined ? { leadId: ctx.leadId } : {}),
  };
}

/**
 * Produce a JSON Schema-shaped tool definition list for handing to the
 * Claude Agent SDK (or any MCP client).
 *
 * For now the `input_schema` is a placeholder `{ type: 'object' }` — the LLM
 * sees the description and learns the shape from runtime errors during dev.
 * M6 will swap in real zod-to-json-schema once the Sales Agent invokes tools
 * through the SDK.
 */
export function describeForLLM(filter?: { allowed?: readonly string[] }): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return listTools(filter).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object' as const },
  }));
}

/**
 * Test-only escape hatch — clears the registry so a test that wants to
 * register fixture tools starts from a known empty state. Not part of the
 * public API.
 */
export function __resetToolsForTests(): void {
  _registry.clear();
}
