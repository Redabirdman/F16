/**
 * EmbeddingClient — unit tests against a stub fetch. No network.
 *
 * Pairs with `tests/memory/recall.test.ts` (integration) which exercises the
 * memory facade end-to-end against a real pg using a stubbed embedding client.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingClient } from '../../src/llm/embeddings.js';

interface StubCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

interface StubFetchOptions {
  /** Either a static response, or a function called per request. */
  response?: Partial<Response> & { ok?: boolean; status?: number; bodyJson?: unknown };
  /** Override per call. */
  handler?: (call: StubCall) => Response | Promise<Response>;
}

function makeStubFetch(opts: StubFetchOptions = {}): {
  fetch: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const body =
      init?.body !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: StubCall = { url, init: init ?? {}, body };
    calls.push(call);
    if (opts.handler) return opts.handler(call);
    const ok = opts.response?.ok ?? true;
    const status = opts.response?.status ?? 200;
    const bodyJson = opts.response?.bodyJson ?? {
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: 'openai/text-embedding-3-small',
    };
    return {
      ok,
      status,
      text: async (): Promise<string> => (ok ? JSON.stringify(bodyJson) : 'oops'),
      json: async (): Promise<unknown> => bodyJson,
    } as unknown as Response;
  };
  return { fetch: fn, calls };
}

describe('EmbeddingClient', () => {
  beforeEach(() => {
    // Ensure each test has the env var present unless it explicitly removes it.
    process.env['OPENROUTER_API_KEY'] ??= 'test-key';
  });

  it('embed(text) posts to /embeddings with model + input, returns the vector', async () => {
    const { fetch: stubFetch, calls } = makeStubFetch({
      response: {
        bodyJson: {
          data: [{ index: 0, embedding: [0.5, 0.25, 0.125] }],
          model: 'openai/text-embedding-3-small',
        },
      },
    });
    const ec = new EmbeddingClient({ apiKey: 'sk-test', fetchImpl: stubFetch });
    const v = await ec.embed('hello');
    expect(v).toEqual([0.5, 0.25, 0.125]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(calls[0]!.body).toEqual({
      model: 'openai/text-embedding-3-small',
      input: ['hello'],
    });
  });

  it('embedBatch returns vectors ordered by index', async () => {
    // Deliberately scramble the response order — client must sort by index.
    const { fetch: stubFetch } = makeStubFetch({
      response: {
        bodyJson: {
          data: [
            { index: 1, embedding: [9, 9, 9] },
            { index: 0, embedding: [1, 1, 1] },
          ],
        },
      },
    });
    const ec = new EmbeddingClient({ apiKey: 'sk-test', fetchImpl: stubFetch });
    const vs = await ec.embedBatch(['a', 'b']);
    expect(vs).toEqual([
      [1, 1, 1],
      [9, 9, 9],
    ]);
  });

  it('embedBatch([]) short-circuits — no HTTP call', async () => {
    const { fetch: stubFetch, calls } = makeStubFetch();
    const ec = new EmbeddingClient({ apiKey: 'sk-test', fetchImpl: stubFetch });
    const out = await ec.embedBatch([]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws on HTTP 500 with status + truncated body', async () => {
    const longBody = 'X'.repeat(500);
    const stubFetch: typeof fetch = async () =>
      ({
        ok: false,
        status: 500,
        text: async (): Promise<string> => longBody,
        json: async (): Promise<unknown> => ({}),
      }) as unknown as Response;
    const ec = new EmbeddingClient({ apiKey: 'sk-test', fetchImpl: stubFetch });
    await expect(ec.embed('hi')).rejects.toThrow(/embeddings: HTTP 500/);
    // Body in the error message must be truncated to <=200 chars.
    let captured = '';
    try {
      await ec.embed('hi');
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err);
    }
    // The message is "embeddings: HTTP 500 — <body slice>"; the body slice <=200.
    const dashIdx = captured.indexOf('—');
    const bodyPart = dashIdx >= 0 ? captured.slice(dashIdx + 1).trim() : '';
    expect(bodyPart.length).toBeLessThanOrEqual(200);
  });

  it('throws on construction when OPENROUTER_API_KEY is unset and no apiKey passed', () => {
    const saved = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      expect(() => new EmbeddingClient()).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (saved !== undefined) process.env['OPENROUTER_API_KEY'] = saved;
    }
  });

  it('honors a custom baseUrl', async () => {
    const { fetch: stubFetch, calls } = makeStubFetch();
    const ec = new EmbeddingClient({
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v9/',
      fetchImpl: stubFetch,
    });
    await ec.embed('x');
    // Trailing slash stripped, /embeddings appended.
    expect(calls[0]!.url).toBe('https://example.test/v9/embeddings');
  });

  it('honors a custom model name', async () => {
    const { fetch: stubFetch, calls } = makeStubFetch();
    const ec = new EmbeddingClient({
      apiKey: 'sk-test',
      model: 'openai/text-embedding-3-large',
      fetchImpl: stubFetch,
    });
    await ec.embed('x');
    expect(calls[0]!.body).toMatchObject({
      model: 'openai/text-embedding-3-large',
    });
  });
});
