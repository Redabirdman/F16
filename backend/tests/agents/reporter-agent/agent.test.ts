/**
 * Unit tests for the ReporterAgent class (option G).
 *
 * Strategy:
 *   - Mock the `human-actions` repository so the test doesn't need Postgres.
 *   - Stub the WahaClient by satisfying the `sendText` surface only.
 *   - Drive the agent's protected `onMessage` via a test subclass.
 *
 * Verifies:
 *   - REQUESTED: row is loaded → formatter runs → WAHA.sendText is called
 *     with the right chat id and text containing the action id.
 *   - REQUESTED + missing row: returns {ok:false, error:'row_not_found'}
 *     and does NOT call sendText.
 *   - RESOLVED: formatter runs → sendText with the closure message.
 *   - Unhandled intent: returns the standard skipped envelope.
 *   - WAHA send failure: surfaces an {ok:false, error} envelope.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReporterAgent } from '../../../src/agents/reporter-agent/agent.js';
import type { WahaClient } from '../../../src/channels/whatsapp/waha-client.js';
import type { HumanAction } from '../../../src/db/schema/agent-runtime.js';
import type { Database } from '../../../src/db/index.js';
import type { AgentMessageEnvelope } from '../../../src/messaging/dispatcher.js';

// Hoist the mock so the repo import inside agent.ts picks it up.
vi.mock('../../../src/db/repositories/human-actions.js', () => ({
  getActionById: vi.fn(),
}));

// Re-import the mocked symbol so tests can assert on it.
const { getActionById } = await import('../../../src/db/repositories/human-actions.js');
const mockedGetActionById = vi.mocked(getActionById);

const GROUP_CHAT_ID = '120363012345678901@g.us';

const sampleAction: HumanAction = {
  id: '22222222-2222-4222-8222-222222222222',
  createdByAgent: 'sales-agent#lead-1234',
  intent: 'APPROVE_REFUND',
  severity: 2,
  summary: 'Le client demande un remboursement complet de 49 €.',
  options: [
    { id: 'approve', label: 'Approuver', kind: 'approve' },
    { id: 'reject', label: 'Refuser', kind: 'reject' },
  ],
  correlationId: 'lead-1234',
  status: 'pending',
  dueAt: null,
  resolvedBy: null,
  resolvedSource: null,
  resolution: null,
  createdAt: new Date('2026-05-24T08:00:00Z'),
  resolvedAt: null,
  escalatedAt: null,
};

/** Minimal WAHA stub — records every sendText call. */
function buildFakeWaha(): WahaClient & { sent: Array<{ chatId: string; text: string }> } {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    sendText: vi.fn(async (input: { chatId: string; text: string }) => {
      sent.push({ chatId: input.chatId, text: input.text });
      return { id: { _serialized: 'm1' } } as unknown as Awaited<
        ReturnType<WahaClient['sendText']>
      >;
    }),
  } as unknown as WahaClient & { sent: Array<{ chatId: string; text: string }> };
}

/** Test subclass that exposes the protected `onMessage` for direct invocation. */
class TestableReporter extends ReporterAgent {
  public callOnMessage(envelope: AgentMessageEnvelope): Promise<unknown> {
    return (
      this as unknown as { onMessage: (e: AgentMessageEnvelope) => Promise<unknown> }
    ).onMessage(envelope);
  }
}

function newAgent(deps: { waha: WahaClient }): TestableReporter {
  return new TestableReporter(
    {
      role: 'human-router',
      instanceId: 'test',
      model: 'haiku',
      queues: ['human_action'],
      db: {} as unknown as Database,
    },
    { waha: deps.waha, groupChatId: GROUP_CHAT_ID },
  );
}

function buildEnvelope(intent: string, payload: Record<string, unknown>): AgentMessageEnvelope {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    fromRole: 'sales-agent',
    fromInstance: 'lead-1234',
    toRole: 'human-router',
    toInstance: 'singleton',
    intent,
    payload,
    correlationId: 'lead-1234',
    priority: 3,
    createdAt: new Date(),
    requiresHuman: true,
  } as unknown as AgentMessageEnvelope;
}

beforeEach(() => {
  mockedGetActionById.mockReset();
});

describe('ReporterAgent — HUMAN_ACTION.REQUESTED', () => {
  it('loads the row, sends a formatted request to the group chat, returns ok', async () => {
    mockedGetActionById.mockResolvedValueOnce(sampleAction);
    const waha = buildFakeWaha();
    const agent = newAgent({ waha });

    const result = await agent.callOnMessage(
      buildEnvelope('HUMAN_ACTION.REQUESTED', { humanActionId: sampleAction.id }),
    );

    expect(result).toEqual({ ok: true, result: { posted: true, humanActionId: sampleAction.id } });
    expect(waha.sent).toHaveLength(1);
    expect(waha.sent[0]?.chatId).toBe(GROUP_CHAT_ID);
    expect(waha.sent[0]?.text).toContain('APPROVE_REFUND');
    expect(waha.sent[0]?.text).toContain('🟡');
    expect(waha.sent[0]?.text).toContain('1. Approuver');
    expect(waha.sent[0]?.text).toContain(`ID : ${sampleAction.id}`);
  });

  it("returns row_not_found and skips sendText when the action doesn't exist", async () => {
    mockedGetActionById.mockResolvedValueOnce(null);
    const waha = buildFakeWaha();
    const agent = newAgent({ waha });

    const result = await agent.callOnMessage(
      buildEnvelope('HUMAN_ACTION.REQUESTED', { humanActionId: sampleAction.id }),
    );

    expect(result).toEqual({ ok: false, error: 'row_not_found' });
    expect(waha.sent).toHaveLength(0);
  });

  it('surfaces a WAHA send failure as an error envelope', async () => {
    mockedGetActionById.mockResolvedValueOnce(sampleAction);
    const waha = buildFakeWaha();
    vi.mocked(waha.sendText).mockRejectedValueOnce(new Error('waha_5xx_boom'));
    const agent = newAgent({ waha });

    const result = (await agent.callOnMessage(
      buildEnvelope('HUMAN_ACTION.REQUESTED', { humanActionId: sampleAction.id }),
    )) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('waha_5xx_boom');
  });
});

describe('ReporterAgent — HUMAN_ACTION.RESOLVED', () => {
  it('posts a closure message in the group with the chosen option', async () => {
    const waha = buildFakeWaha();
    const agent = newAgent({ waha });

    const result = await agent.callOnMessage(
      buildEnvelope('HUMAN_ACTION.RESOLVED', {
        humanActionId: sampleAction.id,
        choice: 'approve',
        source: 'admin',
      }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(waha.sent).toHaveLength(1);
    expect(waha.sent[0]?.chatId).toBe(GROUP_CHAT_ID);
    expect(waha.sent[0]?.text).toContain('✅');
    expect(waha.sent[0]?.text).toContain(sampleAction.id);
    expect(waha.sent[0]?.text).toContain('admin');
    expect(waha.sent[0]?.text).toContain('approve');
  });

  it('does NOT re-load the action row on RESOLVED (closure payload is self-sufficient)', async () => {
    const waha = buildFakeWaha();
    const agent = newAgent({ waha });

    await agent.callOnMessage(
      buildEnvelope('HUMAN_ACTION.RESOLVED', {
        humanActionId: sampleAction.id,
        choice: 'reject',
        source: 'whatsapp',
      }),
    );

    expect(mockedGetActionById).not.toHaveBeenCalled();
  });
});

describe('ReporterAgent — other intents', () => {
  it('returns a skipped envelope for unhandled intents', async () => {
    const waha = buildFakeWaha();
    const agent = newAgent({ waha });

    const result = await agent.callOnMessage(
      buildEnvelope('QUOTE.REQUESTED', { somePayload: true }),
    );

    expect(result).toMatchObject({
      ok: true,
      result: { skipped: 'unhandled-intent', intent: 'QUOTE.REQUESTED' },
    });
    expect(waha.sent).toHaveLength(0);
  });
});
