/**
 * Worker supervisor — boots every backend worker / agent that's expected
 * to run for the lifetime of the process.
 *
 * Two flavours:
 *
 *   1. Function workers (BullMQ `consume()` style):
 *        - lead-scorer
 *        - hubspot-sync (env-gated on HUBSPOT_API_KEY)
 *        - sales-spawn-orchestrator (spawns sales-agent per lead)
 *
 *   2. Singleton class-based agents (BaseAgent / registry.spawn):
 *        - reporter-agent (env-gated on HUMAN_ACTION_GROUP_CHAT_ID +
 *          WAHA_BASE_URL)
 *        - maxance-operator (env-gated on MAXANCE_DRIVER)
 *
 * Each env-gated start logs whether the worker came up or was skipped.
 * Skipping is the safe default for dev: missing HUBSPOT_API_KEY shouldn't
 * crash the backend — leads still land in F16, they just don't mirror.
 *
 * Returns a `WorkerSet` with a `.stop()` for graceful shutdown. The
 * existing `start()` in src/index.ts wires SIGINT → server.close() →
 * workerSet.stop() so BullMQ workers drain cleanly.
 */
import type { Worker } from 'bullmq';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { startLeadScorerWorker } from '../agents/lead-scorer/index.js';
import { startSalesSpawnOrchestrator } from '../orchestration/index.js';
import { HubSpotClient, startHubSpotSyncWorker } from '../integrations/hubspot/index.js';
import { spawn } from '../agents/registry.js';
import { registerMaxanceOperatorClass } from '../agents/maxance-operator/index.js';
import { registerReporterAgentClass } from '../agents/reporter-agent/index.js';
import type { BaseAgent } from '../agents/base.js';

export interface WorkerSet {
  workers: Worker[];
  agents: BaseAgent[];
  /** Stop every worker + agent. Idempotent. */
  stop(): Promise<void>;
}

export interface StartWorkersOptions {
  db: Database;
  /**
   * Override which workers get started. Defaults read from process.env so
   * tests can pin a deterministic shape independently of the host env.
   * Each flag mirrors the env gate it normally reads.
   */
  flags?: {
    leadScorer?: boolean;
    hubspotSync?: boolean;
    salesSpawn?: boolean;
    reporter?: boolean;
    maxanceOperator?: boolean;
  };
}

export async function startWorkers(opts: StartWorkersOptions): Promise<WorkerSet> {
  const workers: Worker[] = [];
  const agents: BaseAgent[] = [];

  const flags = {
    leadScorer: opts.flags?.leadScorer ?? true,
    hubspotSync: opts.flags?.hubspotSync ?? Boolean(process.env.HUBSPOT_API_KEY),
    salesSpawn: opts.flags?.salesSpawn ?? true,
    reporter:
      opts.flags?.reporter ??
      Boolean(process.env.HUMAN_ACTION_GROUP_CHAT_ID && process.env.WAHA_BASE_URL),
    maxanceOperator: opts.flags?.maxanceOperator ?? Boolean(process.env.MAXANCE_DRIVER),
  };

  // 1. lead-scorer (always — LLM-driven scoring on LEAD.NEW).
  if (flags.leadScorer) {
    workers.push(startLeadScorerWorker({ db: opts.db }));
    logger.info('supervisor: lead-scorer worker started');
  } else {
    logger.info('supervisor: lead-scorer worker SKIPPED by flag');
  }

  // 2. hubspot-sync (env-gated). Mirrors LEAD.NEW into HubSpot CRM.
  //    Without HUBSPOT_API_KEY the worker is skipped — leads still land
  //    in F16 (the primary write), HubSpot just stays empty until config.
  if (flags.hubspotSync) {
    const apiKey = process.env.HUBSPOT_API_KEY;
    if (!apiKey) {
      logger.warn('supervisor: hubspot-sync requested but HUBSPOT_API_KEY is unset — skipping');
    } else {
      const client = new HubSpotClient({ accessToken: apiKey });
      workers.push(startHubSpotSyncWorker({ db: opts.db, client }));
      logger.info('supervisor: hubspot-sync worker started');
    }
  } else {
    logger.info('supervisor: hubspot-sync worker SKIPPED (no HUBSPOT_API_KEY)');
  }

  // 3. sales-spawn-orchestrator (always — spawns sales-agent per lead on
  //    LEAD.SCORED). Idempotently registers the SalesAgent class as a
  //    side effect.
  if (flags.salesSpawn) {
    workers.push(startSalesSpawnOrchestrator({ db: opts.db }));
    logger.info('supervisor: sales-spawn-orchestrator started');
  } else {
    logger.info('supervisor: sales-spawn-orchestrator SKIPPED by flag');
  }

  // 4. reporter-agent singleton (option G). Posts human-action events to
  //    the configured WhatsApp group. Without HUMAN_ACTION_GROUP_CHAT_ID
  //    the agent throws at spawn — skip cleanly here instead.
  if (flags.reporter) {
    try {
      registerReporterAgentClass();
      const agent = await spawn({
        role: 'human-router',
        instanceId: 'singleton',
        db: opts.db,
      });
      agents.push(agent);
      logger.info('supervisor: reporter-agent singleton started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: reporter-agent failed to start — human-action WA broadcasts will not happen',
      );
    }
  } else {
    logger.info(
      'supervisor: reporter-agent SKIPPED (no HUMAN_ACTION_GROUP_CHAT_ID + WAHA_BASE_URL)',
    );
  }

  // 5. maxance-operator singleton (M8.T4 + M8.T8). Consumes QUOTE.REQUESTED
  //    + QUOTE.CONFIRM_REQUESTED. Env-gated on MAXANCE_DRIVER — without
  //    that, the agent itself refuses to dispatch (phase 1 gate), so
  //    skipping the spawn here avoids the boot-time warning spam.
  if (flags.maxanceOperator) {
    try {
      registerMaxanceOperatorClass();
      const agent = await spawn({
        role: 'maxance-operator',
        instanceId: 'singleton',
        db: opts.db,
      });
      agents.push(agent);
      logger.info(
        { driver: process.env.MAXANCE_DRIVER },
        'supervisor: maxance-operator singleton started',
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: maxance-operator failed to start',
      );
    }
  } else {
    logger.info('supervisor: maxance-operator SKIPPED (no MAXANCE_DRIVER set)');
  }

  return {
    workers,
    agents,
    stop: async () => {
      // Close BullMQ workers first (they drain in-flight jobs); then
      // stop the BaseAgent singletons. Order matters: workers may emit
      // intents that agents consume; stopping workers first prevents
      // new work from arriving at the about-to-stop agents.
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled(agents.map((a) => a.stop()));
      logger.info(
        { workers: workers.length, agents: agents.length },
        'supervisor: all workers stopped',
      );
    },
  };
}
