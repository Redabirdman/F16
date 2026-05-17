/**
 * Knowledge ingestion orchestrator (F16 M7.T1).
 *
 * Wires together: adapter → batch buffer → embedder → sha256 → upsert.
 *
 * Why this exists separate from the adapter:
 *
 *   - The adapter is the format-aware part (Markdown, React JSX, HTML, ...).
 *     There will be many. We don't want each one re-implementing batching,
 *     sha computation, or error accounting.
 *
 *   - This file is the single seam where we choose the embedding model, the
 *     batch size, and the failure policy. Tuning is one-file-wide.
 *
 * Idempotency: chunk_sha256 is `sha256(chunkText)`. The `upsertChunk` repo
 * uses ON CONFLICT(chunk_sha256) to refresh embedding + meta + ingestedAt
 * without bloating, so re-running the same source is cheap (re-embedding
 * costs, but no DB churn).
 *
 * Insert vs update accounting: we read xmax/rowmark only via a follow-up
 * SELECT is overkill — instead we peek at `ingestedAt` returned by the upsert
 * before running it (= NOT EXISTS check). That's one round-trip + one upsert
 * per chunk, which is fine at the corpus sizes M7 targets (≤ 10k chunks).
 *
 * Token accounting: we DO NOT round-trip with the provider for token counts —
 * embeddings providers don't return per-input token breakdowns reliably (the
 * OpenAI shape returns `usage.total_tokens` for the whole batch). We instead
 * report the raw character count as a proxy and store it in
 * `IngestionResult.embedTokensUsed`. Callers who need wire-true counts can
 * divide by ~4 for French. This is documented in the field's tsdoc.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { upsertChunk } from '../db/repositories/knowledge.js';
import { knowledgeChunks } from '../db/schema/index.js';
import { EmbeddingClient, getDefaultEmbeddingClient } from '../llm/embeddings.js';
import { logger } from '../logger.js';
import type { IngestionAdapter } from './adapters/types.js';
import type { IngestionSource, IngestionResult, IngestableChunk } from './types.js';

export interface IngestSourceOptions {
  /** Embedding client. Defaults to the lazily-constructed singleton. */
  embedder?: EmbeddingClient;
  /** How many chunks to embed per provider call. Default 32. */
  batchSize?: number;
  /**
   * Dry-run mode: read chunks from the adapter but do NOT embed or write.
   * Counters reflect what WOULD have happened. Useful for previewing chunk
   * boundaries before paying for embeddings.
   */
  dryRun?: boolean;
}

/**
 * Run a full ingestion pass for a source.
 *
 * The caller picks the adapter; the framework handles the rest.
 */
export async function ingestSource(
  db: Database,
  adapter: IngestionAdapter,
  source: IngestionSource,
  opts: IngestSourceOptions = {},
): Promise<IngestionResult> {
  const start = Date.now();
  const batchSize = opts.batchSize ?? 32;
  const dryRun = opts.dryRun ?? false;
  const embedder = opts.embedder ?? (dryRun ? null : getDefaultEmbeddingClient());

  const result: IngestionResult = {
    sourceName: source.name,
    chunksProcessed: 0,
    chunksInserted: 0,
    chunksUpdated: 0,
    chunksFailed: 0,
    embedTokensUsed: 0,
    durationMs: 0,
  };

  const buffer: IngestableChunk[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    try {
      await processBatch(db, source, embedder, batch, dryRun, result);
    } catch (err) {
      // A batch-wide failure (e.g. embeddings provider down) gets counted
      // against every chunk in the batch. We do NOT abort the whole ingest
      // — a transient provider blip shouldn't lose work already buffered.
      result.chunksFailed += batch.length;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          batchSize: batch.length,
          source: source.name,
        },
        'knowledge.ingest.batch_failed',
      );
    }
  };

  for await (const chunk of adapter.ingest(source)) {
    result.chunksProcessed += 1;
    buffer.push(chunk);
    if (buffer.length >= batchSize) {
      await flush();
    }
  }
  await flush();

  result.durationMs = Date.now() - start;

  logger.info(
    {
      source: source.name,
      adapter: adapter.id,
      processed: result.chunksProcessed,
      inserted: result.chunksInserted,
      updated: result.chunksUpdated,
      failed: result.chunksFailed,
      tokens: result.embedTokensUsed,
      durationMs: result.durationMs,
      dryRun,
    },
    'knowledge.ingest.done',
  );

  return result;
}

/**
 * Embed + upsert one buffered batch.
 *
 * We pre-check existence per sha so the insert/update counters are accurate.
 * This is one SELECT per chunk on top of the upsert — acceptable for M7's
 * scale (corpora measured in hundreds, not millions, of chunks).
 */
async function processBatch(
  db: Database,
  source: IngestionSource,
  embedder: EmbeddingClient | null,
  batch: IngestableChunk[],
  dryRun: boolean,
  result: IngestionResult,
): Promise<void> {
  const texts = batch.map((c) => c.text);
  const shas = texts.map((t) => sha256(t));

  // Tally proxy-tokens regardless of dry-run.
  for (const t of texts) result.embedTokensUsed += t.length;

  if (dryRun) {
    // Dry-run still counts as "would insert" — we don't peek the DB.
    result.chunksInserted += batch.length;
    return;
  }
  if (!embedder) throw new Error('ingestSource: embedder missing in non-dry-run path');

  // Existence peek — one query for the whole batch.
  const existing = await db
    .select({ chunkSha256: knowledgeChunks.chunkSha256 })
    .from(knowledgeChunks)
    .where(
      sql`${knowledgeChunks.chunkSha256} IN (${sql.join(
        shas.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  const existingSet = new Set(existing.map((r) => r.chunkSha256));

  const embeddings = await embedder.embedBatch(texts);

  for (let i = 0; i < batch.length; i++) {
    const chunk = batch[i];
    const sha = shas[i];
    const embedding = embeddings[i];
    if (!chunk || !sha || !embedding) {
      result.chunksFailed += 1;
      continue;
    }
    try {
      await upsertChunk(db, {
        source: source.name,
        sourceUrl: source.url ?? null,
        sourcePath: chunk.sourcePath ?? source.path ?? null,
        chunkText: chunk.text,
        chunkSha256: sha,
        // Char-count proxy. See file header.
        tokenCount: Math.ceil(chunk.text.length / 4),
        embedding,
        meta: chunk.meta ?? null,
      });
      if (existingSet.has(sha)) result.chunksUpdated += 1;
      else result.chunksInserted += 1;
    } catch (err) {
      result.chunksFailed += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sha },
        'knowledge.ingest.upsert_failed',
      );
    }
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
