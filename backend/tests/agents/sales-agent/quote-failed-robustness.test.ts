/**
 * handleQuoteFailed robustness (2026-07-08, Achraf's CP-75091 run) — mocked.
 *
 * Pins the two behaviours that stop the alert spam:
 *   1. `maxance_invalid_postal_code` (or a "Ville obligatoire" detail) is a
 *      CUSTOMER-DATA problem → the agent asks the customer to verify their
 *      CP; NO human action, NO WA-group notification.
 *   2. While a PENDING QUOTE_FAILED action exists for the same lead, further
 *      failures are suppressed (audit only) — 7 pings in 15 min becomes 1.
 *   3. A fresh technical failure still escalates exactly as before.
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
vi.mock('../../../src/db/crypto.js', () => ({
  decryptPII: () => 'Achraf Mortady',
}));
vi.mock('../../../src/db/repositories/quotes.js', () => ({
  getQuoteByDevisNumber: vi.fn(),
}));

const createActionMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const listPendingMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
vi.mock('../../../src/db/repositories/human-actions.js', () => ({
  createAction: (...args: unknown[]) => createActionMock(...args),
  listPending: (...args: unknown[]) => listPendingMock(...args),
}));

const notifyHumanActionMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../../src/agents/human-notify.js', () => ({
  notifyHumanAction: (...args: unknown[]) => notifyHumanActionMock(...args),
}));

const appendAuditMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../../src/db/repositories/audit-log.js', () => ({
  appendAudit: (...args: unknown[]) => appendAuditMock(...args),
}));

vi.mock('../../../src/agents/sales-agent/handlers/comparison-continuation.js', () => ({
  continueComparisonAfterDelivery: vi.fn(),
  continueComparisonAfterPreview: vi.fn(),
  consumeComparisonPending: vi.fn(() => Promise.resolve(false)),
}));

import { handleQuoteFailed } from '../../../src/agents/sales-agent/handlers/quote.js';
import type { SalesHandlerCtx } from '../../../src/agents/sales-agent/handlers/context.js';
import type { AgentMessageEnvelope } from '../../../src/messaging/dispatcher.js';

const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';

function ctx(qualification: Record<string, unknown> | null = null): SalesHandlerCtx {
  return {
    db: {} as SalesHandlerCtx['db'],
    role: 'sales-agent',
    instanceId: 'test',
    resolveCustomerAndContact: vi.fn().mockResolvedValue({
      customer: { id: CUSTOMER_ID, fullName: 'enc' },
      lead: { id: LEAD_ID, qualification },
      contactRef: { channel: 'whatsapp', address: '+33611111111' },
    }) as unknown as SalesHandlerCtx['resolveCustomerAndContact'],
    leadIdFromEnvelope: () => LEAD_ID,
  };
}

function envelope(errorCode: string, detail?: string): AgentMessageEnvelope {
  return {
    id: 'env-1',
    intent: 'QUOTE.FAILED',
    toRole: 'sales-agent',
    toInstance: null,
    correlationId: QUOTE_ID,
    payload: {
      quoteId: QUOTE_ID,
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      errorCode,
      ...(detail ? { detail } : {}),
      screenshots: [],
    },
  } as unknown as AgentMessageEnvelope;
}

beforeEach(() => {
  generateSalesReplyMock.mockReset().mockResolvedValue({
    outcome: 'reply',
    replyText: 'Pouvez-vous vérifier votre code postal ?',
    customerId: CUSTOMER_ID,
    leadId: LEAD_ID,
    toolsInvoked: [],
  });
  sendViaChannelMock.mockReset().mockResolvedValue({ receipt: { externalId: 'x1' } });
  createActionMock.mockReset().mockResolvedValue({ id: 'action-1', summary: 's' });
  listPendingMock.mockReset().mockResolvedValue([]);
  notifyHumanActionMock.mockReset().mockResolvedValue(undefined);
  appendAuditMock.mockReset().mockResolvedValue(undefined);
});

describe('handleQuoteFailed — customer-data self-heal', () => {
  it('invalid postal code → asks the customer, no human action, no WA ping', async () => {
    const res = await handleQuoteFailed(
      ctx(),
      envelope('maxance_invalid_postal_code:cp=75091 — aucune commune trouvée'),
    );
    expect(res.ok).toBe(true);
    expect(createActionMock).not.toHaveBeenCalled();
    expect(notifyHumanActionMock).not.toHaveBeenCalled();
    expect(sendViaChannelMock).toHaveBeenCalledTimes(1);
    const llmArg = generateSalesReplyMock.mock.calls[0]![0] as { content: string };
    expect(llmArg.content).toContain('CODE POSTAL');
    const audit = appendAuditMock.mock.calls[0]![1] as { action: string };
    expect(audit.action).toBe('quote.failed.customer-data');
  });

  it("underage subscriber → asks for the PARENT's details, no escalation", async () => {
    const res = await handleQuoteFailed(
      ctx(),
      envelope('maxance_subscriber_underage:Maxance a refusé le souscripteur mineur'),
    );
    expect(res.ok).toBe(true);
    expect(createActionMock).not.toHaveBeenCalled();
    expect(notifyHumanActionMock).not.toHaveBeenCalled();
    expect(sendViaChannelMock).toHaveBeenCalledTimes(1);
    const llmArg = generateSalesReplyMock.mock.calls[0]![0] as { content: string };
    expect(llmArg.content).toContain('moins de 18 ans');
    expect(llmArg.content).toContain('prénom, nom et date de naissance');
  });

  it('minor DOB in the dossier → parent ask even on an OPAQUE error code', async () => {
    // Live 2026-07-08 16:56: stale extension build reported the underage
    // rejection as maxance_quote_unknown_screen — the dossier's own birth
    // date is the evidence, whatever the code says.
    const res = await handleQuoteFailed(
      ctx({ clientDateOfBirth: '2013-12-01' }),
      envelope('maxance_quote_unknown_screen', 'advance loop exhausted on screen=unknown'),
    );
    expect(res.ok).toBe(true);
    expect(createActionMock).not.toHaveBeenCalled();
    expect(notifyHumanActionMock).not.toHaveBeenCalled();
    const llmArg = generateSalesReplyMock.mock.calls[0]![0] as { content: string };
    expect(llmArg.content).toContain('prénom, nom et date de naissance');
  });

  it('street-parked dossier → asks for a secured parking spot, no escalation', async () => {
    const res = await handleQuoteFailed(
      ctx({ clientDateOfBirth: '1990-05-10', stationnement: 'rue' }),
      envelope('maxance_quote_unknown_screen', 'advance loop exhausted on screen=unknown'),
    );
    expect(res.ok).toBe(true);
    expect(createActionMock).not.toHaveBeenCalled();
    expect(notifyHumanActionMock).not.toHaveBeenCalled();
    const llmArg = generateSalesReplyMock.mock.calls[0]![0] as { content: string };
    expect(llmArg.content).toContain('voie publique');
    expect(llmArg.content).toContain('lieu sécurisé');
  });

  it('adult DOB + opaque error → still the normal technical escalation', async () => {
    const res = await handleQuoteFailed(
      ctx({ clientDateOfBirth: '1990-05-10' }),
      envelope('maxance_quote_unknown_screen', 'advance loop exhausted on screen=unknown'),
    );
    expect(res.ok).toBe(true);
    expect(createActionMock).toHaveBeenCalledTimes(1);
    expect(notifyHumanActionMock).toHaveBeenCalledTimes(1);
  });

  it('legacy "Ville obligatoire" detail classifies the same way', async () => {
    const res = await handleQuoteFailed(
      ctx(),
      envelope(
        'maxance_extension_orchestrate_hard_timeout',
        `ALERTE: La valeur du champ 'Ville' est obligatoire.`,
      ),
    );
    expect(res.ok).toBe(true);
    expect(createActionMock).not.toHaveBeenCalled();
    expect(notifyHumanActionMock).not.toHaveBeenCalled();
  });
});

describe('handleQuoteFailed — per-lead alert dedup', () => {
  it('suppresses the alert when a pending QUOTE_FAILED exists for the lead', async () => {
    listPendingMock.mockResolvedValue([
      {
        id: 'action-old',
        intent: 'QUOTE_FAILED',
        summary: `Quote old failed (x). Lead ${LEAD_ID}. Capture(s): 0.`,
      },
    ]);
    const res = await handleQuoteFailed(ctx(), envelope('maxance_extension_flow_timeout'));
    expect(res.ok).toBe(true);
    expect(createActionMock).not.toHaveBeenCalled();
    expect(notifyHumanActionMock).not.toHaveBeenCalled();
    const audit = appendAuditMock.mock.calls[0]![1] as { action: string };
    expect(audit.action).toBe('quote.failed.duplicate-suppressed');
  });

  it('a fresh technical failure still escalates (action + WA notify + customer notice)', async () => {
    const res = await handleQuoteFailed(ctx(), envelope('maxance_extension_flow_timeout'));
    expect(res.ok).toBe(true);
    expect(createActionMock).toHaveBeenCalledTimes(1);
    expect(notifyHumanActionMock).toHaveBeenCalledTimes(1);
    expect(sendViaChannelMock).toHaveBeenCalledTimes(1);
  });
});
