/**
 * Realtime LISTEN/NOTIFY wrapper integration tests (M3.T8).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL — the agent_message test path
 * exercises the dispatcher, which writes durable rows AND enqueues BullMQ
 * jobs. PII_ENCRYPTION_KEY is injected by the suite when absent so the
 * agent_messages encrypted columns don't trip on boot.
 *
 * Spin up:
 *   docker run -d --name f16-pg-m3t8 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker run -d --name f16-redis-m3t8 -p 6381:6379 redis:7-alpine --appendonly yes
 *   docker exec -i f16-pg-m3t8 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 \
 *     TEST_REDIS_URL=redis://127.0.0.1:6381 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { sendMessage } from '../../src/messaging/dispatcher.js';
import * as humanActionsRepo from '../../src/db/repositories/human-actions.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';
import {
  RealtimeListener,
  type AgentMessageNotification,
  type HumanActionNotification,
} from '../../src/realtime/notify.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const liveBoth = Boolean(pgUrl && redisUrl);
const d = describe.skipIf(!liveBoth);

let savedPiiKey: string | undefined;
let savedRedisUrl: string | undefined;
let savedPrefix: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  savedRedisUrl = process.env.REDIS_URL;
  savedPrefix = process.env.BULLMQ_PREFIX;
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
  if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
  else process.env.BULLMQ_PREFIX = savedPrefix;
});

/**
 * Wait for a predicate, returning the first value it produces. Used to await
 * a NOTIFY event matching a filter without racing against the event emitter.
 */
async function waitForEvent<T>(
  attach: (handler: (v: T) => void) => void,
  detach: (handler: (v: T) => void) => void,
  filter: (v: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onTimeout = setTimeout(() => {
      detach(handler);
      reject(new Error(`waitForEvent: no event matching filter within ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (v: T): void => {
      if (filter(v)) {
        clearTimeout(onTimeout);
        detach(handler);
        resolve(v);
      }
    };
    attach(handler);
  });
}

d('RealtimeListener (live)', () => {
  let db: Database;
  let rt: RealtimeListener;
  let prefix: string;

  beforeEach(async () => {
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    // Wipe both tables so cross-test events don't bleed.
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);

    rt = new RealtimeListener({ databaseUrl: pgUrl! });
    await rt.start();
  });

  afterEach(async () => {
    await rt.stop();
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  // -------------------------------------------------------------------------
  // test 1: agent_message NOTIFY arrives within the timeout window
  // -------------------------------------------------------------------------

  it('test 1 (agent_message): NOTIFY arrives shortly after dispatcher.sendMessage', async () => {
    const correlationId = `corr-${randomUUID()}`;

    const eventPromise = waitForEvent<AgentMessageNotification>(
      (h) => rt.on('agent_message', h),
      (h) => rt.off('agent_message', h),
      (n) => n.correlation_id === correlationId,
      5000,
    );

    const id = await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: {
          leadId: randomUUID(),
          source: 'website',
          productLine: 'scooter',
        },
        correlationId,
      },
    );

    const evt = await eventPromise;
    expect(evt.id).toBe(id);
    expect(evt.to_role).toBe('lead-scorer');
    expect(evt.intent).toBe('LEAD.NEW');
    expect(evt.correlation_id).toBe(correlationId);
    expect(typeof evt.priority).toBe('number');
    expect(typeof evt.created_at).toBe('string');
  });

  // -------------------------------------------------------------------------
  // test 2: human_action NOTIFY on INSERT
  // -------------------------------------------------------------------------

  it('test 2 (human_action INSERT): NOTIFY fires when a pending action is created', async () => {
    const correlationId = `ha-insert-${randomUUID()}`;

    const eventPromise = waitForEvent<HumanActionNotification>(
      (h) => rt.on('human_action', h),
      (h) => rt.off('human_action', h),
      (n) => n.correlation_id === correlationId,
      5000,
    );

    const created = await humanActionsRepo.createAction(db, {
      createdByAgent: 'lead-scorer',
      intent: 'LEAD.NEW',
      severity: 2,
      summary: 'Manual review requested',
      options: [
        { id: 'approve', label: 'Approve', kind: 'approve' },
        { id: 'reject', label: 'Reject', kind: 'reject' },
      ],
      correlationId,
    });

    const evt = await eventPromise;
    expect(evt.id).toBe(created.id);
    expect(evt.op).toBe('INSERT');
    expect(evt.status).toBe('pending');
    expect(evt.severity).toBe(2);
    expect(evt.correlation_id).toBe(correlationId);
  });

  // -------------------------------------------------------------------------
  // test 3: human_action NOTIFY on UPDATE (status change to resolved)
  // -------------------------------------------------------------------------

  it('test 3 (human_action UPDATE): NOTIFY fires when status flips to resolved', async () => {
    const correlationId = `ha-update-${randomUUID()}`;

    // Create the row first; we'll consume the INSERT event before resolving so
    // the UPDATE event is the next one matching the correlation_id.
    const insertPromise = waitForEvent<HumanActionNotification>(
      (h) => rt.on('human_action', h),
      (h) => rt.off('human_action', h),
      (n) => n.correlation_id === correlationId && n.op === 'INSERT',
      5000,
    );

    const created = await humanActionsRepo.createAction(db, {
      createdByAgent: 'lead-scorer',
      intent: 'LEAD.NEW',
      severity: 2,
      summary: 'Approve or reject',
      options: [
        { id: 'approve', label: 'Approve', kind: 'approve' },
        { id: 'reject', label: 'Reject', kind: 'reject' },
      ],
      correlationId,
    });

    await insertPromise;

    // Now arm the UPDATE listener and resolve.
    const updatePromise = waitForEvent<HumanActionNotification>(
      (h) => rt.on('human_action', h),
      (h) => rt.off('human_action', h),
      (n) => n.correlation_id === correlationId && n.op === 'UPDATE',
      5000,
    );

    await humanActionsRepo.resolveAction(db, created.id, {
      chosenOption: { id: 'approve', label: 'Approve', kind: 'approve' },
      by: 'admin@example.com',
      source: 'admin',
    });

    const evt = await updatePromise;
    expect(evt.id).toBe(created.id);
    expect(evt.op).toBe('UPDATE');
    expect(evt.status).toBe('resolved');
    expect(evt.correlation_id).toBe(correlationId);
  });

  // -------------------------------------------------------------------------
  // test 4: malformed JSON is logged but doesn't crash the listener
  // -------------------------------------------------------------------------

  it('test 4 (invalid payload): malformed JSON is dropped; listener stays alive', async () => {
    // Send a raw malformed payload via a side-channel postgres connection.
    // We use sql.notify which escapes payload params correctly.
    const sideSql = postgres(pgUrl!, { max: 1, idle_timeout: 5, connect_timeout: 10 });
    try {
      await sideSql.notify('agent_messages_channel', 'not json');
      // Also send a schema-mismatched but-valid JSON to exercise that branch.
      await sideSql.notify('agent_messages_channel', JSON.stringify({ missing: 'fields' }));
    } finally {
      await sideSql.end({ timeout: 5 });
    }

    // After the malformed payloads, send a valid agent_message and assert the
    // listener still routes it. If the malformed payload had crashed the
    // listener, this event would never arrive.
    const correlationId = `survive-${randomUUID()}`;
    const eventPromise = waitForEvent<AgentMessageNotification>(
      (h) => rt.on('agent_message', h),
      (h) => rt.off('agent_message', h),
      (n) => n.correlation_id === correlationId,
      5000,
    );

    await sendMessage(
      { db },
      {
        fromRole: 'webhook',
        toRole: 'lead-scorer',
        intent: 'LEAD.NEW',
        payload: {
          leadId: randomUUID(),
          source: 'website',
          productLine: 'scooter',
        },
        correlationId,
      },
    );

    const evt = await eventPromise;
    expect(evt.correlation_id).toBe(correlationId);
  });

  // -------------------------------------------------------------------------
  // test 5: stop() is idempotent
  // -------------------------------------------------------------------------

  it('test 5 (idempotent stop): calling stop twice does not throw', async () => {
    await rt.stop();
    await expect(rt.stop()).resolves.toBeUndefined();
    // Re-stub a fresh listener so the afterEach hook's stop() is a no-op.
    rt = new RealtimeListener({ databaseUrl: pgUrl! });
    // not started — its stop is also a no-op.
  });

  // -------------------------------------------------------------------------
  // test 6: start() after stop() throws
  // -------------------------------------------------------------------------

  it('test 6 (no restart): start() after stop() throws', async () => {
    await rt.stop();
    await expect(rt.start()).rejects.toThrow(/stopped/);
    // Replace rt so the afterEach stop() is a safe no-op.
    rt = new RealtimeListener({ databaseUrl: pgUrl! });
  });

  // -------------------------------------------------------------------------
  // test 7: start() twice on a fresh listener throws
  // -------------------------------------------------------------------------

  it('test 7 (double start): start() twice throws', async () => {
    await expect(rt.start()).rejects.toThrow(/already started/);
  });
});
