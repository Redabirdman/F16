/**
 * Knowledge source registry (F16 M7.T3).
 *
 * Holds the in-memory catalog of "knowledge sources" the Knowledge Curator
 * agent re-ingests on a schedule (or on demand via the
 * KNOWLEDGE.REINDEX_REQUESTED intent).
 *
 * Why a process-local registry instead of a DB table:
 *   - V1 has a known, hand-curated set of sources (the Assuryal MD knowledge
 *     base and the conversion-machine React source). The set evolves on code
 *     change, not on user action — so the source of truth IS the codebase.
 *   - Keeping it in-memory means there's nothing extra to migrate, no
 *     consistency story between DB rows and adapter availability, and tests
 *     can register fixtures via `registerKnowledgeSource(...)` without
 *     touching pg.
 *   - The admin panel (M14) will read this registry over HTTP — the on-disk
 *     reality stays the singleton, the UI is a thin view.
 *
 * Adapters are imported eagerly at module load. The `react-source` adapter
 * does pull in the TypeScript compiler, but the project's barrel
 * (`src/knowledge/index.ts`) already exports both, so there's no extra cost.
 * If a deployment ever needs to avoid the TS dep, switch this back to a
 * dynamic-import branch keyed on AdapterKind.
 */
import type { IngestionAdapter } from './adapters/types.js';
import { markdownFileAdapter } from './adapters/markdown-file.js';
import { reactSourceAdapter } from './adapters/react-source.js';

export type AdapterKind = 'markdown-file' | 'react-source';

export interface KnowledgeSourceConfig {
  /** Unique name (matches knowledge_chunks.source). */
  name: string;
  /** Which adapter to use. */
  adapter: AdapterKind;
  /** Path / URL handed to the adapter. */
  path: string;
  /** Optional source-level metadata (e.g. canonical URL). */
  url?: string;
  /** Periodic re-ingest interval in hours. Default 6. */
  intervalHours?: number;
  /** Whether to auto-schedule periodic re-ingests. Default true. */
  scheduled?: boolean;
}

const _sources = new Map<string, KnowledgeSourceConfig>();

export function registerKnowledgeSource(cfg: KnowledgeSourceConfig): void {
  if (_sources.has(cfg.name)) {
    throw new Error(`Knowledge source ${cfg.name} already registered`);
  }
  _sources.set(cfg.name, cfg);
}

export function getKnowledgeSource(name: string): KnowledgeSourceConfig | undefined {
  return _sources.get(name);
}

export function listKnowledgeSources(): KnowledgeSourceConfig[] {
  return [..._sources.values()];
}

/**
 * Test-only escape hatch — clears all registrations so tests get a clean slate
 * between cases. Not part of the public API; do NOT call from app code.
 */
export function __resetKnowledgeSourcesForTests(): void {
  _sources.clear();
}

/**
 * Resolve an AdapterKind to a concrete adapter instance.
 *
 * Both shipped adapters export plain singletons (`markdownFileAdapter`,
 * `reactSourceAdapter`) — they're stateless, so a single instance is enough.
 * The exhaustive switch makes TS catch unhandled future AdapterKinds at
 * compile time.
 */
export function adapterFor(kind: AdapterKind): IngestionAdapter {
  switch (kind) {
    case 'markdown-file':
      return markdownFileAdapter;
    case 'react-source':
      return reactSourceAdapter;
  }
}
