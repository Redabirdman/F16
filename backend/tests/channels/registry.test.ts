/**
 * Unit tests for the channel registry (M4.T1). No infra required.
 *
 * We import the registry module DIRECTLY (not through the barrel) so that
 * future side-effecting adapter registrations don't bleed into these tests.
 * Each test starts from a clean registry via `__resetChannelsForTests()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerChannel,
  getChannel,
  tryGetChannel,
  listChannels,
  __resetChannelsForTests,
} from '../../src/channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelId,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../../src/channels/types.js';

/**
 * Minimal channel fixture that implements the full `ConversationChannel`
 * contract. Used both to populate the registry and to prove the interface is
 * implementable end-to-end (capabilities + send).
 */
class StubChannel implements ConversationChannel {
  readonly id: ChannelId;
  private _sendCount = 0;

  constructor(id: ChannelId = 'whatsapp') {
    this.id = id;
  }

  capabilities(): ChannelCapabilities {
    return {
      interactive: true,
      voice: false,
      attachments: true,
      markdown: true,
    };
  }

  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    // Channel/contact mismatch is a programmer bug — fail loudly.
    if (opts.to.channel !== this.id) {
      throw new Error(`StubChannel(${this.id}) received contact for channel ${opts.to.channel}`);
    }
    this._sendCount += 1;
    return {
      channel: this.id,
      externalId: `stub-${this.id}-${this._sendCount}-${opts.to.address}`,
      acceptedAt: new Date('2026-05-17T12:00:00.000Z'),
      raw: { stub: true, blocks: opts.body.length },
    };
  }
}

beforeEach(() => {
  __resetChannelsForTests();
});

describe('channel registry', () => {
  it('test 1 (empty miss): getChannel throws when no channel is registered', () => {
    expect(() => getChannel('whatsapp')).toThrow(/No channel registered/);
  });

  it('test 2 (register + get): roundtrips a registered channel by id', () => {
    const stub = new StubChannel('whatsapp');
    registerChannel(stub);

    const found = getChannel('whatsapp');
    expect(found).toBe(stub);
    expect(found.id).toBe('whatsapp');
  });

  it('test 3 (duplicate): registerChannel throws on duplicate id', () => {
    registerChannel(new StubChannel('whatsapp'));
    expect(() => registerChannel(new StubChannel('whatsapp'))).toThrow(/already registered/);
  });

  it('test 4 (listChannels): returns all registered channels (order-insensitive)', () => {
    const wa = new StubChannel('whatsapp');
    const em = new StubChannel('email');
    const sm = new StubChannel('sms');
    registerChannel(wa);
    registerChannel(em);
    registerChannel(sm);

    const all = listChannels();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((c) => c.id))).toEqual(new Set<ChannelId>(['whatsapp', 'email', 'sms']));
  });

  it('test 5 (tryGetChannel miss): returns undefined for unknown id (does not throw)', () => {
    expect(tryGetChannel('voice')).toBeUndefined();
    registerChannel(new StubChannel('whatsapp'));
    expect(tryGetChannel('voice')).toBeUndefined();
    expect(tryGetChannel('whatsapp')).toBeDefined();
  });

  it('test 6 (reset): __resetChannelsForTests clears the registry', () => {
    registerChannel(new StubChannel('whatsapp'));
    expect(listChannels()).toHaveLength(1);

    __resetChannelsForTests();
    expect(listChannels()).toHaveLength(0);
    expect(() => getChannel('whatsapp')).toThrow(/No channel registered/);
  });

  it('test 7 (interface implementability): StubChannel.capabilities() + send() exercise the full contract', async () => {
    const stub = new StubChannel('whatsapp');
    registerChannel(stub);

    const caps = getChannel('whatsapp').capabilities();
    expect(caps).toEqual({
      interactive: true,
      voice: false,
      attachments: true,
      markdown: true,
    });

    const receipt = await getChannel('whatsapp').send({
      to: { channel: 'whatsapp', address: '+33612345678', displayName: 'Marie' },
      body: [
        { type: 'text', text: 'Bonjour Marie' },
        { type: 'markdown', text: '**Devis** prêt' },
      ],
      correlationId: 'lead-42',
      agentRole: 'sales-agent',
      agentInstance: 'sales-agent#abc',
    });

    expect(receipt.channel).toBe('whatsapp');
    expect(receipt.externalId).toBe('stub-whatsapp-1-+33612345678');
    expect(receipt.acceptedAt).toBeInstanceOf(Date);
    expect(receipt.raw).toEqual({ stub: true, blocks: 2 });

    // Channel/contact mismatch is rejected.
    await expect(
      stub.send({
        to: { channel: 'email', address: 'marie@example.fr' },
        body: [{ type: 'text', text: 'oops' }],
      }),
    ).rejects.toThrow(/received contact for channel email/);
  });
});
