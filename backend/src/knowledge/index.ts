/**
 * Knowledge ingestion — barrel exports (F16 M7.T1).
 *
 * Consumers (CLI script, future admin UI, future periodic re-index worker)
 * import from `@f16/backend/knowledge` and get the framework + adapter set.
 */
export type { IngestionSource, IngestableChunk, IngestionResult } from './types.js';
export type { IngestionAdapter } from './adapters/types.js';
export { ingestSource } from './ingest.js';
export type { IngestSourceOptions } from './ingest.js';
export { markdownFileAdapter, chunkMarkdown, slugify } from './adapters/markdown-file.js';
