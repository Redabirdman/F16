/**
 * Integration tests for the 4 built-in tools (M3.T6).
 *
 * Gated on TEST_DATABASE_URL — most tests need live pg. The `human.escalate`
 * test additionally requires TEST_REDIS_URL since it goes through the
 * dispatcher (DB row + BullMQ enqueue).
 *
 * Spin up (mirrors dispatcher.test.ts):
 *   docker run -d --name f16-pg-m3t6 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker run -d --name f16-redis-m3t6 -p 6381:6379 redis:7-alpine
 *   docker exec -i f16-pg-m3t6 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=... TEST_REDIS_URL=... PII_ENCRYPTION_KEY=... pnpm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { customers, humanActions, agentMessages } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { upsertChunk } from '../../src/db/repositories/knowledge.js';
import { invokeTool, type ToolContext } from '../../src/tools/registry.js';
// Importing the barrel triggers registration of all four builtins.
import '../../src/tools/index.js';
import {
  customerReadProfileToolName,
  customerUpdateProfileToolName,
  knowledgeSearchToolName,
  humanEscalateToolName,
} from '../../src/tools/builtins/index.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const livePg = Boolean(pgUrl);
const liveBoth = Boolean(pgUrl && redisUrl);

const dPg = describe.skipIf(!livePg);
const dPgRedis = describe.skipIf(!liveBoth);

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

/** 1536-dim padded embedding for deterministic kNN ordering. */
function emb(seed: number[]): number[] {
  const v = new Array<number>(1536).fill(0);
  for (let i = 0; i < seed.length && i < 1536; i++) v[i] = seed[i]!;
  return v;
}

function sha(): string {
  return randomBytes(32).toString('hex');
}

dPg('builtin tools — DB-only (live pg)', () => {
  let db: Database;
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    agentRole: 'test-agent',
    agentInstance: 'inst-1',
    ...over,
  });

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE knowledge_chunks RESTART IDENTITY CASCADE`);
  });

  // -------------------------------------------------------------------------
  // customer.read_profile
  // -------------------------------------------------------------------------

  it('test 1 (read_profile happy path): returns decrypted PII', async () => {
    const inserted = await insertCustomer(db, {
      fullName: 'Élodie Dupont',
      email: 'elodie@example.fr',
      phone: '+33612345678',
      address: { street: '12 rue de Rivoli', city: 'Paris', postcode: '75001' },
      civility: 'Mrs',
      vehicle: { make: 'Renault', model: 'Zoé' },
      driver: { licenseType: 'B' },
      preferences: { channel: 'whatsapp', lang: 'fr' },
      hubspotId: 'hs-001',
    });

    const out = (await invokeTool(ctx(), customerReadProfileToolName, {
      customerId: inserted.id,
    })) as {
      id: string;
      fullName: string;
      email: string | null;
      phone: string | null;
      address: { street: string; city: string; postcode: string } | null;
      vehicle: { make: string } | null;
      hubspotId: string | null;
      createdAt: string;
    };

    expect(out.id).toBe(inserted.id);
    expect(out.fullName).toBe('Élodie Dupont');
    expect(out.email).toBe('elodie@example.fr');
    expect(out.phone).toBe('+33612345678');
    expect(out.address?.city).toBe('Paris');
    expect(out.vehicle?.make).toBe('Renault');
    expect(out.hubspotId).toBe('hs-001');
    expect(out.createdAt).toMatch(/T.*Z$/);
  });

  it('test 2 (read_profile not found): throws on unknown id', async () => {
    await expect(
      invokeTool(ctx(), customerReadProfileToolName, { customerId: randomUUID() }),
    ).rejects.toThrow(/not found/);
  });

  // -------------------------------------------------------------------------
  // customer.update_profile
  // -------------------------------------------------------------------------

  it('test 3 (update_profile happy path): writes new PII, re-encrypted in DB', async () => {
    const inserted = await insertCustomer(db, {
      fullName: 'Original Name',
      email: 'old@example.fr',
      phone: '+33611111111',
    });

    const result = await invokeTool(ctx(), customerUpdateProfileToolName, {
      customerId: inserted.id,
      fields: {
        email: 'new@example.fr',
        phone: '+33699999999',
        preferences: { channel: 'sms' },
      },
    });
    expect(result).toEqual({ updated: true });

    // Read back through read_profile — confirms the decrypt path sees the new values.
    const reread = (await invokeTool(ctx(), customerReadProfileToolName, {
      customerId: inserted.id,
    })) as {
      email: string;
      phone: string;
      fullName: string;
      preferences: { channel: string } | null;
    };
    expect(reread.email).toBe('new@example.fr');
    expect(reread.phone).toBe('+33699999999');
    expect(reread.fullName).toBe('Original Name'); // untouched
    expect(reread.preferences?.channel).toBe('sms');

    // Raw select — ciphertext, NOT the plaintext we wrote.
    const [row] = await db.select().from(customers).where(eq(customers.id, inserted.id));
    expect(row!.email).not.toBeNull();
    expect(row!.email).not.toBe('new@example.fr');
    expect(row!.phone).not.toBe('+33699999999');
    // base64 of (iv|ct|tag) — at minimum, longer than the plaintext.
    expect(row!.email!.length).toBeGreaterThan('new@example.fr'.length);
  });

  it('test 4 (update_profile empty fields): no-op success', async () => {
    const inserted = await insertCustomer(db, { fullName: 'Empty Update' });
    const before = await db.select().from(customers).where(eq(customers.id, inserted.id));
    const result = await invokeTool(ctx(), customerUpdateProfileToolName, {
      customerId: inserted.id,
      fields: {},
    });
    expect(result).toEqual({ updated: true });
    const after = await db.select().from(customers).where(eq(customers.id, inserted.id));
    // updated_at NOT bumped on empty no-op.
    expect(after[0]!.updatedAt.toISOString()).toBe(before[0]!.updatedAt.toISOString());
  });

  it('test 5 (update_profile clear field): null clears an existing PII field', async () => {
    const inserted = await insertCustomer(db, {
      fullName: 'Clear Me',
      email: 'will-be-cleared@example.fr',
    });
    await invokeTool(ctx(), customerUpdateProfileToolName, {
      customerId: inserted.id,
      fields: { email: null },
    });
    const out = (await invokeTool(ctx(), customerReadProfileToolName, {
      customerId: inserted.id,
    })) as { email: string | null };
    expect(out.email).toBeNull();
  });

  it('test 6 (update_profile not found): throws when id is unknown', async () => {
    await expect(
      invokeTool(ctx(), customerUpdateProfileToolName, {
        customerId: randomUUID(),
        fields: { fullName: 'ghost' },
      }),
    ).rejects.toThrow(/not found/);
  });

  // -------------------------------------------------------------------------
  // knowledge.search
  // -------------------------------------------------------------------------

  it('test 7 (knowledge.search): returns chunks in distance order', async () => {
    // Stub query embedding is Array(1536).fill(0.001) — so chunks whose
    // vectors point in directions less anti-correlated with that all-positive
    // baseline sort nearer. We seed three with deliberately distinct lead
    // dimensions.
    await upsertChunk(db, {
      source: 'assuryalconseil.fr',
      sourcePath: '/pricing.html',
      chunkText: 'Notre formule tous-risques inclut le vol et l’incendie.',
      chunkSha256: sha(),
      embedding: emb([1, 0, 0]),
    });
    await upsertChunk(db, {
      source: 'assuryalconseil.fr',
      sourcePath: '/faq.html',
      chunkText: 'Espace client en ligne disponible 24/7.',
      chunkSha256: sha(),
      embedding: emb([0, 1, 0]),
    });
    await upsertChunk(db, {
      source: 'maxance.product-catalog',
      sourcePath: null,
      chunkText: 'Catalogue produit Maxance scooter v3.',
      chunkSha256: sha(),
      embedding: emb([0, 0, 1]),
    });

    const hits = (await invokeTool(ctx(), knowledgeSearchToolName, {
      query: 'tous risques scooter',
      limit: 3,
    })) as Array<{ chunk: string; source: string; sourcePath: string | null; distance: number }>;

    expect(hits).toHaveLength(3);
    // Monotonic non-decreasing distances — nearest first.
    expect(hits[0]!.distance).toBeLessThanOrEqual(hits[1]!.distance);
    expect(hits[1]!.distance).toBeLessThanOrEqual(hits[2]!.distance);
    // Source attribution flows through.
    expect(hits.every((h) => typeof h.source === 'string' && h.source.length > 0)).toBe(true);
  });

  it('test 8 (knowledge.search limit): respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await upsertChunk(db, {
        source: 'assuryalconseil.fr',
        chunkText: `chunk ${i}`,
        chunkSha256: sha(),
        embedding: emb([i + 1, 0, 0]),
      });
    }
    const hits = (await invokeTool(ctx(), knowledgeSearchToolName, {
      query: 'anything',
      limit: 2,
    })) as Array<unknown>;
    expect(hits).toHaveLength(2);
  });
});

dPgRedis('builtin tools — human.escalate (live pg + redis)', () => {
  let db: Database;
  let prefix: string;
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    agentRole: 'sales-agent',
    agentInstance: 'inst-A',
    correlationId: 'lead-xyz',
    ...over,
  });

  beforeEach(async () => {
    prefix = `f16-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
  });

  afterEach(async () => {
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  it('test 9 (human.escalate): creates human_actions row + dispatches HUMAN_ACTION.REQUESTED', async () => {
    const result = (await invokeTool(ctx(), humanEscalateToolName, {
      intent: 'APPROVE_REFUND',
      severity: 2,
      summary: 'Client demande un remboursement de 250 €',
      options: [
        { id: 'approve', label: 'Approuver', kind: 'approve' as const },
        { id: 'reject', label: 'Refuser', kind: 'reject' as const },
      ],
    })) as { humanActionId: string };

    expect(result.humanActionId).toMatch(/^[0-9a-f-]{36}$/);

    // human_actions row exists with the right fields.
    const [actionRow] = await db
      .select()
      .from(humanActions)
      .where(eq(humanActions.id, result.humanActionId));
    expect(actionRow).toBeDefined();
    expect(actionRow!.intent).toBe('APPROVE_REFUND');
    expect(actionRow!.severity).toBe(2);
    expect(actionRow!.summary).toBe('Client demande un remboursement de 250 €');
    expect(actionRow!.status).toBe('pending');
    expect(actionRow!.createdByAgent).toBe('sales-agent#inst-A');
    expect(actionRow!.correlationId).toBe('lead-xyz');
    expect(Array.isArray(actionRow!.options)).toBe(true);
    expect(actionRow!.options).toHaveLength(2);

    // An agent_messages row was created carrying HUMAN_ACTION.REQUESTED.
    const messages = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.intent, 'HUMAN_ACTION.REQUESTED'));
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.fromRole).toBe('sales-agent');
    expect(msg.fromInstance).toBe('inst-A');
    expect(msg.toRole).toBe('human-router');
    expect(msg.correlationId).toBe('lead-xyz');
    expect(msg.requiresHuman).toBe(true);
    expect((msg.payload as { humanActionId: string }).humanActionId).toBe(result.humanActionId);
    expect((msg.payload as { severity: number }).severity).toBe(2);
  });

  it('test 10 (human.escalate defaults): falls back to default options when none provided', async () => {
    const result = (await invokeTool(
      ctx({ correlationId: 'lead-no-opts' }),
      humanEscalateToolName,
      {
        intent: 'CONFIRM_CALLBACK',
        severity: 3,
        summary: 'Programmer un rappel demain matin ?',
      },
    )) as { humanActionId: string };

    const [row] = await db
      .select()
      .from(humanActions)
      .where(eq(humanActions.id, result.humanActionId));
    expect(row!.options).toHaveLength(2);
    expect((row!.options as Array<{ id: string }>)[0]!.id).toBe('approve');
  });
});
