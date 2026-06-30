/**
 * Supervisor unit tests — verify env-gated startup decisions without
 * actually opening BullMQ workers or spawning real agents.
 *
 * Strategy: mock the worker-start functions + the agent registry's
 * spawn() to capture call-args without doing any I/O.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db/index.js';

// Hoist mocks for everything the supervisor would otherwise actually start.
vi.mock('../../src/agents/lead-scorer/index.js', () => ({
  startLeadScorerWorker: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
}));
// Sales-agent class registration is a side effect we don't want in unit tests;
// the singleton itself is spawned via the (mocked) registry.spawn below.
vi.mock('../../src/agents/sales-agent/index.js', () => ({
  registerSalesAgentClass: vi.fn(),
}));
// Track HubSpotClient construction calls without `new` from vi.fn.
const hubspotClientCalls: Array<{ accessToken?: string }> = [];
vi.mock('../../src/integrations/hubspot/index.js', () => {
  // Constructor-only class is the cheapest way to be `new`-able from the
  // supervisor — eslint flags the "extraneous-class" pattern, disable here.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class HubSpotClient {
    constructor(opts: { accessToken?: string }) {
      hubspotClientCalls.push(opts);
    }
  }
  return {
    HubSpotClient,
    startHubSpotSyncWorker: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  };
});
vi.mock('../../src/agents/registry.js', () => ({
  spawn: vi.fn(async () => ({ stop: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('../../src/agents/maxance-operator/index.js', () => ({
  registerMaxanceOperatorClass: vi.fn(),
}));
vi.mock('../../src/agents/reporter-agent/index.js', () => ({
  registerReporterAgentClass: vi.fn(),
}));
vi.mock('../../src/agents/voice-operator/index.js', () => ({
  registerVoiceOperatorClass: vi.fn(),
}));
vi.mock('../../src/knowledge/index.js', () => ({
  bootstrapKnowledgeSources: vi.fn(),
  startKnowledgeCurator: vi.fn(() => ({
    worker: { close: vi.fn().mockResolvedValue(undefined) },
    scheduler: setInterval(() => undefined, 1_000_000),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../../src/agents/engagement-agent/index.js', () => ({
  registerEngagementAgentClass: vi.fn(),
  startEngagementScheduler: vi.fn(() => ({
    scheduler: setInterval(() => undefined, 1_000_000),
    stop: vi.fn(),
    tickOnce: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../../src/agents/supervisor-agent/index.js', () => ({
  registerSupervisorAgentClass: vi.fn(),
  startArbitration: vi.fn(() => ({
    scheduler: setInterval(() => undefined, 1_000_000),
    stop: vi.fn(),
    tickOnce: vi.fn().mockResolvedValue({ scanned: 0, flagged: 0, skipped: 0, durationMs: 0 }),
  })),
  startStrategyReview: vi.fn(() => ({
    scheduler: setInterval(() => undefined, 1_000_000),
    stop: vi.fn(),
    tickOnce: vi.fn().mockResolvedValue({ ok: true, proposalCount: 0, digest: {} }),
  })),
}));

const { startWorkers } = await import('../../src/supervisor/index.js');
const leadScorerMod = await import('../../src/agents/lead-scorer/index.js');
const salesAgentMod = await import('../../src/agents/sales-agent/index.js');
const hubspotMod = await import('../../src/integrations/hubspot/index.js');
const registryMod = await import('../../src/agents/registry.js');
const maxanceMod = await import('../../src/agents/maxance-operator/index.js');
const reporterMod = await import('../../src/agents/reporter-agent/index.js');
const voiceOperatorMod = await import('../../src/agents/voice-operator/index.js');
const knowledgeMod = await import('../../src/knowledge/index.js');
const engagementMod = await import('../../src/agents/engagement-agent/index.js');
const supervisorAgentMod = await import('../../src/agents/supervisor-agent/index.js');

// fakeDb only needs `execute` (the supervisor reaps stale sales-agent rows
// with a single UPDATE before spawning the singleton). Everything else the
// workers would touch is mocked away.
const dbExecute = vi.fn().mockResolvedValue(undefined);
const fakeDb = { execute: dbExecute } as unknown as Database;

/** Default spawn impl — returns a stoppable agent. Re-applied each test. */
const defaultSpawn = async (): Promise<{ stop: ReturnType<typeof vi.fn> }> => ({
  stop: vi.fn().mockResolvedValue(undefined),
});

const ENV_KEYS = [
  'HUBSPOT_API_KEY',
  'HUMAN_ACTION_GROUP_CHAT_ID',
  'WAHA_BASE_URL',
  'MAXANCE_DRIVER',
  // Cleared so the voice-operator gate (default = Boolean(ASTERISK_ARI_URL)) is
  // deterministic regardless of the ambient .env loaded by tests/setup.ts on
  // this prod PC. Tests that want voice-operator set it explicitly.
  'ASTERISK_ARI_URL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[k];
  }
  vi.mocked(leadScorerMod.startLeadScorerWorker).mockClear();
  vi.mocked(salesAgentMod.registerSalesAgentClass).mockClear();
  vi.mocked(hubspotMod.startHubSpotSyncWorker).mockClear();
  hubspotClientCalls.length = 0;
  // mockClear keeps the base impl but NOT a per-test mockImplementation — so
  // re-pin the default here to undo any role-targeted override from a prior
  // error-tolerance test.
  vi.mocked(registryMod.spawn).mockReset();
  vi.mocked(registryMod.spawn).mockImplementation(defaultSpawn as never);
  dbExecute.mockClear();
  vi.mocked(maxanceMod.registerMaxanceOperatorClass).mockClear();
  vi.mocked(reporterMod.registerReporterAgentClass).mockClear();
  vi.mocked(voiceOperatorMod.registerVoiceOperatorClass).mockClear();
  vi.mocked(knowledgeMod.bootstrapKnowledgeSources).mockClear();
  vi.mocked(knowledgeMod.startKnowledgeCurator).mockClear();
  vi.mocked(engagementMod.registerEngagementAgentClass).mockClear();
  vi.mocked(engagementMod.startEngagementScheduler).mockClear();
  vi.mocked(supervisorAgentMod.registerSupervisorAgentClass).mockClear();
  vi.mocked(supervisorAgentMod.startArbitration).mockClear();
  vi.mocked(supervisorAgentMod.startStrategyReview).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('startWorkers — env-gated startup', () => {
  it('always starts lead-scorer + sales-agent singleton + knowledge-curator + engagement-agent + supervisor-agent', async () => {
    const set = await startWorkers({ db: fakeDb });
    expect(leadScorerMod.startLeadScorerWorker).toHaveBeenCalledTimes(1);
    // sales-agent singleton: class registered once, spawned once, stale rows reaped.
    expect(salesAgentMod.registerSalesAgentClass).toHaveBeenCalledTimes(1);
    expect(registryMod.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'sales-agent', instanceId: 'singleton' }),
    );
    // The sales-agent boot reaps stale rows via db.execute (other boot paths
    // may also use execute, so assert it ran rather than an exact count).
    expect(dbExecute).toHaveBeenCalled();
    expect(knowledgeMod.bootstrapKnowledgeSources).toHaveBeenCalledTimes(1);
    expect(knowledgeMod.startKnowledgeCurator).toHaveBeenCalledTimes(1);
    expect(engagementMod.registerEngagementAgentClass).toHaveBeenCalledTimes(1);
    expect(engagementMod.startEngagementScheduler).toHaveBeenCalledTimes(1);
    expect(supervisorAgentMod.registerSupervisorAgentClass).toHaveBeenCalledTimes(1);
    expect(supervisorAgentMod.startArbitration).toHaveBeenCalledTimes(1);
    // Strategy review default-off — should NOT have been started.
    expect(supervisorAgentMod.startStrategyReview).not.toHaveBeenCalled();
    // Only lead-scorer is a BullMQ worker now (the sales-agent is a BaseAgent).
    expect(set.workers).toHaveLength(1);
    expect(set.knowledgeCurator).not.toBeNull();
    expect(set.engagementScheduler).not.toBeNull();
    expect(set.supervisorArbitration).not.toBeNull();
    expect(set.supervisorStrategy).toBeNull();
    expect(registryMod.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'engagement-agent', instanceId: 'singleton' }),
    );
    expect(registryMod.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'supervisor', instanceId: 'singleton' }),
    );
    // sales-agent + engagement + supervisor singletons. voice-operator is
    // env-gated on ASTERISK_ARI_URL (cleared in beforeEach → off by default).
    expect(set.agents).toHaveLength(3);
  });

  it('skips sales-agent singleton when flag is false', async () => {
    const set = await startWorkers({ db: fakeDb, flags: { salesAgent: false } });
    expect(salesAgentMod.registerSalesAgentClass).not.toHaveBeenCalled();
    expect(registryMod.spawn).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: 'sales-agent' }),
    );
    // engagement + supervisor only.
    expect(set.agents).toHaveLength(2);
  });

  it('skips engagement-agent when flag is false', async () => {
    const set = await startWorkers({ db: fakeDb, flags: { engagementAgent: false } });
    expect(engagementMod.registerEngagementAgentClass).not.toHaveBeenCalled();
    expect(engagementMod.startEngagementScheduler).not.toHaveBeenCalled();
    expect(set.engagementScheduler).toBeNull();
  });

  it('skips supervisor-agent when flag is false', async () => {
    await startWorkers({ db: fakeDb, flags: { supervisorAgent: false } });
    expect(supervisorAgentMod.registerSupervisorAgentClass).not.toHaveBeenCalled();
  });

  it('starts strategy review when flag is true', async () => {
    const set = await startWorkers({ db: fakeDb, flags: { supervisorStrategy: true } });
    expect(supervisorAgentMod.startStrategyReview).toHaveBeenCalledTimes(1);
    expect(set.supervisorStrategy).not.toBeNull();
  });

  it('skips knowledge-curator when flag is false', async () => {
    const set = await startWorkers({ db: fakeDb, flags: { knowledgeCurator: false } });
    expect(knowledgeMod.startKnowledgeCurator).not.toHaveBeenCalled();
    expect(set.knowledgeCurator).toBeNull();
  });

  it('skips hubspot-sync when HUBSPOT_API_KEY is unset', async () => {
    await startWorkers({ db: fakeDb });
    expect(hubspotMod.startHubSpotSyncWorker).not.toHaveBeenCalled();
    expect(hubspotClientCalls).toHaveLength(0);
  });

  it('starts hubspot-sync when HUBSPOT_API_KEY is set', async () => {
    process.env.HUBSPOT_API_KEY = 'pat-na1-test-key';
    const set = await startWorkers({ db: fakeDb });
    expect(hubspotClientCalls).toEqual([{ accessToken: 'pat-na1-test-key' }]);
    expect(hubspotMod.startHubSpotSyncWorker).toHaveBeenCalledTimes(1);
    expect(set.workers).toHaveLength(2); // lead-scorer + hubspot-sync
  });

  it('skips reporter-agent when HUMAN_ACTION_GROUP_CHAT_ID is missing', async () => {
    process.env.WAHA_BASE_URL = 'http://127.0.0.1:3000';
    await startWorkers({ db: fakeDb });
    expect(reporterMod.registerReporterAgentClass).not.toHaveBeenCalled();
  });

  it('skips reporter-agent when WAHA_BASE_URL is missing', async () => {
    process.env.HUMAN_ACTION_GROUP_CHAT_ID = '120363012345@g.us';
    await startWorkers({ db: fakeDb });
    expect(reporterMod.registerReporterAgentClass).not.toHaveBeenCalled();
  });

  it('starts reporter-agent when both env vars are set', async () => {
    process.env.HUMAN_ACTION_GROUP_CHAT_ID = '120363012345@g.us';
    process.env.WAHA_BASE_URL = 'http://127.0.0.1:3000';
    const set = await startWorkers({ db: fakeDb });
    expect(reporterMod.registerReporterAgentClass).toHaveBeenCalledTimes(1);
    expect(registryMod.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'human-router', instanceId: 'singleton' }),
    );
    // sales-agent + reporter + engagement-agent + supervisor-agent (always-on
    // singletons; voice-operator is gated off — ASTERISK_ARI_URL cleared).
    expect(set.agents).toHaveLength(4);
  });

  it('skips maxance-operator when MAXANCE_DRIVER is unset', async () => {
    await startWorkers({ db: fakeDb });
    expect(maxanceMod.registerMaxanceOperatorClass).not.toHaveBeenCalled();
  });

  it('starts maxance-operator when MAXANCE_DRIVER is set', async () => {
    process.env.MAXANCE_DRIVER = 'chrome_extension';
    const set = await startWorkers({ db: fakeDb });
    expect(maxanceMod.registerMaxanceOperatorClass).toHaveBeenCalledTimes(1);
    expect(registryMod.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'maxance-operator', instanceId: 'singleton' }),
    );
    // sales-agent + maxance + engagement-agent + supervisor-agent (always-on
    // singletons; voice-operator is gated off — ASTERISK_ARI_URL cleared).
    expect(set.agents).toHaveLength(4);
  });

  it('skips voice-operator when ASTERISK_ARI_URL is unset', async () => {
    const set = await startWorkers({ db: fakeDb });
    expect(registryMod.spawn).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: 'voice-operator' }),
    );
    // sales-agent + engagement + supervisor.
    expect(set.agents).toHaveLength(3);
  });

  it('starts voice-operator when ASTERISK_ARI_URL is set', async () => {
    process.env.ASTERISK_ARI_URL = 'http://127.0.0.1:8088';
    const set = await startWorkers({ db: fakeDb });
    expect(registryMod.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'voice-operator', instanceId: 'singleton' }),
    );
    // sales-agent + engagement + supervisor + voice-operator.
    expect(set.agents).toHaveLength(4);
  });

  it('honors explicit flags overriding env', async () => {
    process.env.HUBSPOT_API_KEY = 'pat-na1-test';
    const set = await startWorkers({ db: fakeDb, flags: { hubspotSync: false } });
    expect(hubspotMod.startHubSpotSyncWorker).not.toHaveBeenCalled();
    expect(set.workers).toHaveLength(1); // lead-scorer only
  });
});

describe('startWorkers — error tolerance', () => {
  it('logs an error and continues if the reporter spawn throws', async () => {
    process.env.HUMAN_ACTION_GROUP_CHAT_ID = '120363012345@g.us';
    process.env.WAHA_BASE_URL = 'http://127.0.0.1:3000';
    // Role-targeted rejection (sales-agent spawns first, so a one-shot reject
    // would hit the wrong agent) — only the reporter (human-router) throws.
    vi.mocked(registryMod.spawn).mockImplementation((async (args: { role: string }) => {
      if (args.role === 'human-router') throw new Error('boom_register_throw');
      return { stop: vi.fn().mockResolvedValue(undefined) };
    }) as never);
    const set = await startWorkers({ db: fakeDb });
    // lead-scorer worker still up; reporter failed silently. sales-agent +
    // engagement-agent + supervisor-agent spawns succeed. voice-operator gated
    // off (ASTERISK_ARI_URL cleared).
    expect(set.workers).toHaveLength(1);
    expect(set.agents).toHaveLength(3);
  });

  it('logs an error and continues if maxance-operator spawn throws', async () => {
    process.env.MAXANCE_DRIVER = 'chrome_extension';
    vi.mocked(registryMod.spawn).mockImplementation((async (args: { role: string }) => {
      if (args.role === 'maxance-operator') throw new Error('boom_maxance_spawn');
      return { stop: vi.fn().mockResolvedValue(undefined) };
    }) as never);
    const set = await startWorkers({ db: fakeDb });
    expect(set.workers).toHaveLength(1);
    // maxance failed; sales-agent + engagement-agent + supervisor-agent (booted
    // around it) still up. voice-operator gated off (ASTERISK_ARI_URL cleared).
    expect(set.agents).toHaveLength(3);
  });

  it('continues booting when the sales-agent singleton spawn throws', async () => {
    vi.mocked(registryMod.spawn).mockImplementation((async (args: { role: string }) => {
      if (args.role === 'sales-agent') throw new Error('boom_sales_spawn');
      return { stop: vi.fn().mockResolvedValue(undefined) };
    }) as never);
    const set = await startWorkers({ db: fakeDb });
    expect(set.workers).toHaveLength(1); // lead-scorer
    // sales-agent failed; engagement + supervisor still up.
    expect(set.agents).toHaveLength(2);
  });
});

describe('startWorkers — stop()', () => {
  it('closes every worker and stops every agent', async () => {
    process.env.HUBSPOT_API_KEY = 'pat-na1-test';
    process.env.MAXANCE_DRIVER = 'chrome_extension';
    const set = await startWorkers({ db: fakeDb });
    await set.stop();
    for (const w of set.workers) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
    for (const a of set.agents) {
      expect(a.stop).toHaveBeenCalledTimes(1);
    }
  });
});
