/**
 * callClaudeWithTools — unit tests against a stub Anthropic client. No network.
 *
 * Exercises the tool-use loop: tool_use → invokeTool → tool_result → next
 * iteration, with name translation between F16's dotted registry names and
 * Anthropic's `[a-zA-Z0-9_-]+` constraint, error capture (is_error), and the
 * `maxIterations` budget.
 *
 * No DB / Redis needed — we register fixture tools with synthetic handlers
 * and reset the registry around each test via `__resetToolsForTests`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { callClaudeWithTools } from '../../src/llm/tool-loop.js';
import { __setClaudeClientForTests } from '../../src/llm/claude.js';
import { registerTool, __resetToolsForTests, type ToolContext } from '../../src/tools/registry.js';

// Minimal Anthropic response shape — we only set what callClaudeWithTools reads.
type StubBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
    };

interface StubMessage {
  content: StubBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

interface StubRequest {
  model: string;
  max_tokens: number;
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
}

/**
 * Stub Anthropic — pops one queued response per `messages.create` call so a
 * test scripts a sequence (tool_use → text, two tool_uses → text, etc.).
 */
class ToolLoopStub {
  private responses: StubMessage[] = [];
  public calls: StubRequest[] = [];
  push(r: StubMessage): this {
    this.responses.push(r);
    return this;
  }
  messages = {
    create: async (req: StubRequest): Promise<StubMessage> => {
      // The loop reuses + mutates the same `messages` array between
      // iterations. Snapshot via structuredClone so each recorded call holds
      // the state AT REQUEST TIME, not the final post-loop state.
      this.calls.push({
        ...req,
        messages: structuredClone(req.messages),
      });
      const r = this.responses.shift();
      if (!r) throw new Error('ToolLoopStub: no more responses queued');
      return r;
    },
  };
  get lastCall(): StubRequest {
    const c = this.calls[this.calls.length - 1];
    if (!c) throw new Error('ToolLoopStub: no call recorded');
    return c;
  }
}

const fakeToolContext: ToolContext = {
  // Tests never touch db on these fixture tools.
  db: undefined as unknown as ToolContext['db'],
  agentRole: 'sales-agent',
  agentInstance: 'lead-test',
  correlationId: 'lead-xyz',
};

// Helper: build a usage block with optional cache tokens.
function usage(
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheCreate = 0,
): StubMessage['usage'] {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

describe('callClaudeWithTools (unit, stub Anthropic + fixture tools)', () => {
  let stub: ToolLoopStub;

  beforeEach(() => {
    __resetToolsForTests();
    stub = new ToolLoopStub();
    __setClaudeClientForTests(stub);
  });

  afterEach(() => {
    __setClaudeClientForTests(null);
    __resetToolsForTests();
  });

  // -------------------------------------------------------------------------
  // 1. No tools, text-only response — degenerate but valid path
  // -------------------------------------------------------------------------
  it('returns text on a single iteration when no tool_use blocks present', async () => {
    stub.push({
      content: [{ type: 'text', text: 'bonjour' }],
      stop_reason: 'end_turn',
      usage: usage(10, 5),
    });

    const result = await callClaudeWithTools({
      tier: 'haiku',
      userPrompt: 'salut',
      tools: [],
      toolContext: fakeToolContext,
    });

    expect(result.text).toBe('bonjour');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    // No tools provided → tools field omitted from request.
    expect(stub.lastCall.tools).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. One tool call → final text — happy path
  // -------------------------------------------------------------------------
  it('invokes a tool, appends tool_result, and returns the next-turn text', async () => {
    registerTool({
      name: 'knowledge.search',
      description: 'search KB',
      inputSchema: z.object({ query: z.string() }),
      handler: async (_ctx, _input) => [{ chunk: 'pricing page' }],
    });

    stub
      .push({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'knowledge_search',
            input: { query: 'x' },
          },
        ],
        stop_reason: 'tool_use',
        usage: usage(50, 10),
      })
      .push({
        content: [{ type: 'text', text: 'Voici la page de prix.' }],
        stop_reason: 'end_turn',
        usage: usage(60, 8),
      });

    const result = await callClaudeWithTools({
      tier: 'sonnet',
      userPrompt: 'parle-moi des prix',
      tools: [
        {
          name: 'knowledge.search',
          description: 'search KB',
          inputSchema: z.object({ query: z.string() }),
          handler: async () => null, // shadowed by registered tool
        },
      ],
      toolContext: fakeToolContext,
    });

    expect(result.text).toBe('Voici la page de prix.');
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      iteration: 1,
      toolName: 'knowledge.search',
      ok: true,
    });
    expect(result.stopReason).toBe('end_turn');

    // Second request must carry the tool_result keyed by the original use id.
    const second = stub.calls[1];
    expect(second).toBeDefined();
    const lastUserMsg = second!.messages[second!.messages.length - 1];
    expect(lastUserMsg).toBeDefined();
    expect(lastUserMsg!.role).toBe('user');
    const content = lastUserMsg!.content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('tool_result');
    expect(content[0]!.tool_use_id).toBe('toolu_1');
    expect(content[0]!.is_error).toBeUndefined();
    expect(JSON.parse(content[0]!.content)).toEqual([{ chunk: 'pricing page' }]);
  });

  // -------------------------------------------------------------------------
  // 3. Tool throws — captured as is_error tool_result, loop continues
  // -------------------------------------------------------------------------
  it('captures a thrown tool error as is_error=true and continues the loop', async () => {
    registerTool({
      name: 'customer.read_profile',
      description: 'read profile',
      inputSchema: z.object({ customerId: z.string() }),
      handler: async () => {
        throw new Error('Customer not found');
      },
    });

    stub
      .push({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_err',
            name: 'customer_read_profile',
            input: { customerId: 'unknown' },
          },
        ],
        stop_reason: 'tool_use',
        usage: usage(20, 5),
      })
      .push({
        content: [{ type: 'text', text: 'Désolé, je ne trouve pas le profil.' }],
        stop_reason: 'end_turn',
        usage: usage(25, 6),
      });

    const result = await callClaudeWithTools({
      tier: 'sonnet',
      userPrompt: 'qui suis-je ?',
      tools: [
        {
          name: 'customer.read_profile',
          description: 'read profile',
          inputSchema: z.object({ customerId: z.string() }),
          handler: async () => null,
        },
      ],
      toolContext: fakeToolContext,
    });

    expect(result.text).toBe('Désolé, je ne trouve pas le profil.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.toolCalls[0]!.error).toMatch(/Customer not found/);

    const second = stub.calls[1]!;
    const lastUserMsg = second.messages[second.messages.length - 1]!;
    const content = lastUserMsg.content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
    expect(content[0]!.is_error).toBe(true);
    expect(JSON.parse(content[0]!.content)).toEqual({ error: 'Customer not found' });
  });

  // -------------------------------------------------------------------------
  // 4. Two tool calls in one assistant message — both execute, both results
  //    appear in the next user message
  // -------------------------------------------------------------------------
  it('executes multiple tool_use blocks in one response and emits matching tool_results', async () => {
    let nReads = 0;
    let nSearches = 0;
    registerTool({
      name: 'customer.read_profile',
      description: 'r',
      inputSchema: z.object({ customerId: z.string() }),
      handler: async () => {
        nReads += 1;
        return { id: 'c1' };
      },
    });
    registerTool({
      name: 'knowledge.search',
      description: 's',
      inputSchema: z.object({ query: z.string() }),
      handler: async () => {
        nSearches += 1;
        return [{ chunk: 'kb' }];
      },
    });

    stub
      .push({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'customer_read_profile',
            input: { customerId: 'c1' },
          },
          {
            type: 'tool_use',
            id: 'toolu_b',
            name: 'knowledge_search',
            input: { query: 'q' },
          },
        ],
        stop_reason: 'tool_use',
        usage: usage(30, 8),
      })
      .push({
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: usage(15, 3),
      });

    const result = await callClaudeWithTools({
      tier: 'sonnet',
      userPrompt: 'hi',
      tools: [
        {
          name: 'customer.read_profile',
          description: 'r',
          inputSchema: z.object({ customerId: z.string() }),
          handler: async () => null,
        },
        {
          name: 'knowledge.search',
          description: 's',
          inputSchema: z.object({ query: z.string() }),
          handler: async () => null,
        },
      ],
      toolContext: fakeToolContext,
    });

    expect(result.text).toBe('OK');
    expect(nReads).toBe(1);
    expect(nSearches).toBe(1);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((t) => t.toolName)).toEqual([
      'customer.read_profile',
      'knowledge.search',
    ]);

    const second = stub.calls[1]!;
    const lastUserMsg = second.messages[second.messages.length - 1]!;
    const content = lastUserMsg.content as Array<{
      type: string;
      tool_use_id: string;
    }>;
    expect(content).toHaveLength(2);
    expect(content.map((c) => c.tool_use_id).sort()).toEqual(['toolu_a', 'toolu_b']);
  });

  // -------------------------------------------------------------------------
  // 5. Max iterations exceeded — loop stops, empty text, stopReason flag
  // -------------------------------------------------------------------------
  it('terminates after maxIterations when the model keeps asking for tools', async () => {
    registerTool({
      name: 'knowledge.search',
      description: 's',
      inputSchema: z.object({ query: z.string() }),
      handler: async () => [{ chunk: 'kb' }],
    });
    // Queue 3 tool_use responses — loop should stop after 3 iterations.
    for (let i = 0; i < 3; i += 1) {
      stub.push({
        content: [
          {
            type: 'tool_use',
            id: `toolu_${i}`,
            name: 'knowledge_search',
            input: { query: 'x' },
          },
        ],
        stop_reason: 'tool_use',
        usage: usage(5, 2),
      });
    }

    const result = await callClaudeWithTools({
      tier: 'haiku',
      userPrompt: 'go',
      tools: [
        {
          name: 'knowledge.search',
          description: 's',
          inputSchema: z.object({ query: z.string() }),
          handler: async () => null,
        },
      ],
      toolContext: fakeToolContext,
      maxIterations: 3,
    });

    expect(result.text).toBe('');
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.stopReason).toBe('max_iterations');
  });

  // -------------------------------------------------------------------------
  // 6. Name translation — registry uses dots, Anthropic sees underscores;
  //    response with the underscored name maps back to the real registered tool
  // -------------------------------------------------------------------------
  it('translates `.` ↔ `_` between registry and Anthropic tool names', async () => {
    let invoked = false;
    registerTool({
      name: 'customer.read_profile',
      description: 'r',
      inputSchema: z.object({ customerId: z.string() }),
      handler: async () => {
        invoked = true;
        return { id: 'c1' };
      },
    });

    stub
      .push({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_n',
            name: 'customer_read_profile', // underscore form
            input: { customerId: 'c1' },
          },
        ],
        stop_reason: 'tool_use',
        usage: usage(10, 3),
      })
      .push({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: usage(5, 2),
      });

    const result = await callClaudeWithTools({
      tier: 'sonnet',
      userPrompt: 'hi',
      tools: [
        {
          name: 'customer.read_profile',
          description: 'r',
          inputSchema: z.object({ customerId: z.string() }),
          handler: async () => null,
        },
      ],
      toolContext: fakeToolContext,
    });

    expect(invoked).toBe(true);
    expect(result.toolCalls[0]!.toolName).toBe('customer.read_profile'); // dotted form in trace
    // First request: anthropic-side name uses underscore.
    expect(stub.calls[0]!.tools).toBeDefined();
    expect(stub.calls[0]!.tools![0]!.name).toBe('customer_read_profile');
  });

  // -------------------------------------------------------------------------
  // 7. Usage tokens aggregated across iterations
  // -------------------------------------------------------------------------
  it('aggregates input/output/cache tokens across every iteration', async () => {
    registerTool({
      name: 'knowledge.search',
      description: 's',
      inputSchema: z.object({ query: z.string() }),
      handler: async () => [],
    });

    stub
      .push({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_x',
            name: 'knowledge_search',
            input: { query: 'q' },
          },
        ],
        stop_reason: 'tool_use',
        usage: usage(100, 20, 30, 5),
      })
      .push({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: usage(150, 25, 40, 0),
      });

    const result = await callClaudeWithTools({
      tier: 'sonnet',
      userPrompt: 'hi',
      tools: [
        {
          name: 'knowledge.search',
          description: 's',
          inputSchema: z.object({ query: z.string() }),
          handler: async () => null,
        },
      ],
      toolContext: fakeToolContext,
    });

    expect(result.usage.inputTokens).toBe(250);
    expect(result.usage.outputTokens).toBe(45);
    expect(result.usage.cacheReadInputTokens).toBe(70);
    expect(result.usage.cacheCreationInputTokens).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 8. systemFragments + systemPrompt composed into request.system blocks
  // -------------------------------------------------------------------------
  it('composes systemPrompt + systemFragments into the system field', async () => {
    stub.push({
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: usage(5, 1),
    });

    await callClaudeWithTools({
      tier: 'sonnet',
      systemPrompt: 'You are F16',
      systemFragments: [{ text: 'Cached rubric', cache: true }, { text: 'Per-turn note' }],
      userPrompt: 'hi',
      tools: [],
      toolContext: fakeToolContext,
    });

    const sys = stub.lastCall.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: 'ephemeral' };
    }>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys.length).toBe(3);
    expect(sys[0]!.text).toBe('You are F16');
    expect(sys[1]!.text).toBe('Cached rubric');
    expect(sys[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[2]!.text).toBe('Per-turn note');
  });

  // The model must receive a REAL argument schema (so it fills formData etc.
  // correctly instead of guessing from prose) — and the internal identity
  // fields customerId/leadId must be STRIPPED (they're injected server-side).
  it('sends a real json schema and strips internal customerId/leadId from the model view', async () => {
    stub.push({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: usage(5, 2),
    });

    await callClaudeWithTools({
      tier: 'sonnet',
      userPrompt: 'go',
      tools: [
        {
          name: 'quote.request',
          description: 'launch a quote',
          inputSchema: z.object({
            customerId: z.string().uuid(),
            leadId: z.string().uuid(),
            formData: z.object({
              vehicleKind: z.literal('trottinette'),
              postalCode: z.string(),
            }),
          }),
          handler: async () => null,
        },
      ],
      toolContext: fakeToolContext,
    });

    const sentTool = stub.lastCall.tools?.[0];
    expect(sentTool?.name).toBe('quote_request');
    const schema = sentTool?.input_schema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    // Business field IS present, so the model knows to send it.
    expect(schema.properties).toHaveProperty('formData');
    // Internal ids are STRIPPED — the model never sees or supplies them.
    expect(schema.properties).not.toHaveProperty('customerId');
    expect(schema.properties).not.toHaveProperty('leadId');
    expect(schema.required ?? []).not.toContain('customerId');
    expect(schema.required ?? []).not.toContain('leadId');
  });
});
