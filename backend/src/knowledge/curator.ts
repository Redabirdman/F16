/**
 * Knowledge Curator — singleton background worker (F16 M7.T3).
 *
 * Two responsibilities:
 *   1. Consume `KNOWLEDGE.REINDEX_REQUESTED` from the `knowledge` queue and
 *      run `ingestSource` against the matching adapter, then emit
 *      `KNOWLEDGE.REINDEXED` once done.
 *   2. Periodically (per-source interval, default 6h) auto-emit
 *      `KNOWLEDGE.REINDEX_REQUESTED` so the corpus stays fresh without
 *      manual prodding.
 *
 * Why a singleton worker and not a `BaseAgent` instance:
 *   - The curator owns NO conversation state, NO per-instance lifecycle. It's
 *     just a queue consumer + a setInterval. `BaseAgent` would force a
 *     `toInstance` story that doesn't apply here.
 *   - Matches the lead-scorer worker pattern (`src/agents/lead-scorer/worker.ts`):
 *     one `consume()` call returning a BullMQ Worker the caller owns.
 *
 * Why `setInterval` instead of BullMQ's repeat scheduler:
 *   - At V1 scale (≤10 sources, hourly cadence) BullMQ repeat adds Redis
 *     bookkeeping for marginal benefit. A plain interval is one timer ref
 *     to clear on shutdown.
 *   - Repeat jobs survive process restart, which we DON'T want here — on
 *     restart the initial-tick emit naturally re-seeds the schedule.
 *
 * Scheduler semantics:
 *   - Tick cadence (`schedulerIntervalMs`, default 60s) is how often we ASK
 *     "is anything due?". Per-source `intervalHours` is the actual cadence.
 *   - The first tick runs immediately after startup so a fresh deploy seeds
 *     the corpus without waiting an hour.
 *   - Sources with `scheduled: false` are honored as manual-only — the
 *     scheduler skips them. They can still be triggered via dispatcher.
 *
 * Idempotency: ingestion itself is idempotent (chunk_sha256 dedup in
 * `ingestSource`). Emitting two REINDEX_REQUESTED for the same source within
 * seconds is therefore safe — the second pass just refreshes `ingested_at`.
 */
import type { Worker } from 'bullmq';
import type { Database } from '../db/index.js';
import {
  consume,
  sendMessage,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
} from '../messaging/dispatcher.js';
import { logger } from '../logger.js';
import { getKnowledgeSource, listKnowledgeSources, adapterFor } from './source-registry.js';
import { type IngestSourceOptions } from './ingest.js';
import { ingestSourceWithDrift } from './drift.js';

export interface KnowledgeCuratorOptions {
  db: Database;
  /** Override the scheduler tick cadence (ms). Default 60_000. Tests pass small values. */
  schedulerIntervalMs?: number;
  /**
   * Forwarded to `ingestSource` — lets tests inject a stub embedding batch
   * size or dryRun flag without monkey-patching the ingestor.
   */
  ingestOptions?: IngestSourceOptions;
}

export interface KnowledgeCuratorHandle {
  worker: Worker;
  scheduler: NodeJS.Timeout;
  /** Stop scheduler + drain the worker. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start the curator. Caller owns the returned handle and MUST call `stop()`
 * on shutdown — otherwise the scheduler interval keeps the process alive.
 */
export function startKnowledgeCurator(opts: KnowledgeCuratorOptions): KnowledgeCuratorHandle {
  const worker = consume({
    db: opts.db,
    queue: 'knowledge',
    role: 'knowledge-curator',
    handler: async (env) => handleReindex(opts, env),
  });

  const tickMs = opts.schedulerIntervalMs ?? 60_000;

  // Per-source emit timestamps so we don't re-fire before the interval lapses.
  // Stays in-process — on restart everything re-emits on first tick, which is
  // the desired "freshen the corpus" behavior anyway.
  const lastEmitBySource = new Map<string, number>();

  const tick = async (): Promise<void> => {
    const now = Date.now();
    for (const src of listKnowledgeSources()) {
      if (src.scheduled === false) continue;
      const intervalMs = (src.intervalHours ?? 6) * 3_600_000;
      const last = lastEmitBySource.get(src.name) ?? 0;
      if (now - last < intervalMs) continue;
      lastEmitBySource.set(src.name, now);
      logger.info(
        { source: src.name, intervalHours: src.intervalHours ?? 6 },
        'knowledge-curator: scheduled reindex emit',
      );
      try {
        await sendMessage(
          { db: opts.db },
          {
            fromRole: 'knowledge-curator',
            toRole: 'knowledge-curator',
            intent: 'KNOWLEDGE.REINDEX_REQUESTED',
            payload: { source: src.name },
            correlationId: `scheduled:${src.name}:${now}`,
            priority: 7,
          },
        );
      } catch (err) {
        // A failed emit shouldn't poison the rest of the tick — log + carry on.
        // The next tick will retry naturally.
        lastEmitBySource.delete(src.name);
        logger.error({ err, source: src.name }, 'knowledge-curator: scheduled emit failed');
      }
    }
  };

  // First tick immediately so initial deploy doesn't wait `tickMs` for the
  // first emit. Awaited inside a microtask so `start...()` returns synchronously.
  void tick();
  const scheduler = setInterval(() => {
    void tick();
  }, tickMs);

  let stopped = false;
  return {
    worker,
    scheduler,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(scheduler);
      await worker.close();
    },
  };
}

/**
 * Handle a single `KNOWLEDGE.REINDEX_REQUESTED` envelope.
 *
 * Returns:
 *   - `{ ok: true, result: { skipped: 'wrong-intent' } }` for envelopes
 *     misrouted to us (defensive — the dispatcher already filters by role
 *     but we still want to surface the case in markResult).
 *   - `{ ok: true, result: { skipped: 'unknown-source' } }` for sources not
 *     in the registry. We DON'T fail-hard so a stale scheduled emit (e.g.
 *     after a source was deregistered) doesn't poison the queue.
 *   - `{ ok: true, result }` on a successful ingest, with chunk counts.
 *   - `{ ok: false, error }` on adapter/embed errors so BullMQ retries.
 */
export async function handleReindex(
  opts: KnowledgeCuratorOptions,
  env: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  if (env.intent !== 'KNOWLEDGE.REINDEX_REQUESTED') {
    return { ok: true, result: { skipped: 'wrong-intent' } };
  }
  const payload = env.payload as { source: string; force?: boolean };
  const cfg = getKnowledgeSource(payload.source);
  if (!cfg) {
    logger.warn({ source: payload.source }, 'knowledge-curator: unknown source, skipping');
    return {
      ok: true,
      result: { skipped: 'unknown-source', source: payload.source },
    };
  }

  const t0 = Date.now();
  try {
    const adapter = adapterFor(cfg.adapter);
    const result = await ingestSourceWithDrift(
      opts.db,
      adapter,
      {
        name: cfg.name,
        path: cfg.path,
        ...(cfg.url ? { url: cfg.url } : {}),
      },
      opts.ingestOptions ?? {},
    );
    const durationMs = Date.now() - t0;

    // Informational fan-out — `KNOWLEDGE.REINDEXED` is addressed to the
    // 'supervisor' role which has no consumer yet (M13 will wire one). Same
    // pattern as `COMPLIANCE.BLOCKED`: the row sits durably until something
    // claims it, which is fine.
    await sendMessage(
      { db: opts.db },
      {
        fromRole: 'knowledge-curator',
        toRole: 'supervisor',
        intent: 'KNOWLEDGE.REINDEXED',
        payload: {
          source: cfg.name,
          chunkCount: result.chunksProcessed,
          durationMs,
        },
        correlationId: env.correlationId ?? `reindex:${cfg.name}`,
        priority: 7,
      },
    );

    // Drift fan-out — only fires when something actually changed. Price
    // changes flag the row as `requiresHuman` so an operator reviews them
    // before downstream prompts/pricing surfaces consume the new corpus.
    if (result.drift.kind) {
      await sendMessage(
        { db: opts.db },
        {
          fromRole: 'knowledge-curator',
          toRole: 'supervisor',
          intent: 'KNOWLEDGE.DRIFT_DETECTED',
          payload: {
            source: cfg.name,
            kind: result.drift.kind,
            details: {
              added: result.drift.added,
              removed: result.drift.removed,
              changed: result.drift.changed,
              counts: {
                added: result.drift.added.length,
                removed: result.drift.removed.length,
                changed: result.drift.changed.length,
                unchanged: result.drift.unchanged,
              },
            },
          },
          correlationId: env.correlationId ?? `reindex:${cfg.name}`,
          requiresHuman: result.drift.kind === 'price_change',
          priority: result.drift.kind === 'price_change' ? 2 : 6,
        },
      );
    }

    logger.info(
      {
        source: cfg.name,
        processed: result.chunksProcessed,
        inserted: result.chunksInserted,
        updated: result.chunksUpdated,
        failed: result.chunksFailed,
        driftKind: result.drift.kind,
        orphansDeleted: result.orphansDeleted,
        durationMs,
      },
      'knowledge-curator: reindex done',
    );
    return {
      ok: true,
      result: {
        source: cfg.name,
        chunksProcessed: result.chunksProcessed,
        chunksInserted: result.chunksInserted,
        chunksUpdated: result.chunksUpdated,
        chunksFailed: result.chunksFailed,
        orphansDeleted: result.orphansDeleted,
        driftKind: result.drift.kind,
        durationMs,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, source: cfg.name }, 'knowledge-curator: reindex failed');
    return { ok: false, error: msg };
  }
}
