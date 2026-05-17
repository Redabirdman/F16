/**
 * Embeddings client — F16 M6.T6.
 *
 * Thin OpenAI-compatible `/v1/embeddings` client that we point at OpenRouter
 * by default. Used by the Mem0-shape memory facade (`src/memory/index.ts`)
 * to embed customer facts on record and queries on recall.
 *
 * Why OpenRouter and not Anthropic-direct: Anthropic has no first-party
 * embeddings API. OpenRouter exposes OpenAI's `text-embedding-3-small`
 * (1536 dims — exactly the `customer_facts.embedding vector(1536)` column
 * width set in M2.T3) behind the same `Bearer` auth we already use for
 * non-Claude calls (M12 image gen). OpenAI direct would also work but
 * doubles the secret-management surface for no benefit.
 *
 * Public surface mirrors `claude.ts`:
 *   - `embed(text)` / `embedBatch(texts)` instance methods,
 *   - `getDefaultEmbeddingClient()` lazy singleton,
 *   - `__setEmbeddingClientForTests(...)` test seam so unit tests inject a
 *     stub and never call the real API.
 *
 * Failure semantics: any non-2xx response throws with `HTTP <status> — <body
 * snippet>` (body truncated to 200 chars to keep logs PII-free). Callers
 * decide whether the failure is fatal — the Sales Agent's recall path wraps
 * recall in try/catch so a transient embeddings outage degrades to "no
 * recalled facts" rather than blocking the customer reply.
 */
import { z } from 'zod';

const EmbeddingsResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int(),
      embedding: z.array(z.number()),
    }),
  ),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export interface EmbeddingClientOptions {
  /** Override the env-derived API key (tests). */
  apiKey?: string;
  /** Model id. Default `openai/text-embedding-3-small` (1536 dims). */
  model?: string;
  /** Base URL (no trailing slash). Default OpenRouter. */
  baseUrl?: string;
  /** Custom fetch impl for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class EmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: EmbeddingClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not set — required for the embeddings client. Set it in the environment.',
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? 'openai/text-embedding-3-small';
    this.baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Embed a single string. Returns the embedding vector. */
  async embed(text: string): Promise<number[]> {
    const out = await this.embedBatch([text]);
    return out[0] ?? [];
  }

  /**
   * Embed an array of strings in a single API call. The OpenAI embeddings
   * endpoint accepts arrays natively; OpenRouter passes them through. The
   * response is sorted by `index` so the output order always matches the
   * input order — callers don't need to defensive-sort.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      // Truncate the body to 200 chars — provider error pages can be huge
      // HTML pages and we never want them in the log line verbatim.
      const txt = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`embeddings: HTTP ${res.status} — ${txt}`);
    }
    const parsed = EmbeddingsResponseSchema.parse(await res.json());
    // Defensive sort — OpenAI today returns sorted, but the spec only
    // promises `index` is the input position.
    parsed.data.sort((a, b) => a.index - b.index);
    return parsed.data.map((d) => d.embedding);
  }
}

/** Lazily-constructed process-wide singleton. */
let _default: EmbeddingClient | null = null;

export function getDefaultEmbeddingClient(): EmbeddingClient {
  if (!_default) _default = new EmbeddingClient();
  return _default;
}

/**
 * Test-only seam. Lets unit tests inject a stub embedding client so the code
 * path can be exercised without an API key or network call. Pass `null` to
 * reset back to the lazily-constructed real client.
 */
export function __setEmbeddingClientForTests(client: EmbeddingClient | null): void {
  _default = client;
}
