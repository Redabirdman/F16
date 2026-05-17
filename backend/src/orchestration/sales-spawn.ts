/**
 * Sales Agent auto-spawn orchestrator (M5.T4).
 *
 * Flow:
 *   lead-scorer emits LEAD.SCORED with a fan-out to two recipients:
 *     a) toRole='sales-spawn-orchestrator' (this worker) → spawns the instance.
 *     b) toRole='sales-agent', toInstance='lead-<id>'  → consumed AFTER spawn
 *        by the instance itself (which doesn't exist yet at emit time).
 *
 *   The two messages live on the same BullMQ queue ('lead') but target
 *   DIFFERENT roles. BaseAgent + claimSpecific are role-scoped, so the
 *   orchestrator and the spawned instance never race for the same row.
 *
 * Why fan-out (vs re-emit):
 *   Re-emitting would either require state ("we already re-emitted, don't
 *   loop") or a second intent type. Fan-out is stateless and cheap — both
 *   rows land in pg, BullMQ delivers each exactly once to its owning role,
 *   and the orchestrator becomes a pure read-side reaction.
 *
 * Idempotency:
 *   - If the instance is already running in this process, we return without
 *     re-spawning.
 *   - If two LEAD.SCORED rows for the same lead race here (unlikely — the
 *     lead-scorer is idempotent — but possible across retries), the registry
 *     itself rejects the duplicate spawn with "already running", which we
 *     catch and report as a `raceLost` success.
 *
 * Not in scope (deferred):
 *   - Cross-process coordination (M14 supervisor / leader election).
 *   - TTL / stale-instance reaping (M15 supervisor).
 *   - Re-spawning crashed instances (M15 supervisor).
 */
import type { Worker } from 'bullmq';
import type { Database } from '../db/index.js';
import {
  consume,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
} from '../messaging/dispatcher.js';
import { spawn, getInstance } from '../agents/registry.js';
import { registerSalesAgentClass } from '../agents/sales-agent/register.js';
import { logger } from '../logger.js';

export interface SalesSpawnOrchestratorOptions {
  db: Database;
}

/**
 * Boot the orchestrator. Side effect: registers the SalesAgent class on
 * first call (idempotent — safe across multiple orchestrators in one process).
 *
 * Returns the BullMQ Worker so the caller can close it on shutdown.
 */
export function startSalesSpawnOrchestrator(opts: SalesSpawnOrchestratorOptions): Worker {
  registerSalesAgentClass();
  return consume({
    db: opts.db,
    queue: 'lead',
    role: 'sales-spawn-orchestrator',
    handler: async (envelope) => handleScored(opts, envelope),
  });
}

/**
 * Exported for direct testing — same handler the BullMQ worker invokes.
 */
export async function handleScored(
  opts: SalesSpawnOrchestratorOptions,
  env: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  if (env.intent !== 'LEAD.SCORED') {
    return { ok: true, result: { skipped: 'wrong-intent', intent: env.intent } };
  }

  const payload = env.payload as {
    leadId: string;
    score: number;
    channel: string;
    opening: string;
  };
  const instanceId = `lead-${payload.leadId}`;

  // Fast path: instance already alive in this process.
  const existing = getInstance('sales-agent', instanceId);
  if (existing && existing.isRunning()) {
    logger.debug(
      { leadId: payload.leadId, instanceId },
      'sales-spawn: instance already running, skipping spawn',
    );
    return { ok: true, result: { spawned: false, instanceId, reason: 'already-running' } };
  }

  try {
    await spawn({
      role: 'sales-agent',
      instanceId,
      db: opts.db,
      meta: {
        leadId: payload.leadId,
        scoredAt: new Date().toISOString(),
      },
    });
    logger.info(
      { leadId: payload.leadId, instanceId, channel: payload.channel },
      'sales-spawn: instance spawned',
    );
    return { ok: true, result: { spawned: true, instanceId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Race: a concurrent invocation won the spawn for this instance. Treat
    // as success — the instance IS running, just not because of us.
    if (/already running/i.test(msg)) {
      logger.debug(
        { leadId: payload.leadId, instanceId },
        'sales-spawn: spawn race lost — another invocation won',
      );
      return { ok: true, result: { spawned: false, instanceId, raceLost: true } };
    }
    logger.error({ err: msg, leadId: payload.leadId, instanceId }, 'sales-spawn: spawn failed');
    return { ok: false, error: msg };
  }
}
