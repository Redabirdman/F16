/**
 * handleTimedFollowup unit tests (2026-07-08) — LLM + channel send mocked.
 *
 * Pins the three behaviours that make the self-wake safe:
 *   1. a normal reply is SENT to the customer's last inbound channel,
 *   2. the __NO_FOLLOWUP__ sentinel sends NOTHING (follow-up judged moot),
 *   3. a non-'timed-followup' cascade is ignored (engagement traffic).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateSalesReplyMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../../src/agents/sales-agent/reply-core.js', () => ({
  generateSalesReply: (...args: unknown[]) => generateSalesReplyMock(...args),
}));

const sendViaChannelMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../../src/channels/send.js', () => ({
  sendViaChannel: (...args: unknown[]) => sendViaChannelMock(...args),
}));

vi.mock('../../../src/db/repositories/conversation-turns.js', () => ({
  listTurns: () => Promise.resolve([{ direction: 'inbound', channel: 'whatsapp' }]),
}));
vi.mock('../../../src/channels/registry.js', () => ({
  preferInboundChannel: () => 'whatsapp',
}));

import {
  handleTimedFollowup,
  NO_FOLLOWUP,
} from '../../../src/agents/sales-agent/handlers/followup.js';
import type { SalesHandlerCtx } from '../../../src/agents/sales-agent/handlers/context.js';
import type { AgentMessageEnvelope } from '../../../src/messaging/dispatcher.js';

const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

function ctx(): SalesHandlerCtx {
  return {
    db: {} as SalesHandlerCtx['db'],
    role: 'sales-agent',
    instanceId: 'test',
    resolveCustomerAndContact: vi.fn().mockResolvedValue({
      customer: { id: CUSTOMER_ID },
      lead: { id: LEAD_ID },
      contactRef: { channel: 'whatsapp', address: '+33611111111' },
    }) as unknown as SalesHandlerCtx['resolveCustomerAndContact'],
    leadIdFromEnvelope: () => LEAD_ID,
  };
}

function envelope(payload: Record<string, unknown>): AgentMessageEnvelope {
  return {
    id: 'env-1',
    intent: 'CUSTOMER.FOLLOWUP_DUE',
    toRole: 'sales-agent',
    toInstance: null,
    correlationId: LEAD_ID,
    payload,
  } as unknown as AgentMessageEnvelope;
}

beforeEach(() => {
  generateSalesReplyMock.mockReset();
  sendViaChannelMock.mockReset().mockResolvedValue(undefined);
});

describe('handleTimedFollowup', () => {
  it('sends the resumed-conversation message on the inbound channel', async () => {
    generateSalesReplyMock.mockResolvedValue({
      outcome: 'reply',
      replyText: 'Me revoilà, Achraf ! Reprenons : combien avez-vous payé votre trottinette ?',
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      toolsInvoked: [],
    });
    const res = await handleTimedFollowup(
      ctx(),
      envelope({
        customerId: CUSTOMER_ID,
        cascadeName: 'timed-followup',
        stepIndex: 0,
        leadId: LEAD_ID,
        topic: 'reprendre la qualification',
      }),
    );
    expect(res.ok).toBe(true);
    expect(sendViaChannelMock).toHaveBeenCalledTimes(1);
    const arg = sendViaChannelMock.mock.calls[0]![0] as {
      body: Array<{ text: string }>;
    };
    expect(arg.body[0]!.text).toContain('Me revoilà');
    // The internal system prompt reached the LLM, not the customer text.
    const llmArg = generateSalesReplyMock.mock.calls[0]![0] as { content: string };
    expect(llmArg.content).toContain('RELANCE PROGRAMMÉE');
    expect(llmArg.content).toContain('reprendre la qualification');
  });

  it(`sends nothing when the LLM answers the ${NO_FOLLOWUP} sentinel`, async () => {
    generateSalesReplyMock.mockResolvedValue({
      outcome: 'reply',
      replyText: NO_FOLLOWUP,
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      toolsInvoked: [],
    });
    const res = await handleTimedFollowup(
      ctx(),
      envelope({
        customerId: CUSTOMER_ID,
        cascadeName: 'timed-followup',
        stepIndex: 0,
        leadId: LEAD_ID,
      }),
    );
    expect(res.ok).toBe(true);
    expect((res as unknown as { result: { skipped: string } }).result.skipped).toBe('moot');
    expect(sendViaChannelMock).not.toHaveBeenCalled();
  });

  it('ignores non timed-followup cascades', async () => {
    const res = await handleTimedFollowup(
      ctx(),
      envelope({ customerId: CUSTOMER_ID, cascadeName: 'engagement-24h', stepIndex: 1 }),
    );
    expect(res.ok).toBe(true);
    expect(generateSalesReplyMock).not.toHaveBeenCalled();
    expect(sendViaChannelMock).not.toHaveBeenCalled();
  });
});
