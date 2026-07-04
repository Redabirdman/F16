/**
 * Follow-through watchdog — DB-backed unit tests.
 *
 * Same shape as the engagement-agent suite: live pg, stub WhatsApp channel,
 * no LLM (the watchdog is deterministic). We drive ticks via the handle's
 * `tickOnce()` seam (ticks are promise-chained, so the boot tick and an
 * explicit tickOnce never race the idempotency guards).
 *
 * Covers: CHECK A fires (QUOTE_STUCK + one apology, at-most-once), A skips
 * on the price-menu marker / an existing QUOTE_FAILED action; CHECK B
 * re-emits DEVIS.PDF_RECEIVED when the PDF is on disk, escalates
 * DEVIS_RELAY_STUCK when it's missing, and skips on the Réf marker.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import {
  agentMessages,
  conversationTurns,
  humanActions,
  leads,
  quotes,
} from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { createAction } from '../../../src/db/repositories/human-actions.js';
import { registerChannel, __resetChannelsForTests } from '../../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelId,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../../src/channels/types.js';
import {
  startFollowthroughWatchdog,
  type FollowthroughWatchdogHandle,
} from '../../../src/agents/followthrough/watchdog.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

class StubChannel implements ConversationChannel {
  readonly id: ChannelId;
  readonly sends: SendOptions[] = [];
  private _seq = 0;
  constructor(id: ChannelId) {
    this.id = id;
  }
  capabilities(): ChannelCapabilities {
    return { interactive: true, voice: false, attachments: true, markdown: true };
  }
  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    this.sends.push(opts);
    this._seq += 1;
    return {
      channel: this.id,
      externalId: `stub-${this.id}-${this._seq}`,
      acceptedAt: new Date('2026-07-04T12:00:00.000Z'),
      raw: { stub: true },
    };
  }
}

d('followthrough watchdog', () => {
  let db: Database;
  let wa: StubChannel;
  let devisDir: string;
  let watchdog: FollowthroughWatchdogHandle | null = null;
  let seedSeq = 0;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE quotes RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE agent_messages RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);

    __resetChannelsForTests();
    wa = new StubChannel('whatsapp');
    registerChannel(wa);

    devisDir = await mkdtemp(join(tmpdir(), 'f16-devis-'));
  });

  afterEach(async () => {
    watchdog?.stop();
    watchdog = null;
    __resetChannelsForTests();
    await rm(devisDir, { recursive: true, force: true });
  });

  /** Seed customer + lead + one quote row. Minutes are relative to now. */
  async function seedQuote(opts: {
    status: 'requested' | 'ready';
    requestedMinAgo?: number;
    readyMinAgo?: number;
    devisNumber?: string;
  }): Promise<{ quoteId: string; leadId: string; customerId: string }> {
    // phone_hash is UNIQUE — each seeded customer needs a distinct number.
    const suffix = String(seedSeq++).padStart(2, '0');
    const cust = await insertCustomer(db, {
      fullName: 'Marie Test',
      phone: `+336111111${suffix}`,
      email: `marie.test.${suffix}@example.com`,
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: cust.id,
        source: 'website',
        productLine: 'scooter',
        status: 'quoting',
        score: 80,
      })
      .returning();
    const now = Date.now();
    const [quote] = await db
      .insert(quotes)
      .values({
        customerId: cust.id,
        leadId: lead!.id,
        product: 'scooter',
        productVariant: 'standard',
        status: opts.status,
        sessionId: `sess-${randomUUID()}`,
        requestedAt: new Date(now - (opts.requestedMinAgo ?? 30) * 60_000),
        ...(opts.readyMinAgo !== undefined
          ? { readyAt: new Date(now - opts.readyMinAgo * 60_000) }
          : {}),
        ...(opts.devisNumber ? { maxanceDevisNumber: opts.devisNumber } : {}),
      })
      .returning();
    return { quoteId: quote!.id, leadId: lead!.id, customerId: cust.id };
  }

  function start(): FollowthroughWatchdogHandle {
    // Huge interval — only the boot tick + explicit tickOnce calls run.
    watchdog = startFollowthroughWatchdog({
      db,
      intervalMs: 3_600_000,
      previewStuckMin: 8,
      deliveryStuckMin: 15,
      devisDir,
    });
    return watchdog;
  }

  it('CHECK A fires: creates QUOTE_STUCK + notifies + apologizes at most once', async () => {
    const { quoteId, customerId } = await seedQuote({ status: 'requested', requestedMinAgo: 30 });

    const handle = start();
    await handle.tickOnce();

    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.intent).toBe('QUOTE_STUCK');
    expect(actions[0]?.correlationId).toBe(quoteId);
    expect(actions[0]?.severity).toBe(2);
    expect(actions[0]?.summary).toContain('Devis en préparation');
    expect(actions[0]?.createdByAgent).toBe('followthrough-watchdog#singleton');

    // WA-group notification emitted.
    const msgs = await db.select().from(agentMessages);
    const requested = msgs.find(
      (m) => m.intent === 'HUMAN_ACTION.REQUESTED' && m.toRole === 'human-router',
    );
    expect(requested).toBeDefined();
    expect(requested?.correlationId).toBe(quoteId);

    // One apologetic customer message, on the stub WhatsApp channel.
    expect(wa.sends).toHaveLength(1);
    const body = wa.sends[0]?.body[0];
    expect(body?.type).toBe('text');
    expect((body as { type: 'text'; text: string }).text).toContain(
      'prend un peu plus de temps que prévu',
    );

    // Outbound turn logged with the watchdog attribution.
    const turns = await db.select().from(conversationTurns);
    const apologyTurn = turns.find((t) => t.agentRole === 'followthrough-watchdog');
    expect(apologyTurn).toBeDefined();
    expect(apologyTurn?.customerId).toBe(customerId);

    // At-most-once: a second tick sees the QUOTE_STUCK row and skips.
    await handle.tickOnce();
    expect(await db.select().from(humanActions)).toHaveLength(1);
    expect(wa.sends).toHaveLength(1);
  });

  it('CHECK A skips when the price-menu marker turn is present', async () => {
    const { quoteId, leadId, customerId } = await seedQuote({
      status: 'requested',
      requestedMinAgo: 30,
    });
    // The PREVIEW_READY price menu embeds `#<quoteId8>` — its presence means
    // the customer DID get the menu (only the price persist failed).
    await db.insert(conversationTurns).values({
      customerId,
      leadId,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      agentInstance: 'singleton',
      content: `Voici vos tarifs (réf #${quoteId.slice(0, 8)})`,
      occurredAt: new Date(),
    });

    await start().tickOnce();

    expect(await db.select().from(humanActions)).toHaveLength(0);
    expect(wa.sends).toHaveLength(0);
  });

  it('CHECK A skips when a QUOTE_FAILED action already exists', async () => {
    const { quoteId } = await seedQuote({ status: 'requested', requestedMinAgo: 30 });
    await createAction(db, {
      createdByAgent: 'sales-agent#singleton',
      correlationId: quoteId,
      intent: 'QUOTE_FAILED',
      severity: 2,
      summary: 'Quote failed earlier',
      options: [{ id: 'retry', label: 'Relancer', kind: 'approve' }],
    });

    await start().tickOnce();

    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(1); // only the pre-existing QUOTE_FAILED
    expect(actions[0]?.intent).toBe('QUOTE_FAILED');
    expect(wa.sends).toHaveLength(0);
  });

  it('CHECK B re-emits DEVIS.PDF_RECEIVED when the PDF is on disk', async () => {
    const devisNumber = 'DR0000999901';
    const { quoteId } = await seedQuote({
      status: 'ready',
      requestedMinAgo: 60,
      readyMinAgo: 30,
      devisNumber,
    });
    await writeFile(join(devisDir, `${devisNumber}.pdf`), '%PDF-1.4 stub');

    await start().tickOnce();

    const msgs = await db.select().from(agentMessages);
    const reemit = msgs.find((m) => m.intent === 'DEVIS.PDF_RECEIVED');
    expect(reemit).toBeDefined();
    expect(reemit?.toRole).toBe('sales-agent');
    expect(reemit?.fromRole).toBe('followthrough-watchdog');
    expect(reemit?.correlationId).toBe(quoteId);
    const payload = reemit?.payload as { devisNumber: string; pdfPath: string; filename: string };
    expect(payload.devisNumber).toBe(devisNumber);
    expect(payload.filename).toBe(`${devisNumber}.pdf`);
    expect(isAbsolute(payload.pdfPath)).toBe(true);

    // No escalation on the self-heal path.
    expect(await db.select().from(humanActions)).toHaveLength(0);
    expect(wa.sends).toHaveLength(0);
  });

  it('CHECK B creates DEVIS_RELAY_STUCK when the PDF is missing', async () => {
    const devisNumber = 'DR0000999902';
    const { quoteId } = await seedQuote({
      status: 'ready',
      requestedMinAgo: 60,
      readyMinAgo: 30,
      devisNumber,
    });

    await start().tickOnce();

    const actions = await db.select().from(humanActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.intent).toBe('DEVIS_RELAY_STUCK');
    expect(actions[0]?.correlationId).toBe(quoteId);
    expect(actions[0]?.summary).toContain(devisNumber);
    expect(actions[0]?.summary).toContain('jamais arriv');

    const msgs = await db.select().from(agentMessages);
    expect(msgs.some((m) => m.intent === 'HUMAN_ACTION.REQUESTED')).toBe(true);
    expect(msgs.some((m) => m.intent === 'DEVIS.PDF_RECEIVED')).toBe(false);

    // Idempotent: second tick sees the DEVIS_RELAY_STUCK row and skips.
    await watchdog!.tickOnce();
    expect(await db.select().from(humanActions)).toHaveLength(1);
  });

  it('CHECK B skips when the Réf-delivery marker turn is present', async () => {
    const devisNumber = 'DR0000999903';
    const { leadId, customerId } = await seedQuote({
      status: 'ready',
      requestedMinAgo: 60,
      readyMinAgo: 30,
      devisNumber,
    });
    await db.insert(conversationTurns).values({
      customerId,
      leadId,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      agentInstance: 'singleton',
      content: `Voici votre devis Assuryal en pièce jointe (Réf. ${devisNumber}).`,
      occurredAt: new Date(),
    });

    await start().tickOnce();

    expect(await db.select().from(humanActions)).toHaveLength(0);
    const msgs = await db.select().from(agentMessages);
    expect(msgs.some((m) => m.intent === 'DEVIS.PDF_RECEIVED')).toBe(false);
    expect(wa.sends).toHaveLength(0);
  });

  it('leaves fresh quotes alone (thresholds not reached)', async () => {
    await seedQuote({ status: 'requested', requestedMinAgo: 2 });
    await seedQuote({
      status: 'ready',
      requestedMinAgo: 20,
      readyMinAgo: 5,
      devisNumber: 'DR0000999904',
    });

    await start().tickOnce();

    expect(await db.select().from(humanActions)).toHaveLength(0);
    expect(await db.select().from(agentMessages)).toHaveLength(0);
    expect(wa.sends).toHaveLength(0);
  });
});
