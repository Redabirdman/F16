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
vi.mock('../../src/orchestration/index.js', () => ({
  startSalesSpawnOrchestrator: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
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
const orchestrationMod = await import('../../src/orchestration/index.js');
const hubspotMod = await import('../../src/integrations/hubspot/index.js');
const registryMod = await import('../../src/agents/registry.js');
const maxanceMod = await import('../../src/agents/maxance-operator/index.js');
const reporterMod = await import('../../src/agents/reporter-agent/index.js');
const knowledgeMod = await import('../../src/knowledge/index.js');
const engagementMod = await import('../../src/agents/engagement-agent/index.js');
const supervisorAgentMod = await import('../../src/agents/supervisor-agent/index.js');

const fakeDb = {} as unknown as Database;

const ENV_KEYS = [
  'HUBSPOT_API_KEY',
  'HUMAN_ACTION_GROUP_CHAT_ID',
  'WAHA_BASE_URL',
  'MAXANCE_DRIVER',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[k];
  }
  vi.mocked(leadScorerMod.startLeadScorerWorker).mockClear();
  vi.mocked(orchestrationMod.startSalesSpawnOrchestrator).mockClear();
  vi.mocked(hubspotMod.startHubSpotSyncWorker).mockClear();
  hubspotClientCalls.length = 0;
  vi.mocked(registryMod.spawn).mockClear();
  vi.mocked(maxanceMod.registerMaxanceOperatorClass).mockClear();
  vi.mocked(reporterMod.registerReporterAgentClass).mockClear();
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
  it('always starts lead-scorer + sales-spawn-orchestrator + knowledge-curator + engagement-agent + supervisor-agent', async () => {
    const set = await startWorkers({ db: fakeDb });
    expect(leadScorerMod.startLeadScorerWorker).toHaveBeenCalledTimes(1);
    expect(orchestrationMod.startSalesSpawnOrchestrator).toHaveBeenCalledTimes(1);
    expect(knowledgeMod.bootstrapKnowledgeSources).toHaveBeenCalledTimes(1);
    expect(knowledgeMod.startKnowledgeCurator).toHaveBeenCalledTimes(1);
    expect(engagementMod.registerEngagementAgentClass).toHaveBeenCalledTimes(1);
    expect(engagementMod.startEngagementScheduler).toHaveBeenCalledTimes(1);
    expect(supervisorAgentMod.registerSupervisorAgentClass).toHaveBeenCalledTimes(1);
    expect(supervisorAgentMod.startArbitration).toHaveBeenCalledTimes(1);
    // Strategy review default-off — should NOT have been started.
    expect(supervisorAgentMod.startStrategyReview).not.toHaveBeenCalled();
    expect(set.workers).toHaveLength(2);
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
    // engagement + supervisor agents both spawned via registry.
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
    expect(set.workers).toHaveLength(3); // lead-scorer + sales-spawn + hubspot-sync
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
    // reporter + engagement-agent + supervisor-agent (all always-on singletons).
    expect(set.agents).toHaveLength(3);
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
    // maxance + engagement-agent + supervisor-agent (always-on singletons).
    expect(set.agents).toHaveLength(3);
  });

  it('honors explicit flags overriding env', async () => {
    process.env.HUBSPOT_API_KEY = 'pat-na1-test';
    const set = await startWorkers({ db: fakeDb, flags: { hubspotSync: false } });
    expect(hubspotMod.startHubSpotSyncWorker).not.toHaveBeenCalled();
    expect(set.workers).toHaveLength(2);
  });
});

describe('startWorkers — error tolerance', () => {
  it('logs an error and continues if the reporter spawn throws', async () => {
    process.env.HUMAN_ACTION_GROUP_CHAT_ID = '120363012345@g.us';
    process.env.WAHA_BASE_URL = 'http://127.0.0.1:3000';
    vi.mocked(registryMod.spawn).mockRejectedValueOnce(new Error('boom_register_throw'));
    const set = await startWorkers({ db: fakeDb });
    // lead-scorer + sales-spawn still up; reporter failed silently. The
    // engagement-agent + supervisor-agent spawns (after reporter) still succeed.
    expect(set.workers).toHaveLength(2);
    expect(set.agents).toHaveLength(2);
  });

  it('logs an error and continues if maxance-operator spawn throws', async () => {
    process.env.MAXANCE_DRIVER = 'chrome_extension';
    vi.mocked(registryMod.spawn).mockRejectedValueOnce(new Error('boom_maxance_spawn'));
    const set = await startWorkers({ db: fakeDb });
    expect(set.workers).toHaveLength(2);
    // maxance failed; engagement-agent + supervisor-agent (booted after) still up.
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
