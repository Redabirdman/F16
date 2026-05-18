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
export { reactSourceAdapter, extractStrings } from './adapters/react-source.js';
export {
  registerKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeSources,
  adapterFor,
  __resetKnowledgeSourcesForTests,
} from './source-registry.js';
export type { KnowledgeSourceConfig, AdapterKind } from './source-registry.js';
export { startKnowledgeCurator, handleReindex } from './curator.js';
export type { KnowledgeCuratorOptions, KnowledgeCuratorHandle } from './curator.js';
export { bootstrapKnowledgeSources, __resetBootstrapForTests } from './bootstrap.js';
export { ingestSourceWithDrift, snapshotSource } from './drift.js';
export type { DriftKind, DriftSummary, IngestWithDriftResult } from './drift.js';
