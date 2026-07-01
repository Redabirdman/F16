/**
 * Unit tests for the `subscription.request` tool (M8.T7 closing, task D1).
 *
 * Covers, without a real DB or Redis:
 *   1. The pure `buildSubscriptionRequestedPayload` helper — pins the wire
 *      shape the Maxance Operator consumes AND asserts NO bank detail
 *      (iban/bic/accountHolder) leaks into it (PII discipline — bankRef only).
 *   2. The registered tool INPUT/OUTPUT schemas (happy path + rejections).
 *   3. The handler with the DB + dispatcher MOCKED: an invalid IBAN is
 *      rejected (no persist, no emit); a valid one persists encrypted bank
 *      details and emits QUOTE.ACCEPTED + SUBSCRIPTION.REQUESTED.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Mocks (must be declared before importing the module under test) -------

const saveCustomerBankDetailsMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('../../src/db/repositories/customers.js', () => ({
  saveCustomerBankDetails: (...args: unknown[]) => saveCustomerBankDetailsMock(...args),
}));

const sendMessageMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../src/messaging/dispatcher.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

// Triggers tool registration as a side effect.
import {
  buildSubscriptionRequestedPayload,
  subscriptionRequestToolName,
} from '../../src/tools/builtins/subscription-request.js';
import { getTool } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/tools/registry.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';
// Valid FR IBAN (mod-97 checks out) used across the public IBAN test fixtures.
const VALID_IBAN = 'FR7630006000011234567890189';
const INVALID_IBAN = 'FR7630006000011234567890188'; // last digit tampered → bad checksum

const validInput = {
  quoteId: QUOTE_ID,
  customerId: CUSTOMER_ID,
  devisNumber: 'DR0000971882',
  iban: VALID_IBAN,
  bic: 'AGRIFRPP882',
  accountHolder: 'Sami Martin',
  birthPlaceCity: 'Paris',
  formule: 'tiers_illimite' as const,
  fractionnement: 'mensuel' as const,
};

/** A `ctx.db` test double whose select().from().where().limit() resolves to `rows`. */
function makeDbReturning(rows: unknown[]): ToolContext['db'] {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as ToolContext['db'];
}

function makeCtx(db: ToolContext['db']): ToolContext {
  return { db, agentRole: 'sales-agent', agentInstance: 'sales-agent#test' };
}

beforeEach(() => {
  saveCustomerBankDetailsMock.mockReset().mockResolvedValue(undefined);
  sendMessageMock.mockReset().mockResolvedValue(undefined);
});

describe('buildSubscriptionRequestedPayload', () => {
  it('carries quoteId/customerId/devisNumber/formule/fractionnement/birthPlaceCity + bankRef', () => {
    const out = buildSubscriptionRequestedPayload(validInput);
    expect(out).toEqual({
      quoteId: QUOTE_ID,
      customerId: CUSTOMER_ID,
      devisNumber: 'DR0000971882',
      formule: 'tiers_illimite',
      fractionnement: 'mensuel',
      birthPlaceCity: 'Paris',
      bankRef: 'customer',
    });
  });

  it('NEVER includes iban/bic/accountHolder in the payload (PII discipline)', () => {
    const out = buildSubscriptionRequestedPayload(validInput) as Record<string, unknown>;
    expect(out).not.toHaveProperty('iban');
    expect(out).not.toHaveProperty('bic');
    expect(out).not.toHaveProperty('accountHolder');
    expect(JSON.stringify(out)).not.toContain(VALID_IBAN);
    expect(JSON.stringify(out)).not.toContain('AGRIFRPP882');
  });

  it('validates against the SUBSCRIPTION.REQUESTED intent schema', async () => {
    const { SubscriptionRequestedPayload } = await import('../../src/intents/subscription.js');
    const out = buildSubscriptionRequestedPayload(validInput);
    expect(SubscriptionRequestedPayload.safeParse(out).success).toBe(true);
  });
});

describe('subscription.request — registered tool schema', () => {
  const tool = getTool(subscriptionRequestToolName);

  it('is registered on the tools registry barrel', () => {
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('subscription.request');
  });

  it('accepts a valid closing request', () => {
    expect(tool!.inputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects a non-UUID quoteId', () => {
    expect(tool!.inputSchema.safeParse({ ...validInput, quoteId: 'nope' }).success).toBe(false);
  });

  it('rejects an empty devisNumber', () => {
    expect(tool!.inputSchema.safeParse({ ...validInput, devisNumber: '' }).success).toBe(false);
  });

  it('rejects an unknown formule', () => {
    expect(tool!.inputSchema.safeParse({ ...validInput, formule: 'platinum' }).success).toBe(false);
  });

  it('rejects unknown extra fields (strict)', () => {
    expect(tool!.inputSchema.safeParse({ ...validInput, extra: 'x' }).success).toBe(false);
  });
});

describe('subscription.request — handler', () => {
  const tool = getTool(subscriptionRequestToolName)!;

  it('rejects an invalid IBAN BEFORE persisting or emitting', async () => {
    const db = makeDbReturning([{ id: CUSTOMER_ID, customerId: CUSTOMER_ID }]);
    await expect(tool.handler(makeCtx(db), { ...validInput, iban: INVALID_IBAN })).rejects.toThrow(
      /IBAN invalide/,
    );
    expect(saveCustomerBankDetailsMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does NOT leak the raw IBAN in the rejection error', async () => {
    const db = makeDbReturning([{ id: CUSTOMER_ID, customerId: CUSTOMER_ID }]);
    let message = '';
    try {
      await tool.handler(makeCtx(db), { ...validInput, iban: INVALID_IBAN });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(INVALID_IBAN);
    // Masked form is "FR76 •••• ..." — the country prefix is fine, the full
    // number is not.
    expect(message).toContain('••••');
  });

  it('persists encrypted bank details + emits QUOTE.ACCEPTED then SUBSCRIPTION.REQUESTED', async () => {
    const db = makeDbReturning([{ id: CUSTOMER_ID, customerId: CUSTOMER_ID }]);
    const res = await tool.handler(makeCtx(db), validInput);
    expect(res).toEqual({ quoteId: QUOTE_ID, queued: true });

    // Bank details persisted via the repository with the NORMALIZED iban.
    expect(saveCustomerBankDetailsMock).toHaveBeenCalledTimes(1);
    const [, custId, details] = saveCustomerBankDetailsMock.mock.calls[0] as [
      unknown,
      string,
      { iban: string; bic: string; accountHolder: string; birthPlaceCity: string },
    ];
    expect(custId).toBe(CUSTOMER_ID);
    expect(details.iban).toBe(VALID_IBAN);
    expect(details.bic).toBe('AGRIFRPP882');
    expect(details.accountHolder).toBe('Sami Martin');
    expect(details.birthPlaceCity).toBe('Paris');

    // Two emits, in order: QUOTE.ACCEPTED then SUBSCRIPTION.REQUESTED.
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const intents = sendMessageMock.mock.calls.map((c) => (c[1] as { intent: string }).intent);
    expect(intents).toEqual(['QUOTE.ACCEPTED', 'SUBSCRIPTION.REQUESTED']);

    const acceptedPayload = (sendMessageMock.mock.calls[0]![1] as { payload: unknown }).payload;
    expect(acceptedPayload).toEqual({ quoteId: QUOTE_ID });

    const subPayload = (sendMessageMock.mock.calls[1]![1] as { payload: Record<string, unknown> })
      .payload;
    expect(subPayload.bankRef).toBe('customer');
    expect(subPayload).not.toHaveProperty('iban');
    expect(subPayload).not.toHaveProperty('bic');
    expect(JSON.stringify(subPayload)).not.toContain(VALID_IBAN);
  });
});
