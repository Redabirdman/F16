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
import { registerVoiceOperatorClass } from '../agents/voice-operator/index.js';
import { startVoiceWatchdog, type VoiceWatchdogHandle } from '../voice/watchdog.js';
import {
  registerEngagementAgentClass,
  startEngagementScheduler,
  type EngagementSchedulerHandle,
} from '../agents/engagement-agent/index.js';
import {
  registerSupervisorAgentClass,
  startArbitration,
  startStrategyReview,
  type ArbitrationHandle,
  type StrategyReviewHandle,
} from '../agents/supervisor-agent/index.js';
import type { BaseAgent } from '../agents/base.js';
import {
  bootstrapKnowledgeSources,
  startKnowledgeCurator,
  type KnowledgeCuratorHandle,
} from '../knowledge/index.js';
import {
  startCallbackScheduler,
  type CallbackSchedulerHandle,
} from '../leads/callback-scheduler.js';
import {
  startAdsPoller,
  startAdsLearningScheduler,
  startDraftApprovalScanner,
  type AdsPollerHandle,
  type AdsLearningHandle,
  type DraftApprovalSchedulerHandle,
} from '../agents/ads-manager-agent/index.js';
import { MetaGraphClient } from '../integrations/meta/client.js';

export interface WorkerSet {
  workers: Worker[];
  agents: BaseAgent[];
  /** Knowledge Curator singleton handle, if started. */
  knowledgeCurator: KnowledgeCuratorHandle | null;
  /** Engagement scheduler handle, if started (M11). */
  engagementScheduler: EngagementSchedulerHandle | null;
  /** Paid-lead callback scheduler handle, if started (M12). */
  callbackScheduler: CallbackSchedulerHandle | null;
  /** Ads Manager poller handle (Meta sync + fatigue), if started (M12 P2). */
  adsPoller: AdsPollerHandle | null;
  /** Ads learning scheduler handle, if started (M12 P2). */
  adsLearning: AdsLearningHandle | null;
  /** Campaign-draft approval scanner handle, if started (M12 P3). */
  adsApproval: DraftApprovalSchedulerHandle | null;
  /** Supervisor arbitration scheduler handle, if started (M15.T4). */
  supervisorArbitration: ArbitrationHandle | null;
  /** Supervisor strategy review scheduler handle, if started (M15.T3). */
  supervisorStrategy: StrategyReviewHandle | null;
  /** Self-healing voice watchdog (OVH re-register + keepalive), if started. */
  voiceWatchdog: VoiceWatchdogHandle | null;
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
    voiceOperator?: boolean;
    knowledgeCurator?: boolean;
    engagementAgent?: boolean;
    callbackScheduler?: boolean;
    adsPoller?: boolean;
    adsLearning?: boolean;
    adsApproval?: boolean;
    supervisorAgent?: boolean;
    supervisorArbitration?: boolean;
    supervisorStrategy?: boolean;
    voiceWatchdog?: boolean;
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
    // Voice origination — env-gated on the Asterisk config (ASTERISK_ARI_URL is
    // the sentinel; the agent itself re-checks the full env and disables
    // cleanly when incomplete). Off on a dev box without the voice stack.
    voiceOperator: opts.flags?.voiceOperator ?? Boolean(process.env.ASTERISK_ARI_URL),
    knowledgeCurator: opts.flags?.knowledgeCurator ?? true,
    engagementAgent: opts.flags?.engagementAgent ?? true,
    callbackScheduler: opts.flags?.callbackScheduler ?? true,
    // Poller env-gated on the Meta token + ad account; learning is cheap and
    // safe to run always (no-ops on a fresh account with no ads).
    adsPoller:
      opts.flags?.adsPoller ??
      Boolean(process.env.META_SYSTEM_USER_TOKEN && process.env.META_AD_ACCOUNT_ID),
    adsLearning: opts.flags?.adsLearning ?? true,
    // Draft-approval scanner needs the token + ad account + page to launch.
    adsApproval:
      opts.flags?.adsApproval ??
      Boolean(
        process.env.META_SYSTEM_USER_TOKEN &&
        process.env.META_AD_ACCOUNT_ID &&
        process.env.META_PAGE_ID,
      ),
    supervisorAgent: opts.flags?.supervisorAgent ?? true,
    supervisorArbitration: opts.flags?.supervisorArbitration ?? true,
    // Default OFF — burns Opus tokens daily. Operator opts in via env or
    // explicit flag once the dedicated PC is up.
    supervisorStrategy:
      opts.flags?.supervisorStrategy ?? process.env.SUPERVISOR_STRATEGY_ENABLED === 'true',
    // Voice watchdog — on when the OVH trunk is configured (it self-disables on
    // non-Windows / no WSL). Opt out with F16_VOICE_WATCHDOG=false.
    voiceWatchdog:
      opts.flags?.voiceWatchdog ??
      (Boolean(process.env.ASTERISK_OVH_TRUNK) && process.env.F16_VOICE_WATCHDOG !== 'false'),
  };

  let knowledgeCurator: KnowledgeCuratorHandle | null = null;
  let engagementScheduler: EngagementSchedulerHandle | null = null;
  let callbackScheduler: CallbackSchedulerHandle | null = null;
  let adsPoller: AdsPollerHandle | null = null;
  let adsLearning: AdsLearningHandle | null = null;
  let adsApproval: DraftApprovalSchedulerHandle | null = null;
  let supervisorArbitration: ArbitrationHandle | null = null;
  let supervisorStrategy: StrategyReviewHandle | null = null;
  let voiceWatchdog: VoiceWatchdogHandle | null = null;

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

  // 5b. voice-operator singleton (M10). Consumes VOICE.CALL_SCHEDULED and
  //     originates outbound calls via Asterisk ARI (OVH PJSIP trunk →
  //     AudioSocket → Pipecat). Env-gated on ASTERISK_ARI_URL; the agent
  //     re-validates the full ASTERISK_* env on first use and fails a call
  //     cleanly (VOICE.CALL_FAILED) when incomplete, so a partial config never
  //     crashes the process.
  if (flags.voiceOperator) {
    try {
      registerVoiceOperatorClass();
      const agent = await spawn({
        role: 'voice-operator',
        instanceId: 'singleton',
        db: opts.db,
      });
      agents.push(agent);
      logger.info('supervisor: voice-operator singleton started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: voice-operator failed to start',
      );
    }
  } else {
    logger.info('supervisor: voice-operator SKIPPED (no ASTERISK_ARI_URL set)');
  }

  // 5c. voice watchdog — self-heals the OVH SIP registration (the #1 silent
  //     voice failure: registration goes stale → "403 not registered" → no
  //     ring) by restarting Asterisk, and holds the WSL distro open via a
  //     keepalive. Network-independent (wsl.exe); self-disables off-Windows.
  if (flags.voiceWatchdog) {
    try {
      voiceWatchdog = startVoiceWatchdog();
      logger.info('supervisor: voice watchdog started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: voice watchdog failed to start',
      );
    }
  } else {
    logger.info('supervisor: voice watchdog SKIPPED (no ASTERISK_OVH_TRUNK / disabled)');
  }

  // 6. knowledge-curator (option B). Consumes KNOWLEDGE.REINDEX_REQUESTED
  //    + emits scheduled reindex requests for every registered source.
  //    bootstrapKnowledgeSources() registers the V1 corpus (Assuryal
  //    markdown KB + the conversion-machine React source for landing-page
  //    copy). The Sales Agent's knowledge.search tool searches the
  //    embedded chunks via pgvector.
  if (flags.knowledgeCurator) {
    try {
      bootstrapKnowledgeSources();
      knowledgeCurator = startKnowledgeCurator({ db: opts.db });
      logger.info('supervisor: knowledge-curator started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: knowledge-curator failed to start',
      );
    }
  } else {
    logger.info('supervisor: knowledge-curator SKIPPED by flag');
  }

  // 7. engagement-agent singleton (M11). BaseAgent listening on the
  //    `engagement` queue, plus a setInterval scheduler that scans the
  //    candidate query every 5 minutes and enqueues one ENGAGEMENT.TICK
  //    per due lead. The agent enforces every gate (status, quiet hours,
  //    cadence, anti-spam) authoritatively, so over-enqueueing is safe.
  if (flags.engagementAgent) {
    try {
      registerEngagementAgentClass();
      const agent = await spawn({
        role: 'engagement-agent',
        instanceId: 'singleton',
        db: opts.db,
      });
      agents.push(agent);
      engagementScheduler = startEngagementScheduler({ db: opts.db });
      logger.info('supervisor: engagement-agent + scheduler started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: engagement-agent failed to start',
      );
    }
  } else {
    logger.info('supervisor: engagement-agent SKIPPED by flag');
  }

  // 7b. callback scheduler (M12). Scans paid 'call'-preference leads whose
  //     callback_due_at has arrived and emits VOICE.CALL_SCHEDULED → the
  //     voice-operator dials. Single, idempotent emitter (claim-by-UPDATE).
  if (flags.callbackScheduler) {
    try {
      callbackScheduler = startCallbackScheduler({ db: opts.db });
      logger.info('supervisor: callback scheduler started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: callback scheduler failed to start',
      );
    }
  } else {
    logger.info('supervisor: callback scheduler SKIPPED by flag');
  }

  // 7c. ads-manager (M12 Phase 2). 15-min poller (Meta mirror sync + fatigue
  //     notify) env-gated on the Meta token + ad account; daily learning
  //     snapshot (cheap, no-ops on a fresh account).
  if (flags.adsPoller) {
    const token = process.env.META_SYSTEM_USER_TOKEN;
    const adAccountId = process.env.META_AD_ACCOUNT_ID;
    if (!token || !adAccountId) {
      logger.warn(
        'supervisor: ads-poller requested but META_SYSTEM_USER_TOKEN/META_AD_ACCOUNT_ID unset — skipping',
      );
    } else {
      try {
        const client = new MetaGraphClient({
          accessToken: token,
          ...(process.env.META_APP_SECRET ? { appSecret: process.env.META_APP_SECRET } : {}),
          ...(process.env.META_GRAPH_API_VERSION
            ? { apiVersion: process.env.META_GRAPH_API_VERSION }
            : {}),
        });
        adsPoller = startAdsPoller({ db: opts.db, client, adAccountId });
        logger.info('supervisor: ads-manager poller started');
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'supervisor: ads-poller failed to start',
        );
      }
    }
  } else {
    logger.info('supervisor: ads-poller SKIPPED (no META_SYSTEM_USER_TOKEN + META_AD_ACCOUNT_ID)');
  }

  if (flags.adsLearning) {
    try {
      adsLearning = startAdsLearningScheduler({ db: opts.db });
      logger.info('supervisor: ads-learning scheduler started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: ads-learning failed to start',
      );
    }
  } else {
    logger.info('supervisor: ads-learning SKIPPED by flag');
  }

  // 7d. ads draft-approval scanner (M12 P3). Polls for resolved CAMPAIGN_DRAFT
  //     actions → launches PAUSED on Meta / rejects / re-drafts. Needs the
  //     token + ad account + page.
  if (flags.adsApproval) {
    const token = process.env.META_SYSTEM_USER_TOKEN;
    const adAccountId = process.env.META_AD_ACCOUNT_ID;
    const pageId = process.env.META_PAGE_ID;
    if (!token || !adAccountId || !pageId) {
      logger.warn(
        'supervisor: ads-approval requested but META token/ad account/page unset — skipping',
      );
    } else {
      try {
        const client = new MetaGraphClient({
          accessToken: token,
          ...(process.env.META_APP_SECRET ? { appSecret: process.env.META_APP_SECRET } : {}),
          ...(process.env.META_GRAPH_API_VERSION
            ? { apiVersion: process.env.META_GRAPH_API_VERSION }
            : {}),
        });
        adsApproval = startDraftApprovalScanner({
          db: opts.db,
          client,
          adAccountId,
          pageId,
          dsaBeneficiary: process.env.META_DSA_BENEFICIARY ?? 'Assuryal',
          dsaPayor: process.env.META_DSA_PAYOR ?? 'Assuryal',
          ...(process.env.META_INSTAGRAM_USER_ID
            ? { instagramUserId: process.env.META_INSTAGRAM_USER_ID }
            : {}),
        });
        logger.info('supervisor: ads draft-approval scanner started');
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'supervisor: ads-approval failed to start',
        );
      }
    }
  } else {
    logger.info('supervisor: ads draft-approval scanner SKIPPED (no token/ad account/page)');
  }

  // 8. supervisor-agent singleton (M15.T1) + optional arbitration + strategy.
  //    T1 (observation) is a BaseAgent consuming compliance + knowledge
  //    queues. T4 (arbitration) is a 5-min interval scanning agent_messages
  //    for loops. T3 (strategy review) is a daily Opus call producing
  //    HUMAN_ACTION proposals; default OFF (env-opt-in) so dev boxes
  //    don't burn Opus tokens.
  if (flags.supervisorAgent) {
    try {
      registerSupervisorAgentClass();
      const agent = await spawn({
        role: 'supervisor',
        instanceId: 'singleton',
        db: opts.db,
      });
      agents.push(agent);
      logger.info('supervisor: supervisor-agent singleton started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: supervisor-agent failed to start',
      );
    }
  } else {
    logger.info('supervisor: supervisor-agent SKIPPED by flag');
  }

  if (flags.supervisorArbitration) {
    try {
      supervisorArbitration = startArbitration({ db: opts.db });
      logger.info('supervisor: arbitration scheduler started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: arbitration failed to start',
      );
    }
  } else {
    logger.info('supervisor: arbitration SKIPPED by flag');
  }

  if (flags.supervisorStrategy) {
    try {
      supervisorStrategy = startStrategyReview({ db: opts.db });
      logger.info('supervisor: strategy review scheduler started');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'supervisor: strategy review failed to start',
      );
    }
  } else {
    logger.info(
      'supervisor: strategy review SKIPPED (default off — set SUPERVISOR_STRATEGY_ENABLED=true)',
    );
  }

  return {
    workers,
    agents,
    knowledgeCurator,
    engagementScheduler,
    callbackScheduler,
    adsPoller,
    adsLearning,
    adsApproval,
    supervisorArbitration,
    supervisorStrategy,
    voiceWatchdog,
    stop: async () => {
      // Close BullMQ workers first (they drain in-flight jobs); then
      // stop the BaseAgent singletons. Order matters: workers may emit
      // intents that agents consume; stopping workers first prevents
      // new work from arriving at the about-to-stop agents.
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled(agents.map((a) => a.stop()));
      if (knowledgeCurator) {
        await knowledgeCurator.stop().catch(() => undefined);
      }
      if (engagementScheduler) {
        engagementScheduler.stop();
      }
      if (callbackScheduler) {
        callbackScheduler.stop();
      }
      if (adsPoller) {
        adsPoller.stop();
      }
      if (adsLearning) {
        adsLearning.stop();
      }
      if (adsApproval) {
        adsApproval.stop();
      }
      if (supervisorArbitration) {
        supervisorArbitration.stop();
      }
      if (supervisorStrategy) {
        supervisorStrategy.stop();
      }
      if (voiceWatchdog) {
        voiceWatchdog.stop();
      }
      logger.info(
        {
          workers: workers.length,
          agents: agents.length,
          knowledgeCurator: knowledgeCurator !== null,
          engagementScheduler: engagementScheduler !== null,
          callbackScheduler: callbackScheduler !== null,
          adsPoller: adsPoller !== null,
          adsLearning: adsLearning !== null,
          adsApproval: adsApproval !== null,
          supervisorArbitration: supervisorArbitration !== null,
          supervisorStrategy: supervisorStrategy !== null,
        },
        'supervisor: all workers stopped',
      );
    },
  };
}
