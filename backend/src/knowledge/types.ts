/**
 * Knowledge ingestion — shared types (F16 M7.T1).
 *
 * The ingestion framework is a thin pipeline:
 *
 *   adapter.ingest(source) → AsyncIterable<IngestableChunk>
 *                          → embed batch
 *                          → upsertChunk (sha256-keyed, idempotent)
 *
 * `IngestionSource` describes WHERE chunks come from. `IngestableChunk`
 * describes ONE pre-embedded chunk produced by an adapter. The framework
 * (`ingest.ts`) takes care of embedding, sha256, dedup, and upsert — adapters
 * stay dumb and just emit text + meta.
 *
 * `IngestionResult` is the structured summary returned by `ingestSource(...)`.
 * It's what the CLI prints to stdout and what we ship in the commit body for
 * auditing the live bootstrap.
 */

/** A logical source of knowledge — file, URL, repo path, etc. */
export interface IngestionSource {
  /** Stable identifier used as `knowledge_chunks.source`. */
  name: string;
  /** Optional canonical URL (used as `knowledge_chunks.source_url`). */
  url?: string;
  /** Filesystem or repo-relative path (used as `knowledge_chunks.source_path`). */
  path?: string;
}

/** One pre-embedded chunk yielded by an adapter. */
export interface IngestableChunk {
  /** The chunk text. Will be embedded and stored verbatim. */
  text: string;
  /** Optional per-chunk metadata, persisted as `knowledge_chunks.meta`. */
  meta?: Record<string, unknown>;
  /**
   * Per-chunk source path override. Adapters use this to give each chunk a
   * stable anchor (e.g. `7-trottinette-electrique-edpm`) so the row is
   * citeable independent of where the parent file lives.
   */
  sourcePath?: string;
}

/** Aggregate outcome of a full ingestion pass. */
export interface IngestionResult {
  sourceName: string;
  /** Chunks produced by the adapter. */
  chunksProcessed: number;
  /** Truly new rows (no existing sha256 match). */
  chunksInserted: number;
  /** Existing rows whose embedding/meta was refreshed. */
  chunksUpdated: number;
  /** Chunks that errored during embed or upsert. */
  chunksFailed: number;
  /** Sum of input characters embedded (proxy for tokens billed). */
  embedTokensUsed: number;
  /** Wall-clock duration of the ingest call. */
  durationMs: number;
}
