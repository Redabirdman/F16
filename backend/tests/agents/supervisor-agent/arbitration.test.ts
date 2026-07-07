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
    // startArbitration() fires an eager fire-and-forget `void tick()` on
    // construction (so a fresh boot surfaces pre-existing loops). Start the
    // scheduler FIRST and drain that eager tick against the still-empty table
    // via an awaited tickOnce() — otherwise the eager tick races our seeded
    // data and steals the flag, leaving our explicit tick to dedup-skip it.
    const handle = startArbitration({ db, intervalMs: 3_600_000 });
    try {
      await handle.tickOnce(); // drain eager tick on empty table → 0 flags

      await seedLoop('corr-loop-1', [
        ['agent-A', 'agent-B'],
        ['agent-B', 'agent-A'],
        ['agent-A', 'agent-B'],
        ['agent-B', 'agent-A'],
        ['agent-A', 'agent-B'],
        ['agent-B', 'agent-A'],
      ]);

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

  it('does NOT flag a customer conversation (channel.* ↔ agent)', async () => {
    // A normal WhatsApp customer conversation appears as many alternations
    // between `channel.whatsapp` (inbound relay) and `sales-agent` — exactly
    // 2 distinct fromRole values, so it would trip the raw 2-agent detector.
    // The channel-role exclusion must keep it OUT (07-06 false positive).
    await seedLoop('corr-customer', [
      ['channel.whatsapp', 'sales-agent'],
      ['sales-agent', 'channel.whatsapp'],
      ['channel.whatsapp', 'sales-agent'],
      ['sales-agent', 'channel.whatsapp'],
      ['channel.whatsapp', 'sales-agent'],
      ['sales-agent', 'channel.whatsapp'],
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

  it('does NOT flag the quote pipeline (maxance-operator ↔ sales-agent)', async () => {
    // A two-devis comparison legitimately exchanges 5+ request/response
    // messages on one correlation within minutes (live 2026-07-07 false
    // positive). Service-driver pairs are excluded — stalls are the
    // followthrough watchdog's job, not arbitration's.
    await seedLoop('corr-pipeline', [
      ['sales-agent', 'maxance-operator'],
      ['maxance-operator', 'sales-agent'],
      ['sales-agent', 'maxance-operator'],
      ['maxance-operator', 'sales-agent'],
      ['sales-agent', 'maxance-operator'],
      ['maxance-operator', 'sales-agent'],
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
    // Start FIRST + drain the eager construction-time tick on an empty table,
    // then seed, so our explicit `first` tick is the one that raises the flag.
    const handle = startArbitration({ db, intervalMs: 3_600_000 });
    try {
      await handle.tickOnce(); // drain eager tick on empty table → 0 flags

      await seedLoop('corr-dedup', [
        ['agent-A', 'agent-B'],
        ['agent-B', 'agent-A'],
        ['agent-A', 'agent-B'],
        ['agent-B', 'agent-A'],
        ['agent-A', 'agent-B'],
        ['agent-B', 'agent-A'],
      ]);

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
