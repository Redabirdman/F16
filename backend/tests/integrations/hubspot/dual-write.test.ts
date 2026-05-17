/**
 * HubSpot dual-write worker tests (M5.T2).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY (the
 * standard M5 trio). Spins up:
 *   - a `node:http.createServer` stub HubSpot on a random port,
 *   - a Postgres connection,
 *   - the dispatcher's BullMQ worker via `startHubSpotSyncWorker`,
 * and runs the LEAD.NEW path end to end.
 *
 * NEVER hits api.hubapi.com. The HubSpotClient is built with the stub baseUrl
 * + a fake token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { createDb, type Database } from '../../../src/db/index.js';
import { agentMessages, leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { sendMessage } from '../../../src/messaging/dispatcher.js';
import { ingestLead } from '../../../src/leads/intake.js';
import { HubSpotClient } from '../../../src/integrations/hubspot/client.js';
import { startHubSpotSyncWorker } from '../../../src/integrations/hubspot/dual-write.js';
import { __resetForTests, shutdownQueues } from '../../../src/queue/index.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const liveBoth = Boolean(pgUrl && redisUrl);
const d = describe.skipIf(!liveBoth);

interface SeenRequest {
  method: string;
  url: string;
  body: unknown;
}

let stub: Server;
let stubPort: number;
const seenRequests: SeenRequest[] = [];
let respond: (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

function defaultRespond(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  res.setHeader('content-type', 'application/json');
  if (url.startsWith('/crm/v3/objects/contacts/batch/upsert')) {
    res.statusCode = 200;
    res.end(JSON.stringify({ results: [{ id: 'contact-1', new: true }] }));
    return;
  }
  if (url.startsWith('/crm/v3/objects/deals') && req.method === 'POST') {
    res.statusCode = 201;
    res.end(JSON.stringify({ id: 'deal-1' }));
    return;
  }
  if (url.includes('/associations/default/deals/')) {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url.startsWith('/crm/v3/pipelines/deals')) {
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        results: [
          {
            id: 'default-pipe',
            displayOrder: 0,
            stages: [{ id: 'new-stage', displayOrder: 0 }],
          },
        ],
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end('{}');
}

beforeAll(async () => {
  respond = defaultRespond;
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      seenRequests.push({ method: req.method ?? '', url: req.url ?? '', body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubPort = (stub.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
});

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

function buildClient(): HubSpotClient {
  return new HubSpotClient({
    accessToken: 'pat-test',
    baseUrl: `http://127.0.0.1:${stubPort}`,
    sleepMs: async () => undefined,
  });
}

/** Spin-wait until `pred()` is true or the budget runs out. */
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

d('hubspot dual-write (live)', () => {
  let db: Database;
  let worker: Worker;
  let prefix: string;

  beforeEach(async () => {
    seenRequests.length = 0;
    respond = defaultRespond;
    prefix = `f16-test-hsync-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = redisUrl!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();

    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);

    worker = startHubSpotSyncWorker({ db, client: buildClient() });
  });

  afterEach(async () => {
    await worker.close().catch(() => {});
    await shutdownQueues().catch(() => {});
    __resetForTests();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------
  it('test 1 (happy path): contact upsert + deal create + association + hubspot_deal_id set', async () => {
    const customer = await insertCustomer(db, {
      fullName: 'Marie Curie',
      email: 'marie@example.com',
      phone: '+33612345678',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'hubspot-sync',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    // Wait for the worker to write the deal id back.
    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return Boolean(row?.hubspotDealId);
    });

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.hubspotDealId).toBe('deal-1');

    // HubSpot saw: pipelines, contact upsert, deal create, association.
    const urls = seenRequests.map((r) => r.url);
    expect(urls).toContain('/crm/v3/pipelines/deals');
    expect(urls).toContain('/crm/v3/objects/contacts/batch/upsert');
    expect(urls).toContain('/crm/v3/objects/deals');
    expect(urls.some((u) => u.includes('/associations/default/deals/deal-1'))).toBe(true);

    // The contact upsert body has firstname=Marie/lastname=Curie/phone=+33...
    const upsertReq = seenRequests.find((r) =>
      r.url.startsWith('/crm/v3/objects/contacts/batch/upsert'),
    )!;
    const ub = upsertReq.body as {
      inputs: Array<{ properties: Record<string, string> }>;
    };
    expect(ub.inputs[0]!.properties).toMatchObject({
      email: 'marie@example.com',
      firstname: 'Marie',
      lastname: 'Curie',
      phone: '+33612345678',
    });

    // The agent_messages row is marked consumed with an ok result.
    await waitFor(async () => {
      const [m] = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return m?.consumedAt != null && m.result != null;
    });
    const [msg] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect(msg!.toRole).toBe('hubspot-sync');
    expect(msg!.error).toBeNull();
    const result = msg!.result as Record<string, unknown>;
    expect(result['hubspotDealId']).toBe('deal-1');
    expect(result['hubspotContactId']).toBe('contact-1');
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency
  // -------------------------------------------------------------------------
  it('test 2 (idempotency): second LEAD.NEW for the same lead is skipped, no duplicate HubSpot calls', async () => {
    const customer = await insertCustomer(db, {
      fullName: 'Bob',
      email: 'bob@example.com',
      phone: '+33612345679',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    // First send -> writes hubspot_deal_id.
    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'hubspot-sync',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );
    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return Boolean(row?.hubspotDealId);
    });
    const firstCallCount = seenRequests.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Second send -> handler should see hubspot_deal_id and short-circuit.
    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'hubspot-sync',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    // Wait until BOTH agent_messages rows are consumed (the second one with
    // the skipped:'already-synced' result).
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return rows.length === 2 && rows.every((r) => r.consumedAt != null);
    });

    expect(seenRequests.length).toBe(firstCallCount);

    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    const results = rows.map((r) => r.result as Record<string, unknown>);
    const skipped = results.find((r) => r['skipped'] === 'already-synced');
    expect(skipped).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 3. No email on the customer
  // -------------------------------------------------------------------------
  it('test 3 (no email): handler returns skipped:no-email and does not hit HubSpot', async () => {
    const customer = await insertCustomer(db, {
      fullName: 'NoEmail',
      phone: '+33612345680',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'hubspot-sync',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    await waitFor(async () => {
      const [m] = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return m?.consumedAt != null;
    });

    expect(seenRequests).toHaveLength(0);
    const [msg] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    const result = msg!.result as Record<string, unknown>;
    expect(result['skipped']).toBe('no-email');

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.hubspotDealId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Lead with no customer_id
  // -------------------------------------------------------------------------
  it('test 4 (no customer): skipped:no-customer, no HubSpot calls', async () => {
    const [insertedLead] = await db
      .insert(leads)
      .values({
        // customerId omitted on purpose
        source: 'website',
        productLine: 'scooter',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'hubspot-sync',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    await waitFor(async () => {
      const [m] = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return m?.consumedAt != null;
    });
    expect(seenRequests).toHaveLength(0);
    const [msg] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect((msg!.result as Record<string, unknown>)['skipped']).toBe('no-customer');
  });

  // -------------------------------------------------------------------------
  // 5. Persistent HubSpot 5xx -> error column populated
  // -------------------------------------------------------------------------
  it('test 5 (persistent 5xx): agent_message has error populated, hubspot_deal_id stays null', async () => {
    // Pipelines GET succeeds; everything else 503. The first hit will be
    // upsertContact, which retries 3x then throws.
    respond = (req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/crm/v3/pipelines/deals')) {
        defaultRespond(req, res);
        return;
      }
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end('{"status":"error"}');
    };

    const customer = await insertCustomer(db, {
      fullName: 'Five Hundred',
      email: 'fail@example.com',
      phone: '+33612345681',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'hubspot-sync',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    // The handler throws — wait for the error column to populate.
    await waitFor(async () => {
      const [m] = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.correlationId, leadId));
      return m?.error != null;
    });

    const [msg] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, leadId));
    expect(msg!.error).toMatch(/503/);
    expect(msg!.result).toBeNull();

    const [final] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(final!.hubspotDealId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Fan-out: ingestLead writes BOTH lead-scorer + hubspot-sync rows
  // -------------------------------------------------------------------------
  it('test 6 (fan-out): ingestLead produces BOTH lead-scorer and hubspot-sync rows in agent_messages', async () => {
    const result = await ingestLead(db, {
      source: 'website',
      productLine: 'scooter',
      fullName: 'Fanout Tester',
      email: 'fan@example.com',
      phone: '+33612345682',
    });

    // The hubspot-sync worker we started will consume its row + sync to the
    // stub. Wait for the deal id to land.
    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, result.leadId));
      return Boolean(row?.hubspotDealId);
    });

    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.correlationId, result.leadId));
    expect(rows).toHaveLength(2);
    const roles = rows.map((r) => r.toRole).sort();
    expect(roles).toEqual(['hubspot-sync', 'lead-scorer']);
    // Every row carries the same intent + the same priority.
    for (const r of rows) {
      expect(r.intent).toBe('LEAD.NEW');
      expect(r.priority).toBe(4);
    }
  });

  // -------------------------------------------------------------------------
  // 7. Custom-property graceful degrade: HubSpot rejects f16_lead_id, retry succeeds
  // -------------------------------------------------------------------------
  it('test 7 (custom-property degrade): retries upsert without F16 custom props on "does not exist"', async () => {
    let upsertCalls = 0;
    respond = (req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/crm/v3/pipelines/deals')) {
        defaultRespond(req, res);
        return;
      }
      if (url.startsWith('/crm/v3/objects/contacts/batch/upsert')) {
        upsertCalls++;
        const body = req as unknown as { _capturedBody?: unknown };
        // Reject the first call (which carries f16_*); accept the retry.
        if (upsertCalls === 1) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              status: 'error',
              category: 'VALIDATION_ERROR',
              message: 'Property values were not valid',
              errors: [{ message: 'Property "f16_lead_id" does not exist', in: 'f16_lead_id' }],
            }),
          );
          return;
        }
        // Silence unused-var lint
        void body;
        defaultRespond(req, res);
        return;
      }
      defaultRespond(req, res);
    };

    const customer = await insertCustomer(db, {
      fullName: 'Degrade Tester',
      email: 'degrade@example.com',
      phone: '+33612345683',
    });
    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    await sendMessage(
      { db },
      {
        fromRole: 'channel.intake',
        toRole: 'hubspot-sync',
        intent: 'LEAD.NEW',
        payload: { leadId, source: 'website', productLine: 'scooter' },
        correlationId: leadId,
        priority: 4,
      },
    );

    await waitFor(async () => {
      const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
      return Boolean(row?.hubspotDealId);
    });

    // Two upsert calls: rejected then retried without f16_ props.
    const upserts = seenRequests.filter((r) =>
      r.url.startsWith('/crm/v3/objects/contacts/batch/upsert'),
    );
    expect(upserts.length).toBe(2);
    const retryBody = upserts[1]!.body as {
      inputs: Array<{ properties: Record<string, string> }>;
    };
    expect(retryBody.inputs[0]!.properties).not.toHaveProperty('f16_lead_id');
    expect(retryBody.inputs[0]!.properties).not.toHaveProperty('f16_product_line');
    expect(retryBody.inputs[0]!.properties).not.toHaveProperty('f16_source');
    // Standard props are still present.
    expect(retryBody.inputs[0]!.properties).toMatchObject({
      email: 'degrade@example.com',
      firstname: 'Degrade',
      lastname: 'Tester',
    });
  });
});
