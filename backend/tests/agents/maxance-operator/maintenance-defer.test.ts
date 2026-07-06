/**
 * Maintenance re-park tests (2026-07-06, Ridaa's self-heal mission).
 *
 * When the extension reports the tagged `maxance_maintenance` error (the
 * Maxance portal is serving its maintenance page), the operator must NOT
 * emit QUOTE.FAILED (customer apology + management alert). Instead it
 * re-emits the SAME intent+payload to itself as a delayed job with
 * payload.deferCount+1 — bounded at 4, after which it falls through to the
 * normal QUOTE.FAILED path.
 *
 * No DB / Redis / extension network: dispatcher.sendMessage is mocked, the
 * driver client is an injected stub, `db` is a minimal chain stub for the
 * best-effort quote-row update in emitFailed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/messaging/dispatcher.js', () => ({
  sendMessage: vi.fn(async () => 'msg-id'),
}));
vi.mock('../../../src/db/repositories/quotes.js', () => ({
  markQuoteConfirmed: vi.fn(async () => ({})),
  markQuotePreview: vi.fn(async () => ({})),
  markSubscriptionFailed: vi.fn(async () => ({})),
}));
vi.mock('../../../src/db/repositories/leads.js', () => ({
  setLeadStatus: vi.fn(async () => ({})),
}));

import { MaxanceOperatorAgent } from '../../../src/agents/maxance-operator/agent.js';
import type { MaxanceDriverClient } from '../../../src/agents/maxance-operator/driver-client.js';
import { ExtensionClientError } from '../../../src/agents/maxance-operator/extension-client.js';
import { sendMessage } from '../../../src/messaging/dispatcher.js';
import type { AgentMessageEnvelope } from '../../../src/messaging/dispatcher.js';
import type { Database } from '../../../src/db/index.js';

const sendMessageMock = vi.mocked(sendMessage);

/** Minimal drizzle-ish chain stub for emitFailed's best-effort row update. */
const DB = {
  update: () => ({ set: () => ({ where: async () => undefined }) }),
} as unknown as Database;

/** Expose the protected onMessage for direct invocation. */
class TestableOperator extends MaxanceOperatorAgent {
  public handle(envelope: AgentMessageEnvelope): ReturnType<MaxanceOperatorAgent['onMessage']> {
    return this.onMessage(envelope);
  }
}

type ClientStub = {
  ensureLoggedIn: ReturnType<typeof vi.fn>;
  runQuote: ReturnType<typeof vi.fn>;
  confirmQuote: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<ClientStub> = {}): ClientStub {
  return {
    ensureLoggedIn: vi.fn(async () => ({
      sessionId: 's',
      durationMs: 1,
      screenshots: [],
      alreadyLoggedIn: true,
      requiredHumanAction: false,
      finalUrl: 'https://www.maxance.com/Proximeo/accueil.do',
    })),
    runQuote: vi.fn(),
    confirmQuote: vi.fn(),
    ...overrides,
  };
}

function newAgent(client: ClientStub): TestableOperator {
  return new TestableOperator(
    {
      role: 'maxance-operator',
      instanceId: 'singleton',
      model: 'sonnet',
      queues: ['quote'],
      db: DB,
    },
    {
      client: client as unknown as MaxanceDriverClient,
      screenshotSender: null,
    },
  );
}

const MAINTENANCE_ERR = new ExtensionClientError(
  'Maxance maintenance page at https://www.maxance.com/Proximeo/accueil.do',
  'maxance_maintenance',
);

function quoteRequestedEnvelope(deferCount?: number): AgentMessageEnvelope {
  return {
    id: 'env-1',
    intent: 'QUOTE.REQUESTED',
    toRole: 'maxance-operator',
    toInstance: 'singleton',
    correlationId: 'c0ffee00-0000-4000-8000-000000000001',
    priority: 5,
    createdAt: new Date(),
    payload: {
      quoteId: 'c0ffee00-0000-4000-8000-000000000001',
      customerId: 'c0ffee00-0000-4000-8000-000000000002',
      leadId: 'c0ffee00-0000-4000-8000-000000000003',
      product: 'scooter',
      productVariant: 'trottinette',
      formData: {
        purchasePriceEur: 350,
        purchaseDate: '2026-01-15',
        postalCode: '75001',
        stationnement: 'garage_box',
        clientDateOfBirth: '1990-06-12',
      },
      ...(deferCount !== undefined ? { deferCount } : {}),
    },
  } as unknown as AgentMessageEnvelope;
}

function confirmRequestedEnvelope(deferCount?: number): AgentMessageEnvelope {
  return {
    id: 'env-2',
    intent: 'QUOTE.CONFIRM_REQUESTED',
    toRole: 'maxance-operator',
    toInstance: 'singleton',
    correlationId: 'c0ffee00-0000-4000-8000-000000000001',
    priority: 5,
    createdAt: new Date(),
    payload: {
      quoteId: 'c0ffee00-0000-4000-8000-000000000001',
      customerId: 'c0ffee00-0000-4000-8000-000000000002',
      leadId: 'c0ffee00-0000-4000-8000-000000000003',
      subscriber: {
        civilite: 'monsieur',
        lastName: 'DUPONT',
        firstName: 'Jean',
        addressLine: '12 RUE DE LA PAIX',
        postalCode: '75001',
        city: 'PARIS 01',
        phoneMobile: '0612345678',
        email: 'jean@example.com',
      },
      ...(deferCount !== undefined ? { deferCount } : {}),
    },
  } as unknown as AgentMessageEnvelope;
}

/** All sendMessage calls' input objects (2nd arg). */
function sentInputs(): Array<Record<string, unknown>> {
  return sendMessageMock.mock.calls.map((c) => c[1] as unknown as Record<string, unknown>);
}

describe('maxance-operator maintenance defer', () => {
  const ENV_KEYS = ['MAXANCE_DRIVER', 'MAXANCE_HOURS_247'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.MAXANCE_DRIVER = 'chrome_extension';
    // Portal "open" → deferIfPortalClosed is a no-op and the maintenance
    // defer uses the 30-min unscheduled-downtime delay.
    process.env.MAXANCE_HOURS_247 = '1';
    sendMessageMock.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    vi.useRealTimers();
  });

  it('QUOTE.REQUESTED + maintenance → delayed re-emit with deferCount=1, NO QUOTE.FAILED', async () => {
    const client = makeClient({
      runQuote: vi.fn(async () => {
        throw MAINTENANCE_ERR;
      }),
    });
    const agent = newAgent(client);
    const result = await agent.handle(quoteRequestedEnvelope());

    expect(result).toMatchObject({
      ok: true,
      result: { deferred: 'maintenance', deferCount: 1 },
    });

    const inputs = sentInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      toRole: 'maxance-operator',
      toInstance: 'singleton',
      intent: 'QUOTE.REQUESTED',
      delayMs: 30 * 60_000,
    });
    expect((inputs[0]?.payload as { deferCount?: number }).deferCount).toBe(1);
    expect(inputs.some((i) => i.intent === 'QUOTE.FAILED')).toBe(false);
  });

  it('increments an existing deferCount (2 → 3)', async () => {
    const client = makeClient({
      runQuote: vi.fn(async () => {
        throw MAINTENANCE_ERR;
      }),
    });
    const agent = newAgent(client);
    const result = await agent.handle(quoteRequestedEnvelope(2));

    expect(result).toMatchObject({
      ok: true,
      result: { deferred: 'maintenance', deferCount: 3 },
    });
    expect((sentInputs()[0]?.payload as { deferCount?: number }).deferCount).toBe(3);
  });

  it('deferCount=4 exhausts the budget → falls through to QUOTE.FAILED', async () => {
    const client = makeClient({
      runQuote: vi.fn(async () => {
        throw MAINTENANCE_ERR;
      }),
    });
    const agent = newAgent(client);
    const result = await agent.handle(quoteRequestedEnvelope(4));

    expect(result.ok).toBe(false);
    const inputs = sentInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ toRole: 'sales-agent', intent: 'QUOTE.FAILED' });
    expect((inputs[0]?.payload as { errorCode?: string }).errorCode).toContain(
      'maxance_maintenance',
    );
  });

  it('QUOTE.CONFIRM_REQUESTED + maintenance on confirm → delayed re-emit, NO QUOTE.FAILED', async () => {
    const client = makeClient({
      confirmQuote: vi.fn(async () => {
        throw MAINTENANCE_ERR;
      }),
    });
    const agent = newAgent(client);
    const result = await agent.handle(confirmRequestedEnvelope());

    expect(result).toMatchObject({
      ok: true,
      result: { deferred: 'maintenance', deferCount: 1 },
    });

    const inputs = sentInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      toRole: 'maxance-operator',
      intent: 'QUOTE.CONFIRM_REQUESTED',
      delayMs: 30 * 60_000,
    });
    const payload = inputs[0]?.payload as { deferCount?: number; subscriber?: unknown };
    expect(payload.deferCount).toBe(1);
    // The rest of the payload is threaded through untouched.
    expect(payload.subscriber).toMatchObject({ lastName: 'DUPONT' });
    expect(inputs.some((i) => i.intent === 'QUOTE.FAILED')).toBe(false);
  });

  it('maintenance during login (login_failed:maxance_maintenance) also parks', async () => {
    const client = makeClient({
      ensureLoggedIn: vi.fn(async () => {
        throw MAINTENANCE_ERR;
      }),
    });
    const agent = newAgent(client);
    const result = await agent.handle(quoteRequestedEnvelope());

    expect(result).toMatchObject({
      ok: true,
      result: { deferred: 'maintenance', deferCount: 1 },
    });
    expect(sentInputs().some((i) => i.intent === 'QUOTE.FAILED')).toBe(false);
  });

  it('parks until the next opening when the portal window is closed', async () => {
    // Saturday 12:00 Casablanca (UTC+1) → closed until Monday 08:00.
    Reflect.deleteProperty(process.env, 'MAXANCE_HOURS_247');
    vi.useFakeTimers({ now: new Date('2026-07-11T11:00:00Z'), toFake: ['Date'] });

    const client = makeClient({
      runQuote: vi.fn(async () => {
        throw MAINTENANCE_ERR;
      }),
    });
    const agent = newAgent(client);
    const result = await agent.handle(quoteRequestedEnvelope());

    // deferIfPortalClosed catches it FIRST (portal closed) — that's the
    // desired behavior: the job is re-parked to the opening either way.
    expect(result.ok).toBe(true);
    const inputs = sentInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ toRole: 'maxance-operator', intent: 'QUOTE.REQUESTED' });
    const delayMs = inputs[0]?.delayMs as number;
    expect(delayMs).toBeGreaterThan(24 * 3_600_000); // well past 24h (Sat → Mon 08:00)
    expect(inputs.some((i) => i.intent === 'QUOTE.FAILED')).toBe(false);
  });
});
