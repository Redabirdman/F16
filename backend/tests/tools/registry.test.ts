/**
 * Unit tests for the tool registry (M3.T6). No DB required.
 *
 * These tests import the registry module DIRECTLY (not through the
 * `src/tools/index.ts` barrel) so the built-in registrations aren't pulled in
 * — each test starts from a clean registry via `__resetToolsForTests()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  registerTool,
  getTool,
  listTools,
  invokeTool,
  describeForLLM,
  __resetToolsForTests,
  type ToolContext,
} from '../../src/tools/registry.js';

// A throwaway ctx — the dummy tools don't touch any of these fields.
const ctx: ToolContext = {
  db: null as never,
  agentRole: 'test-agent',
  agentInstance: 'test#1',
};

beforeEach(() => {
  __resetToolsForTests();
});

describe('tool registry', () => {
  it('test 1 (register + get): registerTool stores the tool; getTool returns it', () => {
    registerTool({
      name: 'fixture.echo',
      description: 'echoes its input back',
      inputSchema: z.object({ msg: z.string() }),
      handler: async (_c, input) => input,
    });

    const t = getTool('fixture.echo');
    expect(t).toBeDefined();
    expect(t!.name).toBe('fixture.echo');
    expect(t!.description).toMatch(/echoes/);
  });

  it('test 2 (duplicate): registerTool throws when the name is already taken', () => {
    registerTool({
      name: 'fixture.dup',
      description: 'first',
      inputSchema: z.object({}),
      handler: async () => null,
    });

    expect(() =>
      registerTool({
        name: 'fixture.dup',
        description: 'second',
        inputSchema: z.object({}),
        handler: async () => null,
      }),
    ).toThrow(/already registered/);
  });

  it('test 3 (list all + filter): listTools returns everything, filtered list respects allowed', () => {
    registerTool({
      name: 'fixture.a',
      description: 'a',
      inputSchema: z.object({}),
      handler: async () => null,
    });
    registerTool({
      name: 'fixture.b',
      description: 'b',
      inputSchema: z.object({}),
      handler: async () => null,
    });
    registerTool({
      name: 'fixture.c',
      description: 'c',
      inputSchema: z.object({}),
      handler: async () => null,
    });

    expect(listTools()).toHaveLength(3);

    const allowed = listTools({ allowed: ['fixture.a', 'fixture.c'] });
    expect(allowed.map((t) => t.name).sort()).toEqual(['fixture.a', 'fixture.c']);

    // Empty allow-list returns nothing.
    expect(listTools({ allowed: [] })).toHaveLength(0);

    // Names that don't exist are silently dropped — they don't error.
    expect(listTools({ allowed: ['nope'] })).toHaveLength(0);
  });

  it('test 4 (invoke unknown): invokeTool throws on unknown name', async () => {
    await expect(invokeTool(ctx, 'nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('test 5 (input validation): invokeTool throws on bad input shape', async () => {
    registerTool({
      name: 'fixture.add',
      description: 'adds two numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      handler: async (_c, input) => input.a + input.b,
    });

    await expect(invokeTool(ctx, 'fixture.add', { a: 'one', b: 2 })).rejects.toThrow(
      /Invalid input for tool fixture\.add/,
    );

    // Happy path still works.
    await expect(invokeTool(ctx, 'fixture.add', { a: 1, b: 2 })).resolves.toBe(3);
  });

  it('test 6 (output validation): invokeTool throws when output violates outputSchema', async () => {
    registerTool({
      name: 'fixture.bad-output',
      description: 'returns the wrong shape',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.literal(true) }),
      // Cast through unknown — we deliberately violate the contract.
      handler: async () => ({ ok: false }) as unknown as { ok: true },
    });

    await expect(invokeTool(ctx, 'fixture.bad-output', {})).rejects.toThrow(
      /doesn't match its outputSchema/,
    );
  });

  it('test 7 (output validation: pass): invokeTool returns validated output when schema matches', async () => {
    registerTool({
      name: 'fixture.good-output',
      description: 'returns the right shape',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.literal(true) }),
      handler: async () => ({ ok: true as const }),
    });

    await expect(invokeTool(ctx, 'fixture.good-output', {})).resolves.toEqual({ ok: true });
  });

  it('test 8 (no output schema): invokeTool returns handler value verbatim', async () => {
    registerTool({
      name: 'fixture.no-out-schema',
      description: 'no output schema; trust the handler',
      inputSchema: z.object({}),
      handler: async () => ({ anyShape: 42, weCanReturn: ['anything'] }),
    });

    const out = (await invokeTool(ctx, 'fixture.no-out-schema', {})) as {
      anyShape: number;
      weCanReturn: string[];
    };
    expect(out.anyShape).toBe(42);
    expect(out.weCanReturn).toEqual(['anything']);
  });

  it('test 9 (describeForLLM): returns name/description/input_schema entries', () => {
    registerTool({
      name: 'fixture.described',
      description: 'doc-only tool',
      inputSchema: z.object({ q: z.string() }),
      handler: async () => null,
    });

    const described = describeForLLM();
    expect(described).toHaveLength(1);
    expect(described[0]).toEqual({
      name: 'fixture.described',
      description: 'doc-only tool',
      input_schema: { type: 'object' },
    });
  });

  it('test 10 (describeForLLM filter): respects the allowed whitelist', () => {
    registerTool({
      name: 'fixture.x',
      description: 'x',
      inputSchema: z.object({}),
      handler: async () => null,
    });
    registerTool({
      name: 'fixture.y',
      description: 'y',
      inputSchema: z.object({}),
      handler: async () => null,
    });

    const described = describeForLLM({ allowed: ['fixture.y'] });
    expect(described.map((t) => t.name)).toEqual(['fixture.y']);
  });
});
