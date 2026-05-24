/**
 * Arbitration scheduler (M15.T4) — DB-backed unit tests.
 *
 * Seeds a synthetic loop in agent_messages (correlation_id X with > 5
 * back-and-forth turns between exactly 2 distinct fromRole values), runs
 * a single tick via `tickOnce()`, and verifies the human_action +
 * audit_log artifacts.
 *
 * Anti-flake notes:
 *   - intervalMs is set to 1h so the auto-tick doesn't fire during the
 *     test. We exercise `tickOnce()` directly.
 *   - Bypass the dispatcher's validateIntentPayload by inserting rows
 *     into agent_messages directly via Drizzle — we only care about the
 *     arbitration's GROUP BY shape, not intent semantics.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { agentMessages, auditLog, humanActions } from '../../../src/db/schema/index.js';
import { startArbitration } from '../../../src/agents/supervisor-agent/arbitration.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

d('startArbitration.tickOnce', () => {
  let db: Database;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
  });

  async function seedLoop(correlationId: string, pairs: Array<[string, string]>): Promise<void> {
    for (const [fromRole, toRole] of pairs) {
      await db.insert(agentMessages).values({
        fromRole,
        toRole,
        intent: 'TEST.INTENT',
        payload: {},
        correlationId,
      });
    }
  }

  it('flags a correlationId with 5+ alternations between 2 agents', async () => {
    await seedLoop('corr-loop-1', [
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-A'],
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-A'],
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-A'],
    ]);
    const handle = startArbitration({ db, intervalMs: 3_600_000 });
    try {
      const result = await handle.tickOnce();
      expect(result.scanned).toBe(1);
      expect(result.flagged).toBe(1);

      const actions = await db.select().from(humanActions);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.intent).toBe('AGENT_LOOP_DETECTED');
      expect(actions[0]?.correlationId).toBe('corr-loop-1');

      const audits = await db.select().from(auditLog);
      const loopAudit = audits.find((a) => a.action === 'supervisor.arbitration.loop');
      expect(loopAudit).toBeDefined();
      expect(loopAudit?.targetId).toBe('corr-loop-1');
    } finally {
      handle.stop();
    }
  });

  it('does NOT flag a correlationId with 3 agents (real multi-agent flow)', async () => {
    await seedLoop('corr-multi', [
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-C'],
      ['agent-C', 'agent-A'],
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-C'],
      ['agent-C', 'agent-A'],
    ]);
    const handle = startArbitration({ db, intervalMs: 3_600_000 });
    try {
      const result = await handle.tickOnce();
      expect(result.scanned).toBe(0);
      expect(result.flagged).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('does NOT flag below the minimum turn threshold', async () => {
    await seedLoop('corr-tiny', [
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-A'],
    ]);
    const handle = startArbitration({ db, intervalMs: 3_600_000 });
    try {
      const result = await handle.tickOnce();
      expect(result.flagged).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('dedups: a second tick on the same loop does not create another human action', async () => {
    await seedLoop('corr-dedup', [
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-A'],
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-A'],
      ['agent-A', 'agent-B'],
      ['agent-B', 'agent-A'],
    ]);
    const handle = startArbitration({ db, intervalMs: 3_600_000 });
    try {
      const first = await handle.tickOnce();
      const second = await handle.tickOnce();
      expect(first.flagged).toBe(1);
      expect(second.flagged).toBe(0);
      expect(second.skipped).toBe(1);
      const actions = await db.select().from(humanActions);
      expect(actions).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });
});
