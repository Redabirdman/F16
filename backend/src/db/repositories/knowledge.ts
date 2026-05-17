/**
 * knowledge_chunks repository — RAG corpus over org knowledge.
 *
 * Ingest model:
 *   upsertChunk(sha256) is content-addressed. Re-ingestion of an unchanged
 *   chunk is a no-op data-wise but refreshes embedding + meta + ingestedAt,
 *   so the corpus tracks the latest crawl timestamp without bloating.
 *
 * Search:
 *   searchSimilar() runs a kNN query (`embedding <=> $1`) and returns the
 *   raw cosine distance alongside the row so callers can apply their own
 *   thresholds (e.g. skip distance > 0.4).
 *
 * Re-ingest:
 *   deleteBySource(source) is the "wipe and re-crawl" lever. Callers
 *   bracket a fresh ingest with delete → re-upsert to clear stale chunks
 *   that the source no longer publishes.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { knowledgeChunks } from '../schema/index.js';
import type { KnowledgeChunk } from '../schema/agent-runtime.js';

export interface UpsertChunkInput {
  source: string;
  sourceUrl?: string | null;
  sourcePath?: string | null;
  chunkText: string;
  chunkSha256: string;
  tokenCount?: number | null;
  embedding: number[];
  meta?: Record<string, unknown> | null;
}

/**
 * Upsert keyed on chunk_sha256. On conflict, refreshes embedding + meta +
 * ingestedAt only — the immutable fields (text, sha) are unchanged by
 * construction.
 */
export async function upsertChunk(db: Database, input: UpsertChunkInput): Promise<KnowledgeChunk> {
  const [row] = await db
    .insert(knowledgeChunks)
    .values({
      source: input.source,
      sourceUrl: input.sourceUrl ?? null,
      sourcePath: input.sourcePath ?? null,
      chunkText: input.chunkText,
      chunkSha256: input.chunkSha256,
      tokenCount: input.tokenCount ?? null,
      embedding: input.embedding,
      meta: input.meta ?? null,
    })
    .onConflictDoUpdate({
      target: knowledgeChunks.chunkSha256,
      set: {
        embedding: input.embedding,
        meta: input.meta ?? null,
        ingestedAt: sql`now()`,
      },
    })
    .returning();

  if (!row) throw new Error('upsertChunk: insert returned no row');
  return row;
}

export interface SearchSimilarOptions {
  /** Max results. */
  limit?: number;
}

export interface SimilarChunkHit {
  chunk: KnowledgeChunk;
  /** Cosine distance (0 = identical, 2 = opposite). */
  distance: number;
}

/**
 * kNN over the embedding column using cosine distance (`<=>`). Returns
 * `(chunk, distance)` tuples ordered nearest-first.
 *
 * The embedding array is serialized to pgvector's `[a,b,c]` literal — we
 * build it string-side rather than relying on drizzle's array binding so
 * the operator parser sees a vector, not an int4[].
 */
export async function searchSimilar(
  db: Database,
  embedding: number[],
  opts: SearchSimilarOptions = {},
): Promise<SimilarChunkHit[]> {
  const limit = opts.limit ?? 10;
  const literal = `[${embedding.join(',')}]`;

  const rows = (await db.execute(sql`
    SELECT
      id,
      source,
      source_url    AS "sourceUrl",
      source_path   AS "sourcePath",
      chunk_text    AS "chunkText",
      chunk_sha256  AS "chunkSha256",
      token_count   AS "tokenCount",
      embedding,
      meta,
      ingested_at   AS "ingestedAt",
      embedding <=> ${literal}::vector AS distance
    FROM knowledge_chunks
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `)) as unknown as Array<KnowledgeChunk & { distance: number | string }>;

  return rows.map((r) => {
    const { distance, ...chunk } = r;
    return {
      chunk: chunk as KnowledgeChunk,
      distance: typeof distance === 'string' ? parseFloat(distance) : distance,
    };
  });
}

/** Wipe all chunks belonging to a source. Returns the row count deleted. */
export async function deleteBySource(db: Database, source: string): Promise<number> {
  const result = await db
    .delete(knowledgeChunks)
    .where(eq(knowledgeChunks.source, source))
    .returning({ id: knowledgeChunks.id });
  return result.length;
}
