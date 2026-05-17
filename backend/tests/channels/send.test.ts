/**
 * `sendViaChannel` integration tests (M4.T7).
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY — these tests exercise the
 * real Drizzle insert path against a live pgvector + pgcrypto database.
 *
 * Spin up the same containers used by the rest of the channels suite:
 *
 *   docker run -d --name f16-pg-m4t7 -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 \
 *     -e POSTGRES_DB=f16 -p 5435:5432 pgvector/pgvector:pg16
 *   docker exec -i f16-pg-m4t7 psql -U f16 -d f16 \
 *     -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
 *   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 pnpm exec drizzle-kit migrate
 *   TEST_DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16 \
 *     PII_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm test
 *
 * Each test registers a fresh `StubChannel` so we exercise the wrapper's
 * adapter-resolution path without booting any provider.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq, desc } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { conversationTurns } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { listTurns } from '../../src/db/repositories/conversation-turns.js';
import { registerChannel, __resetChannelsForTests } from '../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelId,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../src/channels/types.js';
import { sendViaChannel } from '../../src/channels/send.js';

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

/**
 * Stub channel that captures every send for later assertion. Returns a
 * predictable `DeliveryReceipt` so tests can verify the wrapper plumbs it
 * back to the caller untouched.
 */
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
      acceptedAt: new Date('2026-05-17T12:00:00.000Z'),
      raw: { stub: true },
    };
  }
}

/** Stub channel that always throws — used to prove no audit row is written on send failure. */
class FailingChannel implements ConversationChannel {
  readonly id: ChannelId;
  constructor(id: ChannelId) {
    this.id = id;
  }
  capabilities(): ChannelCapabilities {
    return { interactive: false, voice: false, attachments: false, markdown: false };
  }
  async send(): Promise<DeliveryReceipt> {
    throw new Error('boom: provider unavailable');
  }
}

d('sendViaChannel (live)', () => {
  let db: Database;
  let customerId: string;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    // CASCADE through conversation_turns + leads.
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);

    // Register-from-empty for each test so the wrapper's getChannel() picks
    // up a fresh stub. No cross-test bleed.
    __resetChannelsForTests();

    // Seed a customer the audit rows can reference.
    const c = await insertCustomer(db, {
      fullName: 'Test Customer',
      phone: '+33612345678',
    });
    customerId = c.id;
  });

  // -------------------------------------------------------------------------
  // 1. Plain text outbound -> row exists with direction='outbound'
  // -------------------------------------------------------------------------
  it('test 1 (text outbound): writes a conversation_turns row matching the send', async () => {
    const wa = new StubChannel('whatsapp');
    registerChannel(wa);

    const result = await sendViaChannel({
      db,
      customerId,
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [{ type: 'text', text: 'Bonjour Marie' }],
    });

    expect(result.receipt.externalId).toBe('stub-whatsapp-1');
    expect(result.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(wa.sends).toHaveLength(1);

    const [row] = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, result.turnId));
    expect(row).toBeDefined();
    expect(row!.direction).toBe('outbound');
    expect(row!.channel).toBe('whatsapp');
    expect(row!.customerId).toBe(customerId);
    expect(row!.content).toBe('Bonjour Marie');
    expect(row!.attachments).toBeNull();
    expect(row!.agentRole).toBeNull();
    expect(row!.agentInstance).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Mixed body -> derived content + attachments[]
  // -------------------------------------------------------------------------
  it('test 2 (mixed body): derives content + attachments from blocks', async () => {
    const wa = new StubChannel('whatsapp');
    registerChannel(wa);

    const result = await sendViaChannel({
      db,
      customerId,
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [
        { type: 'text', text: 'Voici votre devis' },
        { type: 'image', url: 'https://cdn.example.com/x.jpg', caption: 'page 1', sha256: 'aaa' },
        {
          type: 'document',
          url: 'https://cdn.example.com/devis.pdf',
          filename: 'devis.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });

    const [row] = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, result.turnId));
    expect(row!.content).toBe('Voici votre devis\n[image: page 1]\n[document: devis.pdf]');
    expect(row!.attachments).toHaveLength(2);
    expect(row!.attachments![0]).toEqual({
      url: 'https://cdn.example.com/x.jpg',
      type: 'image',
      sha256: 'aaa',
    });
    expect(row!.attachments![1]).toEqual({
      url: 'https://cdn.example.com/devis.pdf',
      type: 'document',
    });
  });

  // -------------------------------------------------------------------------
  // 3. Agent attribution plumbed into the row
  // -------------------------------------------------------------------------
  it('test 3 (agent attribution): agentRole + agentInstance flow into the row', async () => {
    const wa = new StubChannel('whatsapp');
    registerChannel(wa);

    const result = await sendViaChannel({
      db,
      customerId,
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [{ type: 'text', text: 'hello' }],
      agentRole: 'sales-agent',
      agentInstance: 'sales-agent#42',
    });

    const [row] = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, result.turnId));
    expect(row!.agentRole).toBe('sales-agent');
    expect(row!.agentInstance).toBe('sales-agent#42');

    // And the adapter saw the same attribution (so adapters can use it for
    // provider-side audit headers too).
    expect(wa.sends[0]!.agentRole).toBe('sales-agent');
    expect(wa.sends[0]!.agentInstance).toBe('sales-agent#42');
  });

  // -------------------------------------------------------------------------
  // 4. leadId optional — present + absent
  // -------------------------------------------------------------------------
  it('test 4 (leadId optional): when omitted, row.leadId is null', async () => {
    const wa = new StubChannel('whatsapp');
    registerChannel(wa);

    const result = await sendViaChannel({
      db,
      customerId,
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [{ type: 'text', text: 'hi' }],
    });

    const [row] = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, result.turnId));
    expect(row!.leadId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. Channel send fails -> NO row written, error propagates
  // -------------------------------------------------------------------------
  it('test 5 (send failure): channel throw -> no conversation_turns row', async () => {
    registerChannel(new FailingChannel('whatsapp'));

    await expect(
      sendViaChannel({
        db,
        customerId,
        to: { channel: 'whatsapp', address: '+33612345678' },
        body: [{ type: 'text', text: 'never sent' }],
      }),
    ).rejects.toThrow(/boom: provider unavailable/);

    const rows = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, customerId));
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. listTurns orders desc by occurredAt
  // -------------------------------------------------------------------------
  it('test 6 (listTurns ordering): returns rows desc by occurredAt', async () => {
    const wa = new StubChannel('whatsapp');
    registerChannel(wa);

    // Three sends with distinct timestamps so ordering is deterministic.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await db.insert(conversationTurns).values({
        customerId,
        channel: 'whatsapp',
        direction: 'outbound',
        content: `msg ${i}`,
        occurredAt: new Date(now + i * 60_000),
      });
    }

    const turns = await listTurns(db, { customerId });
    expect(turns).toHaveLength(3);
    expect(turns[0]!.content).toBe('msg 2');
    expect(turns[1]!.content).toBe('msg 1');
    expect(turns[2]!.content).toBe('msg 0');

    // Sanity: direct query agrees.
    const direct = await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.customerId, customerId))
      .orderBy(desc(conversationTurns.occurredAt));
    expect(direct.map((r) => r.content)).toEqual(['msg 2', 'msg 1', 'msg 0']);
  });

  // -------------------------------------------------------------------------
  // 7. listTurns filters by channel
  // -------------------------------------------------------------------------
  it('test 7 (listTurns channel filter): only returns matching channel', async () => {
    await db.insert(conversationTurns).values([
      {
        customerId,
        channel: 'whatsapp',
        direction: 'outbound',
        content: 'wa 1',
      },
      {
        customerId,
        channel: 'whatsapp',
        direction: 'inbound',
        content: 'wa 2',
      },
      {
        customerId,
        channel: 'email',
        direction: 'outbound',
        content: 'em 1',
      },
    ]);

    const wa = await listTurns(db, { customerId, channel: 'whatsapp' });
    expect(wa).toHaveLength(2);
    expect(new Set(wa.map((t) => t.content))).toEqual(new Set(['wa 1', 'wa 2']));

    const em = await listTurns(db, { customerId, channel: 'email' });
    expect(em).toHaveLength(1);
    expect(em[0]!.content).toBe('em 1');
  });
});
