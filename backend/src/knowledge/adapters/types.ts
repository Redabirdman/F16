/**
 * Knowledge ingestion adapter interface (F16 M7.T1).
 *
 * An adapter knows how to turn a single `IngestionSource` into a stream of
 * `IngestableChunk`. Everything else (embedding, sha256, dedup, upsert) is the
 * framework's job — see `src/knowledge/ingest.ts`.
 *
 * Adapters yield via `AsyncIterable` rather than returning a full array so
 * large sources (a 1000-page PDF, an entire React tree) stream through embed +
 * upsert without piling up in memory.
 *
 * First concrete adapter: `markdown-file` (M7.T1).
 * Planned: `react-source` (M7.T2), `http-html` (M7.T3).
 */
import type { IngestionSource, IngestableChunk } from '../types.js';

export interface IngestionAdapter {
  /** Adapter id — e.g. `markdown-file`, `react-source`, `http-html`. */
  readonly id: string;
  /** Produce chunks for `source`. The framework handles the rest. */
  ingest(source: IngestionSource): AsyncIterable<IngestableChunk>;
}
