/**
 * M6.T8 — end-to-end LIVE sales pipeline test.
 *
 * Single test that proves the whole M5+M6 machine works:
 *
 *   POST /v1/leads
 *     → ingestLead (M5.T1)
 *     → LEAD.NEW × 2 (lead-scorer + hubspot-sync)
 *     → hubspot-sync writes contact + deal (M5.T2) — STUB HubSpot
 *     → lead-scorer scores via LIVE Haiku (M5.T3)
 *     → LEAD.SCORED × 2 (orchestrator + sales-agent)
 *     → orchestrator spawns SalesAgent instance (M5.T4)
 *     → SalesAgent.handleLeadScored:
 *         → compliance on opener (LIVE Haiku)
 *         → sendViaChannel — STUB WAHA channel
 *         → leads.status → 'qualifying'
 *
 *   POST /webhooks/waha (simulated WAHA inbound)
 *     → CUSTOMER.MESSAGE_RECEIVED to sales-agent#lead-<leadId>
 *     → SalesAgent.handleCustomerMessage:
 *         → callClaudeWithTools (LIVE Sonnet, 5 tools)
 *         → compliance on draft (LIVE Haiku)
 *         → sendViaChannel — STUB WAHA again
 *
 * Skip-gated on TEST_DATABASE_URL + TEST_REDIS_URL + PII_ENCRYPTION_KEY +
 * ANTHROPIC_API_KEY. EXPENSIVE — each run costs ~$0.02-0.05 in Anthropic
 * tokens. Don't loop.
 *
 * External services are stubbed inline (HubSpot via node:http, WAHA via a
 * StubWhatsAppChannel). LLM calls (Haiku scorer, Haiku compliance, Sonnet
 * sales) are LIVE.
 *
 * Assertions focus on STRUCTURE (length, ordering, presence of rows), not
 * content — LLM non-determinism is real and we'd rather have integration
 * coverage than brittle string matching. The "in French" check is loose.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { createHmac, randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createDb, type Database } from '../../src/db/index.js';
import { conversationTurns, agentsState } from '../../src/db/schema/index.js';
import { leads } from '../../src/db/schema/leads.js';
import { buildApp } from '../../src/index.js';
import { startLeadScorerWorker } from '../../src/agents/lead-scorer/worker.js';
import { startSalesSpawnOrchestrator } from '../../src/orchestration/sales-spawn.js';
import { startHubSpotSyncWorker } from '../../src/integrations/hubspot/dual-write.js';
import { HubSpotClient } from '../../src/integrations/hubspot/client.js';
import { registerChannel, __resetChannelsForTests } from '../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../src/channels/types.js';
import { killAll, listRunning, __resetAgentRegistryForTests } from '../../src/agents/registry.js';
import { __resetSalesAgentRegistrationForTests } from '../../src/agents/sales-agent/register.js';
import { __resetForTests, shutdownQueues } from '../../src/queue/index.js';

// Skip the whole file if any required env is missing. ANTHROPIC_API_KEY is
// loaded from backend/.env by tests/setup.ts.
const REQUIRED = [
  'TEST_DATABASE_URL',
  'TEST_REDIS_URL',
  'PII_ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
] as const;
const skip = REQUIRED.some((k) => !process.env[k]);

interface HubSpotCall {
  method: string;
  url: string;
}

class StubWhatsAppChannel implements ConversationChannel {
  readonly id = 'whatsapp' as const;
  public sent: Array<SendOptions> = [];
  capabilities(): ChannelCapabilities {
    return {
      interactive: false,
      voice: false,
      attachments: false,
      markdown: false,
    };
  }
  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    this.sent.push(opts);
    return {
      channel: 'whatsapp',
      externalId: `stub-wamid-${this.sent.length}`,
      acceptedAt: new Date(),
    };
  }
  async healthCheck(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

async function waitFor<T>(
  check: () => Promise<T | undefined | false | null>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined | false | null = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last as T;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`waitFor(${opts.label}) timed out after ${opts.timeoutMs}ms`);
}

describe.skipIf(skip)('M6.T8 — end-to-end sales pipeline (LIVE Claude)', () => {
  let db: Database;
  let hubspotServer: Server;
  let hubspotPort: number;
  let hubspotCalls: Array<HubSpotCall> = [];
  let stubChannel: StubWhatsAppChannel;
  let workers: Array<{ close(): Promise<void> }> = [];
  let prefix: string;
  let savedRedisUrl: string | undefined;
  let savedPrefix: string | undefined;

  beforeAll(async () => {
    // Lock in env that the worker/queue modules consume lazily. The setup
    // tests/setup.ts populates ANTHROPIC_API_KEY + PII_ENCRYPTION_KEY from
    // backend/.env; the tester is responsible for TEST_DATABASE_URL +
    // TEST_REDIS_URL. We mirror TEST_REDIS_URL → REDIS_URL so BullMQ wires.
    savedRedisUrl = process.env.REDIS_URL;
    savedPrefix = process.env.BULLMQ_PREFIX;
    prefix = `f16-test-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    process.env.REDIS_URL = process.env['TEST_REDIS_URL']!;
    process.env.BULLMQ_PREFIX = prefix;
    __resetForTests();
    __resetAgentRegistryForTests();
    __resetSalesAgentRegistrationForTests();
    __resetChannelsForTests();

    db = createDb(process.env['TEST_DATABASE_URL']!);

    // Stub HubSpot — returns enough shape for the dual-write happy path.
    hubspotServer = createServer((req, res) => {
      hubspotCalls.push({ method: req.method ?? '', url: req.url ?? '' });
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8');
      });
      req.on('end', () => {
        // Avoid unused-var lint while keeping the body read off the socket.
        void body;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        const url = req.url ?? '';
        if (url.includes('/pipelines/deals')) {
          res.end(
            JSON.stringify({
              results: [
                {
                  id: 'pipe-1',
                  displayOrder: 0,
                  stages: [{ id: 'stage-new', displayOrder: 0 }],
                },
              ],
            }),
          );
          return;
        }
        if (url.includes('/batch/upsert')) {
          res.end(
            JSON.stringify({
              results: [{ id: 'contact-1', new: true }],
            }),
          );
          return;
        }
        if (url.endsWith('/deals') && req.method === 'POST') {
          res.end(JSON.stringify({ id: 'deal-1' }));
          return;
        }
        if (url.includes('/associations/')) {
          res.statusCode = 204;
          res.end();
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => hubspotServer.listen(0, '127.0.0.1', () => r()));
    hubspotPort = (hubspotServer.address() as AddressInfo).port;

    // Stub WAHA channel — the only ConversationChannel registered for this
    // test. Outbound sends from the Sales Agent land here instead of WAHA.
    stubChannel = new StubWhatsAppChannel();
    registerChannel(stubChannel);

    // Start the three workers we need. Each one wraps a BullMQ Worker —
    // they share the singleton ioredis client via the REDIS_URL we set
    // above.
    workers.push(startLeadScorerWorker({ db }));
    workers.push(startSalesSpawnOrchestrator({ db }));
    workers.push(
      startHubSpotSyncWorker({
        db,
        client: new HubSpotClient({
          accessToken: 'test-token',
          baseUrl: `http://127.0.0.1:${hubspotPort}`,
          sleepMs: async () => undefined,
        }),
      }),
    );
  });

  afterAll(async () => {
    for (const w of workers) {
      await w.close().catch(() => undefined);
    }
    workers = [];
    try {
      await killAll(db);
    } catch {
      /* best effort */
    }
    __resetAgentRegistryForTests();
    __resetSalesAgentRegistrationForTests();
    __resetChannelsForTests();
    // Drain any leftover BullMQ keys to keep the test redis tidy across
    // repeated runs.
    try {
      const cleaner = new Redis(process.env['TEST_REDIS_URL']!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      const keys = await cleaner.keys(`${prefix}:*`);
      if (keys.length > 0) await cleaner.del(...keys);
      await cleaner.quit();
    } catch {
      /* ignore */
    }
    await shutdownQueues().catch(() => undefined);
    __resetForTests();
    await new Promise<void>((r) => hubspotServer.close(() => r()));

    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
    if (savedPrefix === undefined) delete process.env.BULLMQ_PREFIX;
    else process.env.BULLMQ_PREFIX = savedPrefix;
  });

  beforeEach(async () => {
    // Clean state — even though it's a single test today, we keep this
    // explicit so a future second `it()` lands on a fresh DB.
    hubspotCalls = [];
    stubChannel.sent = [];
    await db.execute(sql`
        TRUNCATE customer_facts, conversation_turns, agent_messages,
                 human_actions, maxance_actions, quotes, leads, customers,
                 agents_state CASCADE
      `);
  });

  it('full pipeline: website lead → live scorer → live sales welcome → stubbed WAHA reply → live sales response', async () => {
    const hmacSecret = randomBytes(32).toString('hex');
    const app = buildApp({ db, leadIntakeHmacSecret: hmacSecret });

    // ---------------------------------------------------------------
    // Step 1 — POST /v1/leads with HMAC.
    // ---------------------------------------------------------------
    // Minimal form answers. We intentionally avoid `brand`/`model`/
    // `budget` fields here: the scorer is LIVE Haiku and tends to splice
    // those into its opener, which then trips the Compliance Sentry
    // (also LIVE Haiku) for "advertising a price without a Maxance quote"
    // or "echoing sensitive product details". Both are real compliance
    // wins, but they make the e2e test non-deterministic. The leaner
    // form keeps the scorer's opener generic and lets the welcome land.
    const leadBody = JSON.stringify({
      source: 'website',
      productLine: 'scooter',
      fullName: 'Marie Dupont',
      email: 'marie.dupont@example.fr',
      phone: '+33612345678',
      formAnswers: {
        interest: 'devis trottinette',
      },
    });
    const leadSig = 'sha256=' + createHmac('sha256', hmacSecret).update(leadBody).digest('hex');
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-f16-signature': leadSig,
      },
      body: leadBody,
    });
    expect(res.status).toBe(200);
    const ingest = (await res.json()) as {
      leadId: string;
      customerId: string;
    };
    expect(ingest.leadId).toBeTruthy();
    expect(ingest.customerId).toBeTruthy();

    // ---------------------------------------------------------------
    // Step 2 — wait for Lead Scorer + welcome to land. The scorer
    // writes `score` + transitions to 'scored', then the Sales Agent's
    // first-turn welcome flips to 'qualifying' after sending.
    // ---------------------------------------------------------------
    await waitFor(
      async () => {
        const [lead] = await db.select().from(leads).where(eq(leads.id, ingest.leadId)).limit(1);
        return Boolean(lead && lead.score !== null && lead.status === 'qualifying');
      },
      {
        timeoutMs: 90_000,
        intervalMs: 500,
        label: 'lead.scored + welcomed',
      },
    );

    // ---------------------------------------------------------------
    // Step 3 — opener was sent on the stub WAHA channel.
    // ---------------------------------------------------------------
    expect(stubChannel.sent.length).toBeGreaterThanOrEqual(1);
    const opener = stubChannel.sent[0]!;
    expect(opener.to.address).toBe('+33612345678');
    expect(opener.body.length).toBeGreaterThan(0);
    const openerBlock = opener.body[0];
    expect(openerBlock && 'text' in openerBlock).toBe(true);
    const openerText = (openerBlock as { text: string }).text;
    expect(openerText.length).toBeGreaterThan(0);
    expect(openerText.length).toBeLessThan(1500);

    // ---------------------------------------------------------------
    // Step 4 — conversation_turns has the outbound welcome.
    // ---------------------------------------------------------------
    const turnsAfterWelcome = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, ingest.customerId));
    expect(turnsAfterWelcome.some((t) => t.direction === 'outbound')).toBe(true);

    // ---------------------------------------------------------------
    // Step 5 — HubSpot stub received the upsert + deal calls.
    // ---------------------------------------------------------------
    expect(hubspotCalls.some((c) => c.url.includes('/batch/upsert'))).toBe(true);
    expect(hubspotCalls.some((c) => c.url.endsWith('/deals'))).toBe(true);

    // ---------------------------------------------------------------
    // Step 6 — simulate a customer reply via the WAHA webhook. The
    // app is mounted WITHOUT a wahaHmacSecret so signature checks are
    // skipped — we're testing the agent pipeline, not the HMAC layer.
    //
    // We pause briefly so the WAHA-stamped second strictly exceeds the
    // welcome's `occurred_at`. WAHA emits second-precision timestamps
    // (`Math.floor(Date.now()/1000)`); without the pause the inbound
    // can floor to the SAME second as the welcome and beat it on
    // sub-second ordering — a real customer reply is never that fast.
    // ---------------------------------------------------------------
    await new Promise((r) => setTimeout(r, 1100));
    const wahaBody = JSON.stringify({
      event: 'message',
      session: 'default',
      payload: {
        id: 'wamid.test1',
        timestamp: Math.floor(Date.now() / 1000),
        from: '33612345678@c.us',
        fromMe: false,
        body: 'Oui je veux un devis pour ma trottinette électrique.',
        hasMedia: false,
        type: 'chat',
      },
    });
    const wahaRes = await app.request('/webhooks/waha', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: wahaBody,
    });
    expect(wahaRes.status).toBe(200);

    // ---------------------------------------------------------------
    // Step 7 — wait for Sales Agent to respond (LIVE Sonnet +
    // compliance Haiku).
    // ---------------------------------------------------------------
    await waitFor(async () => stubChannel.sent.length >= 2, {
      timeoutMs: 120_000,
      intervalMs: 500,
      label: 'sales agent reply',
    });

    // ---------------------------------------------------------------
    // Step 8 — assertions on the reply.
    // ---------------------------------------------------------------
    const replyMsg = stubChannel.sent[1]!;
    const replyBlock = replyMsg.body[0];
    expect(replyBlock && 'text' in replyBlock).toBe(true);
    const replyText = (replyBlock as { text: string }).text;
    expect(replyText.length).toBeGreaterThan(0);
    expect(replyText.length).toBeLessThan(1500);
    // Loose "in French" heuristic — any latin/French letter.
    expect(replyText).toMatch(/[a-zA-Zàâçéèêëîïôûùüÿ]/);

    // ---------------------------------------------------------------
    // Step 9 — turn count + ordering. Welcome out → customer in →
    // sales reply out.
    // ---------------------------------------------------------------
    const allTurns = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, ingest.customerId));
    expect(allTurns.length).toBeGreaterThanOrEqual(3);
    const directions = allTurns
      .slice()
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map((t) => t.direction);
    expect(directions[0]).toBe('outbound');
    expect(directions[1]).toBe('inbound');
    expect(directions[2]).toBe('outbound');

    // ---------------------------------------------------------------
    // Step 10 — Sales Agent instance is registered + agents_state row
    // reflects 'running'.
    // ---------------------------------------------------------------
    const running = listRunning();
    expect(
      running.some((r) => r.role === 'sales-agent' && r.instanceId === `lead-${ingest.leadId}`),
    ).toBe(true);
    const [stateRow] = await db
      .select()
      .from(agentsState)
      .where(eq(agentsState.role, 'sales-agent'));
    expect(stateRow?.status).toBe('running');
  }, // 3-minute timeout for the whole pipeline. Live Claude is the long
  // tail — Haiku scorer + Haiku compliance × 2 + Sonnet reply.
  180_000);
});
