/**
 * Knowledge drift detection (F16 M7.T4).
 *
 * Wraps `ingestSource` with pre/post snapshots of a source's per-source_path
 * sha256 map. After ingestion:
 *   - Compute `added` / `removed` / `changed` / `unchanged` paths.
 *   - DELETE orphan rows (source_paths no longer ingested) — the upsert step
 *     in `ingestSource` is sha-keyed and content-addressed, so it adds new
 *     rows but cannot reap stale ones; that responsibility lives here.
 *   - Classify the drift kind (`price_change` | `new_product` |
 *     `removed_product` | `other`) using a conservative text heuristic.
 *
 * The classifier is intentionally naive — V1 doesn't need surgical precision.
 * The downstream consumer (`KNOWLEDGE.DRIFT_DETECTED` intent) gets enough
 * structured detail (counts + path arrays) to render a human review surface.
 *
 * Rows with NULL `source_path` (anonymous chunks) are skipped — they can't be
 * keyed for diffing. This is graceful: if an adapter ever emits anonymous
 * chunks they pass through ingestion but stay invisible to drift detection.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { knowledgeChunks } from '../db/schema/index.js';
import type { IngestionAdapter } from './adapters/types.js';
import { ingestSource, type IngestSourceOptions } from './ingest.js';
import type { IngestionSource, IngestionResult } from './types.js';
import { logger } from '../logger.js';

export type DriftKind = 'price_change' | 'new_product' | 'removed_product' | 'other';

export interface DriftSummary {
  /** source_paths present in `after` but not `before`. */
  added: string[];
  /** source_paths present in `before` but not `after`. Orphans get deleted. */
  removed: string[];
  /** source_paths in both but with a different sha256. */
  changed: string[];
  /** Count of source_paths whose sha256 is unchanged. */
  unchanged: number;
  /** Classifier verdict. `null` when no drift at all. */
  kind: DriftKind | null;
}

export interface IngestWithDriftResult extends IngestionResult {
  drift: DriftSummary;
  /** Rows deleted as part of orphan cleanup. */
  orphansDeleted: number;
}

interface SnapshotEntry {
  sha256: string;
  text: string;
}

/**
 * Read the current per-source-path sha256 + text map for a knowledge source.
 *
 * Rows whose `source_path` is NULL are skipped — drift detection only operates
 * over paths that the adapter actually stamps.
 */
export async function snapshotSource(
  db: Database,
  sourceName: string,
): Promise<Map<string, SnapshotEntry>> {
  const rows = await db
    .select({
      sourcePath: knowledgeChunks.sourcePath,
      sha256: knowledgeChunks.chunkSha256,
      text: knowledgeChunks.chunkText,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.source, sourceName));

  const map = new Map<string, SnapshotEntry>();
  for (const r of rows) {
    if (!r.sourcePath) continue;
    map.set(r.sourcePath, { sha256: r.sha256, text: r.text });
  }
  return map;
}

/**
 * Run an ingestion and compute the drift summary against the prior snapshot.
 * Deletes orphan rows (removed source_paths) AFTER ingestion completes.
 *
 * Returns the regular `IngestionResult` extended with `drift` + `orphansDeleted`.
 */
export async function ingestSourceWithDrift(
  db: Database,
  adapter: IngestionAdapter,
  source: IngestionSource,
  opts: IngestSourceOptions = {},
): Promise<IngestWithDriftResult> {
  const before = await snapshotSource(db, source.name);

  // Use a server-side cutoff so we can later identify rows touched by THIS
  // ingest pass. now() is monotonic and survives clock skew between this
  // process and pg better than Date.now().
  const cutoffRows = (await db.execute(sql`SELECT now() AS now`)) as unknown as Array<{
    now: Date | string;
  }>;
  const cutoffRaw = cutoffRows[0]?.now;
  const cutoff = cutoffRaw instanceof Date ? cutoffRaw : new Date(String(cutoffRaw));

  const result = await ingestSource(db, adapter, source, opts);

  // Snapshot AFTER ingest, but distinguish two sets:
  //   - `freshMap` = paths whose ingested_at >= cutoff (= adapter just
  //     emitted them); maps sourcePath -> {sha256, text} for the fresh row.
  //   - any path in `before` not present in `freshMap` is treated as removed.
  //
  // NB: chunks are sha-keyed UNIQUE, so when a chunk's text changes a NEW row
  // is inserted under the new sha while the old row (same source_path)
  // persists. `freshMap` always reflects the new content because we filter on
  // ingested_at; the old row is what we'll reap as the orphan below.
  const freshRows = await db
    .select({
      sourcePath: knowledgeChunks.sourcePath,
      sha256: knowledgeChunks.chunkSha256,
      text: knowledgeChunks.chunkText,
    })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.source, source.name), gte(knowledgeChunks.ingestedAt, cutoff)));
  const freshMap = new Map<string, SnapshotEntry>();
  for (const r of freshRows) {
    if (r.sourcePath) freshMap.set(r.sourcePath, { sha256: r.sha256, text: r.text });
  }
  const freshSet = new Set<string>(freshMap.keys());

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  // Iterate over the union of (before, fresh). Stale paths (in `before` but
  // not freshly touched) are treated as removed.
  const allPaths = new Set<string>([...before.keys(), ...freshSet]);
  for (const path of allPaths) {
    const wasBefore = before.has(path);
    const freshEntry = freshMap.get(path);

    if (!wasBefore && freshEntry) {
      added.push(path);
    } else if (wasBefore && !freshEntry) {
      removed.push(path);
    } else if (wasBefore && freshEntry) {
      const prev = before.get(path);
      if (prev && prev.sha256 !== freshEntry.sha256) changed.push(path);
      else unchanged += 1;
    }
  }

  // Orphan cleanup. Two cases:
  //   1. `removed` paths — delete ALL rows for (source, source_path).
  //   2. `changed` paths — the fresh upsert wrote a new sha; the old-sha row
  //      still exists since sha is UNIQUE and the path can host multiple
  //      rows. Delete every row at this path whose sha != the fresh sha.
  let orphansDeleted = 0;
  for (const path of removed) {
    const res = await db
      .delete(knowledgeChunks)
      .where(and(eq(knowledgeChunks.source, source.name), eq(knowledgeChunks.sourcePath, path)))
      .returning({ id: knowledgeChunks.id });
    orphansDeleted += res.length;
  }
  for (const path of changed) {
    const freshSha = freshMap.get(path)?.sha256;
    if (!freshSha) continue;
    const res = await db
      .delete(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.source, source.name),
          eq(knowledgeChunks.sourcePath, path),
          sql`${knowledgeChunks.chunkSha256} <> ${freshSha}`,
        ),
      )
      .returning({ id: knowledgeChunks.id });
    orphansDeleted += res.length;
  }

  const kind = classifyDrift({ added, removed, changed, beforeMap: before, afterMap: freshMap });
  if (kind && (added.length > 0 || removed.length > 0 || changed.length > 0)) {
    logger.info(
      {
        source: source.name,
        kind,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        orphansDeleted,
      },
      'knowledge: drift detected',
    );
  }

  return {
    ...result,
    drift: { added, removed, changed, unchanged, kind },
    orphansDeleted,
  };
}

interface ClassifyInput {
  added: string[];
  removed: string[];
  changed: string[];
  beforeMap: Map<string, SnapshotEntry>;
  afterMap: Map<string, SnapshotEntry>;
}

/**
 * Conservative price-pattern matcher — French formats only (V1 scope).
 * Matches `5€`, `5,99 €`, `5.99 €`, `5 euros`, `5 euro`.
 */
const PRICE_RE = /(\d+[.,]?\d*\s*€|\d+\s*euros?)/gi;

function classifyDrift({
  added,
  removed,
  changed,
  beforeMap,
  afterMap,
}: ClassifyInput): DriftKind | null {
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;
  if (removed.length > 0 && added.length === 0 && changed.length === 0) return 'removed_product';
  if (added.length > 0 && removed.length === 0 && changed.length === 0) return 'new_product';

  if (changed.length > 0) {
    for (const path of changed) {
      const beforeText = beforeMap.get(path)?.text ?? '';
      const afterText = afterMap.get(path)?.text ?? '';
      const beforePrices = (beforeText.match(PRICE_RE) ?? []).join(' ');
      const afterPrices = (afterText.match(PRICE_RE) ?? []).join(' ');
      if (beforePrices !== afterPrices && (beforePrices || afterPrices)) {
        return 'price_change';
      }
    }
  }
  return 'other';
}
