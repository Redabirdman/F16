/**
 * SupervisorAgent — DB-backed unit tests (M15.T1).
 *
 * Verifies the observation contract: each known intent writes a
 * `supervisor.observed.<kind>` audit row with the right metadata, and
 * unknown intents are politely skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { auditLog } from '../../../src/db/schema/index.js';
import { SupervisorAgent } from '../../../src/agents/supervisor-agent/agent.js';
import type {
  AgentMessageEnvelope,
  MessageHandlerResult,
} from '../../../src/messaging/dispatcher.js';

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

class TestableSupervisorAgent extends SupervisorAgent {
  public handle(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    return (
      this as unknown as {
        onMessage: (e: AgentMessageEnvelope) => Promise<MessageHandlerResult>;
      }
    ).onMessage(envelope);
  }
}

function envelope(intent: string, payload: unknown, correlationId?: string): AgentMessageEnvelope {
  return {
    id: 'msg-supervisor-test',
    intent,
    toRole: 'supervisor',
    toInstance: 'singleton',
    correlationId: correlationId ?? null,
    payload,
    priority: 5,
    createdAt: new Date(),
  } as unknown as AgentMessageEnvelope;
}

d('SupervisorAgent.onMessage', () => {
  let db: Database;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
  });

  function newAgent(): TestableSupervisorAgent {
    return new TestableSupervisorAgent({
      role: 'supervisor',
      instanceId: 'singleton',
      model: 'haiku',
      queues: ['compliance', 'knowledge'],
      db,
    });
  }

  it('writes a supervisor.observed.compliance.blocked row on COMPLIANCE.BLOCKED', async () => {
    const result = await newAgent().handle(
      envelope('COMPLIANCE.BLOCKED', { messageId: 'm-1', reasons: ['no_acpr'] }, 'lead-1'),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { observed: 'compliance.blocked' },
    });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('supervisor.observed.compliance.blocked');
    expect(rows[0]?.targetType).toBe('correlation');
    expect(rows[0]?.targetId).toBe('lead-1');
    const meta = rows[0]?.meta as { intent: string; payload: { reasons: string[] } };
    expect(meta.intent).toBe('COMPLIANCE.BLOCKED');
    expect(meta.payload.reasons).toEqual(['no_acpr']);
  });

  it('writes a supervisor.observed.knowledge.drift_detected row on KNOWLEDGE.DRIFT_DETECTED', async () => {
    await newAgent().handle(
      envelope('KNOWLEDGE.DRIFT_DETECTED', { source: 'assuryal', kind: 'price_change' }),
    );
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('supervisor.observed.knowledge.drift_detected');
  });

  it('writes a supervisor.observed.knowledge.reindexed row on KNOWLEDGE.REINDEXED', async () => {
    await newAgent().handle(
      envelope('KNOWLEDGE.REINDEXED', { source: 'assuryal', chunkCount: 12 }),
    );
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('supervisor.observed.knowledge.reindexed');
  });

  it('skips unhandled intents without writing audit rows', async () => {
    const result = await newAgent().handle(envelope('QUOTE.REQUESTED', {}));
    expect(result).toMatchObject({
      ok: true,
      result: { skipped: 'unhandled-intent', intent: 'QUOTE.REQUESTED' },
    });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(0);
  });
});
