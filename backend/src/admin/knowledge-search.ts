/**
 * Admin knowledge semantic search (M14.T8).
 *
 *   GET /v1/admin/knowledge/search?q=<query>&limit=<n>
 *     Embeds the query with the same model the corpus is indexed with
 *     (OpenRouter `text-embedding-3-small`, 1536d) and runs a kNN cosine
 *     search over `knowledge_chunks`. Lets Ridaa/Achraf verify what the agents
 *     actually "know" (Maxance product catalog, Assuryal KB, FAQ, pricing).
 *
 * Read-only. Reuses the exact retrieval path the Sales Agent's `knowledge.search`
 * tool uses (embed → searchSimilar), so the admin sees the same ranking the
 * agents do. Cosine distance is surfaced as a 0-1 `similarity` (1 = identical)
 * for the UI plus the raw `distance`.
 *
 * The embedding client is injectable so the endpoint test runs without a network
 * call (see `__setEmbeddingClientForTests` in src/llm/embeddings.ts).
 */
import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { searchSimilar } from '../db/repositories/knowledge.js';
import { getDefaultEmbeddingClient } from '../llm/embeddings.js';
import { logger } from '../logger.js';

/** Minimal structural embedder — the real EmbeddingClient satisfies it; tests pass a stub. */
export interface QueryEmbedder {
  embed(text: string): Promise<number[]>;
}

export interface AdminKnowledgeRouterOptions {
  db: Database;
  /** Injectable embedder — defaults to the shared OpenRouter client. Tests pass a stub. */
  embeddingClient?: QueryEmbedder;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface KnowledgeSearchHit {
  id: string;
  source: string;
  sourcePath: string | null;
  sourceUrl: string | null;
  chunkText: string;
  /** Cosine distance (0 = identical, 2 = opposite). */
  distance: number;
  /** 0-1 convenience score (1 = identical) derived from distance. */
  similarity: number;
  ingestedAt: string | null;
}

export interface KnowledgeSearchResponse {
  query: string;
  generatedAt: string;
  results: KnowledgeSearchHit[];
}

/** Cosine distance (0..2) → similarity (1..0), clamped. */
function toSimilarity(distance: number): number {
  const s = 1 - distance / 2;
  return Math.max(0, Math.min(1, Math.round(s * 1000) / 1000));
}

export function buildAdminKnowledgeRouter(opts: AdminKnowledgeRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/knowledge/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) {
      return c.json({ error: 'query too short (min 2 chars)' }, 400);
    }
    const rawLimit = Number(c.req.query('limit'));
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    let queryEmbedding: number[];
    try {
      const ec = opts.embeddingClient ?? getDefaultEmbeddingClient();
      queryEmbedding = await ec.embed(q);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin knowledge-search: embedding failed',
      );
      return c.json({ error: 'embedding_failed' }, 502);
    }

    const hits = await searchSimilar(opts.db, queryEmbedding, { limit });
    const body: KnowledgeSearchResponse = {
      query: q,
      generatedAt: new Date().toISOString(),
      results: hits.map((h) => ({
        id: h.chunk.id,
        source: h.chunk.source,
        sourcePath: h.chunk.sourcePath,
        sourceUrl: h.chunk.sourceUrl,
        chunkText: h.chunk.chunkText,
        distance: h.distance,
        similarity: toSimilarity(h.distance),
        ingestedAt: h.chunk.ingestedAt ? new Date(h.chunk.ingestedAt).toISOString() : null,
      })),
    };
    return c.json(body, 200);
  });

  return app;
}
