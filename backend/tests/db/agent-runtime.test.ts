/**
 * Integration tests for the agent runtime schema + repos (M2.T6). Gated on
 * TEST_DATABASE_URL — skipped otherwise so `pnpm test` stays hermetic.
 * Covers enqueue/claim semantics (SKIP LOCKED, priority order), NOTIFY
 * triggers on agent_messages + human_actions, kNN search on
 * agent_patterns + knowledge_chunks, human-action resolve idempotency,
 * audit_log queries, and chunk-upsert sha256 dedup.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { sql, eq, and, gte, lte } from 'drizzle-orm';
import { createDb } from '../../src/db/index.js';
import {
  agentMessages,
  agentPatterns,
  humanActions,
  auditLog,
  knowledgeChunks,
} from '../../src/db/schema/index.js';
import {
  enqueue,
  claimNext,
  claimSpecific,
  getById,
  markResult,
  markError,
} from '../../src/db/repositories/agent-messages.js';
import {
  createAction,
  listPending,
  resolveAction,
  escalate,
} from '../../src/db/repositories/human-actions.js';
import { upsertChunk, searchSimilar, deleteBySource } from '../../src/db/repositories/knowledge.js';

const liveUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!liveUrl);

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedKey;
});

/** Deterministic embedding builder for kNN tests — pads with zeros. */
function emb(seed: number[]): number[] {
  const v = new Array<number>(1536).fill(0);
  for (let i = 0; i < seed.length && i < 1536; i++) v[i] = seed[i]!;
  return v;
}

/** Random 32-byte hex string for chunk_sha256. */
function sha(): string {
  return randomBytes(32).toString('hex');
}

d('agent runtime (live)', () => {
  const db = createDb(liveUrl!);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_patterns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE knowledge_chunks RESTART IDENTITY CASCADE`);
  });

  // -------------------------------------------------------------------------
  // agent_messages
  // -------------------------------------------------------------------------

  it('test 1: enqueue → row appears with defaults applied', async () => {
    const row = await enqueue(db, {
      fromRole: 'lead-scorer',
      toRole: 'quote-builder',
      intent: 'QUOTE.REQUESTED',
      payload: { leadId: 'lead-123', productLine: 'scooter' },
      correlationId: 'lead-123',
    });

    expect(row.id).toBeDefined();
    expect(row.priority).toBe(5);
    expect(row.requiresHuman).toBe(false);
    expect(row.consumedAt).toBeNull();
    expect(row.payload).toEqual({ leadId: 'lead-123', productLine: 'scooter' });

    const all = await db.select().from(agentMessages);
    expect(all).toHaveLength(1);
  });

  it('test 2: claimNext returns highest-priority oldest pending, marks consumed', async () => {
    // Older message, default priority 5.
    await enqueue(db, {
      fromRole: 'a',
      toRole: 'worker',
      intent: 'X',
      payload: { n: 1 },
    });
    // Slight delay to disambiguate created_at, then higher-priority newer one.
    await new Promise((r) => setTimeout(r, 10));
    const critical = await enqueue(db, {
      fromRole: 'a',
      toRole: 'worker',
      intent: 'X',
      payload: { n: 2 },
      priority: 0,
    });
    // Decoy for a different role.
    await enqueue(db, {
      fromRole: 'a',
      toRole: 'other-worker',
      intent: 'X',
      payload: { n: 3 },
    });

    const claimed = await claimNext(db, 'worker', 'worker-1');
    expect(claimed).not.toBeNull();
    // Priority 0 wins over priority 5 regardless of order.
    expect(claimed!.id).toBe(critical.id);
    expect(claimed!.consumedBy).toBe('worker-1');
    expect(claimed!.consumedAt).not.toBeNull();
    expect((claimed!.payload as { n: number }).n).toBe(2);

    // Subsequent claim returns the older priority-5 row.
    const second = await claimNext(db, 'worker');
    expect(second).not.toBeNull();
    expect((second!.payload as { n: number }).n).toBe(1);

    // Roundtrip markResult / markError.
    await markResult(db, claimed!.id, { devisNumber: 'DR-1' });
    await markError(db, second!.id, 'maxance timeout');

    const [updated1] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, claimed!.id));
    const [updated2] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, second!.id));
    expect(updated1!.result).toEqual({ devisNumber: 'DR-1' });
    expect(updated2!.error).toBe('maxance timeout');
  });

  it('test 3: claimNext returns null when nothing pending for the role', async () => {
    await enqueue(db, {
      fromRole: 'a',
      toRole: 'role-with-msg',
      intent: 'X',
      payload: {},
    });

    const claimed = await claimNext(db, 'lonely-role');
    expect(claimed).toBeNull();
  });

  it('test 4: parallel claimNext calls get distinct rows (SKIP LOCKED)', async () => {
    // Seed 4 messages for the same role.
    for (let i = 0; i < 4; i++) {
      await enqueue(db, {
        fromRole: 'a',
        toRole: 'parallel-worker',
        intent: 'X',
        payload: { n: i },
      });
    }

    // Fire 4 parallel claims — each must get a distinct row, none null.
    const claims = await Promise.all([
      claimNext(db, 'parallel-worker', 'w-0'),
      claimNext(db, 'parallel-worker', 'w-1'),
      claimNext(db, 'parallel-worker', 'w-2'),
      claimNext(db, 'parallel-worker', 'w-3'),
    ]);

    expect(claims.every((c) => c !== null)).toBe(true);
    const ids = claims.map((c) => c!.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(4);
  });

  it('test 4b: claimSpecific claims a specific row when role matches; null otherwise', async () => {
    const row = await enqueue(db, {
      fromRole: 'a',
      toRole: 'specific-worker',
      intent: 'X',
      payload: { n: 1 },
    });

    // Mismatched role → null, and the row remains unclaimed.
    const wrongRole = await claimSpecific(db, row.id, 'someone-else');
    expect(wrongRole).toBeNull();
    const [stillPending] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, row.id));
    expect(stillPending!.consumedAt).toBeNull();

    // Right role → returns the row + marks consumed.
    const claimed = await claimSpecific(db, row.id, 'specific-worker');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(row.id);
    expect(claimed!.consumedBy).toBe('specific-worker');
    expect(claimed!.consumedAt).not.toBeNull();

    // Second claim → null (already consumed).
    const second = await claimSpecific(db, row.id, 'specific-worker');
    expect(second).toBeNull();

    // Nonexistent id → null.
    const ghost = await claimSpecific(
      db,
      '00000000-0000-4000-8000-000000000000',
      'specific-worker',
    );
    expect(ghost).toBeNull();
  });

  it('test 4c: getById returns the row or null', async () => {
    const row = await enqueue(db, {
      fromRole: 'a',
      toRole: 'getter',
      intent: 'PING',
      payload: { hello: 'world' },
    });

    const fetched = await getById(db, row.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(row.id);
    expect(fetched!.intent).toBe('PING');
    expect(fetched!.payload).toEqual({ hello: 'world' });

    const ghost = await getById(db, '00000000-0000-4000-8000-000000000000');
    expect(ghost).toBeNull();
  });

  it('test 5: NOTIFY trigger fires on agent_messages insert', async () => {
    // Open a dedicated listener connection — postgres.js's listen() returns
    // a subscription handle. The notify trigger is installed by 0004.
    const listener = postgres(liveUrl!, { max: 1 });

    const received: Array<{ id: string; intent: string }> = [];
    const sub = await listener.listen('agent_messages_channel', (payload) => {
      try {
        const parsed = JSON.parse(payload) as { id: string; intent: string };
        received.push(parsed);
      } catch {
        /* ignore malformed */
      }
    });

    try {
      await enqueue(db, {
        fromRole: 'tester',
        toRole: 'notified-role',
        intent: 'PING',
        payload: { hello: 'world' },
      });

      // Poll for up to 500ms for the notification to arrive.
      const deadline = Date.now() + 500;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(received).toHaveLength(1);
      expect(received[0]!.intent).toBe('PING');
    } finally {
      await sub.unlisten();
      await listener.end();
    }
  });

  // -------------------------------------------------------------------------
  // agent_patterns
  // -------------------------------------------------------------------------

  it('test 6: agent_patterns insert + HNSW kNN search returns nearest first', async () => {
    const e1 = emb([1, 0, 0]);
    const e2 = emb([0, 1, 0]);
    const e3 = emb([0, 0, 1]);

    await db.insert(agentPatterns).values([
      {
        agentRole: 'closer',
        patternType: 'objection-handler',
        triggerSummary: 'price is too high',
        recommendedAction: 'offer monthly plan',
        evidenceCount: 5,
        winRate: 0.6,
        embedding: e1,
      },
      {
        agentRole: 'closer',
        patternType: 'opener',
        triggerSummary: 'cold inbound',
        recommendedAction: 'ask about vehicle',
        evidenceCount: 12,
        winRate: 0.4,
        embedding: e2,
      },
      {
        agentRole: 'qualifier',
        patternType: 'heuristic',
        triggerSummary: 'mentions stolen scooter',
        recommendedAction: 'fast-track theft cover',
        evidenceCount: 3,
        winRate: 0.8,
        embedding: e3,
      },
    ]);

    // Query close to e1 — should rank "price is too high" first.
    const queryLiteral = `[${e1.join(',')}]`;
    const rows = (await db.execute(sql`
      SELECT id, trigger_summary AS "triggerSummary",
             embedding <=> ${queryLiteral}::vector AS distance
        FROM agent_patterns
       ORDER BY embedding <=> ${queryLiteral}::vector
       LIMIT 3
    `)) as unknown as Array<{ id: string; triggerSummary: string; distance: number | string }>;

    expect(rows).toHaveLength(3);
    expect(rows[0]!.triggerSummary).toBe('price is too high');
  });

  // -------------------------------------------------------------------------
  // human_actions
  // -------------------------------------------------------------------------

  it('test 7: human_actions create + list pending + resolve (idempotent) + NOTIFY on status', async () => {
    const a1 = await createAction(db, {
      createdByAgent: 'closer-1',
      intent: 'APPROVE_REFUND',
      severity: 1,
      summary: 'Demande de remboursement de 250€ à valider',
      options: [
        { id: 'yes', label: 'Approuver', kind: 'approve' },
        { id: 'no', label: 'Refuser', kind: 'reject' },
      ],
      correlationId: 'customer-9',
    });
    const a2 = await createAction(db, {
      createdByAgent: 'qualifier-2',
      intent: 'CALL_LEAD',
      severity: 3,
      summary: 'Lead silencieux — un coup de fil ?',
      options: [{ id: 'ok', label: 'Rappeler', kind: 'callback' }],
    });

    const pending = await listPending(db, { limit: 10 });
    // severity 1 first then severity 3.
    expect(pending).toHaveLength(2);
    expect(pending[0]!.id).toBe(a1.id);
    expect(pending[1]!.id).toBe(a2.id);

    // Severity filter narrows the result.
    const onlyCritical = await listPending(db, { severity: 1 });
    expect(onlyCritical).toHaveLength(1);
    expect(onlyCritical[0]!.id).toBe(a1.id);

    // Set up a NOTIFY listener for the status-change channel.
    const listener = postgres(liveUrl!, { max: 1 });
    const notifications: Array<{ op: string; status: string }> = [];
    const sub = await listener.listen('human_actions_channel', (payload) => {
      try {
        notifications.push(JSON.parse(payload) as { op: string; status: string });
      } catch {
        /* ignore */
      }
    });

    try {
      const resolved = await resolveAction(db, a1.id, {
        chosenOption: { id: 'yes', label: 'Approuver', kind: 'approve' },
        notes: 'verified bank statement',
        by: 'user-emma',
        source: 'admin',
      });
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolution?.chosenOptionId).toBe('yes');
      expect(resolved.resolvedBy).toBe('user-emma');
      expect(resolved.resolvedSource).toBe('admin');

      // Idempotency — second call returns the same resolved row, doesn't
      // overwrite the resolution.
      const replay = await resolveAction(db, a1.id, {
        chosenOption: { id: 'no', label: 'Refuser', kind: 'reject' },
        by: 'someone-else',
        source: 'whatsapp',
      });
      expect(replay.id).toBe(a1.id);
      expect(replay.status).toBe('resolved');
      expect(replay.resolution?.chosenOptionId).toBe('yes'); // original wins
      expect(replay.resolvedBy).toBe('user-emma');

      // Wait briefly for the UPDATE notification to land.
      const deadline = Date.now() + 500;
      while (
        !notifications.some((n) => n.op === 'UPDATE' && n.status === 'resolved') &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const updateNotif = notifications.find((n) => n.op === 'UPDATE');
      expect(updateNotif).toBeDefined();
      expect(updateNotif!.status).toBe('resolved');
    } finally {
      await sub.unlisten();
      await listener.end();
    }

    // escalate() sets escalatedAt without changing status.
    await escalate(db, a2.id);
    const [escalated] = await db.select().from(humanActions).where(eq(humanActions.id, a2.id));
    expect(escalated!.escalatedAt).not.toBeNull();
    expect(escalated!.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // audit_log
  // -------------------------------------------------------------------------

  it('test 8: audit_log insert + query by actor_id and time range', async () => {
    const t0 = new Date('2026-05-17T08:00:00Z');
    const t1 = new Date('2026-05-17T09:00:00Z');
    const t2 = new Date('2026-05-17T10:00:00Z');

    await db.insert(auditLog).values([
      {
        actorType: 'human',
        actorId: 'user-emma',
        action: 'agent.prompt.update',
        targetType: 'agent',
        targetId: 'closer',
        before: { prompt: 'v1' },
        after: { prompt: 'v2' },
        occurredAt: t0,
      },
      {
        actorType: 'human',
        actorId: 'user-emma',
        action: 'integration.toggle',
        targetType: 'integration',
        targetId: 'hubspot',
        after: { enabled: true },
        occurredAt: t1,
      },
      {
        actorType: 'agent',
        actorId: 'closer-1',
        action: 'human.action.resolve',
        targetType: 'human_action',
        targetId: 'ha-123',
        occurredAt: t2,
      },
    ]);

    const emmaEvents = await db.select().from(auditLog).where(eq(auditLog.actorId, 'user-emma'));
    expect(emmaEvents).toHaveLength(2);

    const windowEvents = await db
      .select()
      .from(auditLog)
      .where(and(gte(auditLog.occurredAt, t1), lte(auditLog.occurredAt, t2)));
    expect(windowEvents).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // knowledge_chunks
  // -------------------------------------------------------------------------

  it('test 9: knowledge_chunks upsert idempotent on sha256; searchSimilar nearest first', async () => {
    const sha1 = sha();
    const e1 = emb([1, 0, 0]);
    const e1b = emb([0.95, 0.05, 0]); // close variant for "refresh"
    const e2 = emb([0, 1, 0]);
    const e3 = emb([0, 0, 1]);

    const first = await upsertChunk(db, {
      source: 'assuryalconseil.fr',
      sourcePath: '/pricing.html',
      chunkText: 'Notre formule tous-risques inclut le vol et l’incendie.',
      chunkSha256: sha1,
      tokenCount: 14,
      embedding: e1,
      meta: { pageTitle: 'Pricing', lang: 'fr' },
    });

    // Re-upsert same sha → one row, refreshed embedding + meta + ingestedAt.
    await new Promise((r) => setTimeout(r, 10));
    const second = await upsertChunk(db, {
      source: 'assuryalconseil.fr',
      sourcePath: '/pricing.html',
      chunkText: 'Notre formule tous-risques inclut le vol et l’incendie.',
      chunkSha256: sha1,
      tokenCount: 14,
      embedding: e1b,
      meta: { pageTitle: 'Pricing v2', lang: 'fr' },
    });

    expect(second.id).toBe(first.id);
    expect((second.meta as { pageTitle: string }).pageTitle).toBe('Pricing v2');
    expect(second.ingestedAt.getTime()).toBeGreaterThanOrEqual(first.ingestedAt.getTime());

    const all = await db.select().from(knowledgeChunks);
    expect(all).toHaveLength(1);

    // Add two more chunks for kNN exercise.
    await upsertChunk(db, {
      source: 'assuryalconseil.fr',
      chunkText: 'Espace client en ligne disponible 24/7.',
      chunkSha256: sha(),
      embedding: e2,
    });
    await upsertChunk(db, {
      source: 'maxance.product-catalog',
      chunkText: 'Catalogue produit Maxance scooter v3.',
      chunkSha256: sha(),
      embedding: e3,
    });

    const hits = await searchSimilar(db, e1, { limit: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0]!.chunk.id).toBe(first.id); // nearest is the e1b row
    expect(typeof hits[0]!.distance).toBe('number');
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);

    // deleteBySource wipes only that source.
    const removed = await deleteBySource(db, 'assuryalconseil.fr');
    expect(removed).toBe(2);
    const remaining = await db.select().from(knowledgeChunks);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.source).toBe('maxance.product-catalog');
  });
});
