/**
 * Unit tests for the M8.T7 closing capstone (task C2):
 * `handleSubscriptionRequested` in subscription-handler.ts.
 *
 * No DB / Redis / extension / WAHA / Stripe network. Every boundary is mocked:
 *   - quotes repo (markSubscription*) — assert transitions
 *   - customers repo (getCustomerBankDetails / getCustomerById) — bank + name
 *   - human-actions repo (createAction) — inspector handoff row
 *   - dispatcher (sendMessage) — assert emitted intents
 *   - stripe factory (getStripeClientFromEnv) — link / null
 * The driver client + screenshot sender are injected stubs.
 *
 * Cases:
 *   1. happy real path → SUBSCRIPTION.READY (computed assuryalFrais) +
 *      CONTRACT.PENDING_HUMAN + INSPECTOR_HANDOFF human action + screenshot.
 *   2. rib_rejected → SUBSCRIPTION.FAILED + markSubscriptionFailed, NO READY.
 *   3. dryRun → READY but inspector handoff SKIPPED.
 *   4. Stripe null → READY with paymentLinkUrl null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── module mocks ────────────────────────────────────────────────────────────
vi.mock('../../../src/messaging/dispatcher.js', () => ({
  sendMessage: vi.fn(async () => 'msg-id'),
}));
vi.mock('../../../src/db/repositories/quotes.js', () => ({
  markSubscriptionRequested: vi.fn(async () => ({})),
  markSubscriptionInProgress: vi.fn(async () => ({})),
  markSubscriptionPendingInspector: vi.fn(async () => ({})),
  markSubscriptionFailed: vi.fn(async () => ({})),
}));
vi.mock('../../../src/db/repositories/customers.js', () => ({
  getCustomerById: vi.fn(async () => ({ id: 'cust-1', fullName: 'Jean Dupont' })),
  getCustomerBankDetails: vi.fn(async () => ({
    iban: 'FR7630006000011234567890189',
    bic: 'AGRIFRPP',
    accountHolder: 'Jean Dupont',
    birthPlaceCity: 'Lyon',
  })),
}));
vi.mock('../../../src/db/repositories/human-actions.js', () => ({
  createAction: vi.fn(async () => ({ id: 'ha-1' })),
}));
vi.mock('../../../src/integrations/stripe/client.js', () => ({
  getStripeClientFromEnv: vi.fn(() => ({
    createFraisPaymentLink: vi.fn(async () => ({
      url: 'https://pay.stripe.test/abc',
      paymentLinkId: 'plink_1',
      amountEur: 33,
    })),
  })),
}));

import { handleSubscriptionRequested } from '../../../src/agents/maxance-operator/subscription-handler.js';
import { sendMessage } from '../../../src/messaging/dispatcher.js';
import {
  markSubscriptionRequested,
  markSubscriptionInProgress,
  markSubscriptionPendingInspector,
  markSubscriptionFailed,
} from '../../../src/db/repositories/quotes.js';
import { createAction } from '../../../src/db/repositories/human-actions.js';
import { getStripeClientFromEnv } from '../../../src/integrations/stripe/client.js';
import type { Database } from '../../../src/db/index.js';

const DB = {} as unknown as Database;

interface RecordedScreenshot {
  base64Png: string;
  caption: string;
}

function makeCtx(screenshots: RecordedScreenshot[]) {
  const sender = {
    send: vi.fn(async (input: RecordedScreenshot) => {
      screenshots.push(input);
    }),
  };
  return {
    ctx: {
      db: DB,
      role: 'maxance-operator',
      instanceId: 'singleton',
      getClient: vi.fn(),
      screenshotSender: sender,
    },
    sender,
  };
}

function makeEnvelope() {
  return {
    id: 'env-1',
    intent: 'SUBSCRIPTION.REQUESTED',
    toRole: 'maxance-operator',
    toInstance: null,
    correlationId: 'quote-1',
    priority: 5,
    createdAt: new Date(),
    payload: {
      quoteId: 'quote-1',
      customerId: 'cust-1',
      leadId: 'lead-1',
      devisNumber: 'DR0000971882',
      formule: 'tiers_illimite' as const,
      fractionnement: 'mensuel' as const,
      birthPlaceCity: 'Lyon',
      bankRef: 'customer' as const,
    },
  };
}

/** A driver client stub exposing the closing methods. */
function makeClient(opts: { completeResult?: unknown; completeThrows?: unknown }) {
  return {
    ensureLoggedIn: vi.fn(async () => ({
      sessionId: 's',
      durationMs: 1,
      screenshots: [],
      alreadyLoggedIn: true,
      requiredHumanAction: false,
      finalUrl: 'u',
    })),
    runQuote: vi.fn(),
    confirmQuote: vi.fn(),
    resumeDevis: vi.fn(async () => ({
      sessionId: 's',
      durationMs: 10,
      screenshots: [],
      devisNumber: 'DR0000971882',
      pricePreviewEur: { monthly: 18.95 },
      comptantBreakdown: { fractionnement: 'mensuel', comptantEur: 52.04, fraisComptantEur: 17 },
      finalUrl: 'u',
    })),
    completeSubscription: vi.fn(async () => {
      if (opts.completeThrows) throw opts.completeThrows;
      return opts.completeResult;
    }),
  };
}

/** Real-mode completeSubscription result reaching the Paiement page. */
function realCompleteResult() {
  return {
    sessionId: 's',
    durationMs: 20,
    screenshots: [
      { step: 'bancaires', url: 'data:image/png;base64,AAA' },
      { step: 'paiement', url: 'data:image/png;base64,BBB' },
    ],
    dryRun: false,
    souscripteurRef: 'T123456',
    montantComptantEur: 52.04,
    comptantBreakdown: {
      fraisGestionEur: 30,
      commissionEur: 0.39,
      fraisDossierEur: 17,
      comptantDuEur: 52.04,
    },
    finalUrl: 'u',
  };
}

function emittedIntents(): string[] {
  return (sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => (c[1] as { intent: string }).intent,
  );
}

function payloadFor(intent: string): Record<string, unknown> | undefined {
  const call = (sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
    (c) => (c[1] as { intent: string }).intent === intent,
  );
  return call ? (call[1] as { payload: Record<string, unknown> }).payload : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MAXANCE_SUBSCRIPTION_FORCE_DRYRUN;
});
afterEach(() => {
  delete process.env.MAXANCE_SUBSCRIPTION_FORCE_DRYRUN;
});

describe('handleSubscriptionRequested — happy real path', () => {
  it('emits READY (with assuryalFrais) + CONTRACT.PENDING_HUMAN + human action + screenshot', async () => {
    process.env.MAXANCE_SUBSCRIPTION_FORCE_DRYRUN = '0'; // real mode
    const shots: RecordedScreenshot[] = [];
    const { ctx } = makeCtx(shots);
    const client = makeClient({ completeResult: realCompleteResult() });

    const res = await handleSubscriptionRequested(ctx, makeEnvelope(), client as never);

    expect(res.ok).toBe(true);

    // transitions: requested → in_progress → pending_inspector, no failure.
    expect(markSubscriptionRequested).toHaveBeenCalledOnce();
    expect(markSubscriptionInProgress).toHaveBeenCalledOnce();
    expect(markSubscriptionPendingInspector).toHaveBeenCalledOnce();
    expect(markSubscriptionFailed).not.toHaveBeenCalled();

    // emitted intents include READY + CONTRACT.PENDING_HUMAN + HUMAN_ACTION.REQUESTED.
    const intents = emittedIntents();
    expect(intents).toContain('SUBSCRIPTION.READY');
    expect(intents).toContain('CONTRACT.PENDING_HUMAN');
    expect(intents).toContain('HUMAN_ACTION.REQUESTED');

    // assuryalFrais = total(50) − fraisDossierEur(17) = 33.
    const ready = payloadFor('SUBSCRIPTION.READY');
    expect(ready?.assuryalFraisEur).toBe(33);
    expect(ready?.fraisDossierTotalEur).toBe(50);
    expect(ready?.fraisComptantEur).toBe(17);
    expect(ready?.paymentLinkUrl).toBe('https://pay.stripe.test/abc');
    expect(ready?.dryRun).toBe(false);
    expect(ready?.souscripteurRef).toBe('T123456');

    // inspector handoff human action: severity 1, INSPECTOR_HANDOFF.
    expect(createAction).toHaveBeenCalledOnce();
    const actionArg = (createAction as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      intent: string;
      severity: number;
    };
    expect(actionArg.intent).toBe('INSPECTOR_HANDOFF');
    expect(actionArg.severity).toBe(1);

    // paiement screenshot pushed to the WA group (last/paiement step, base64 BBB).
    expect(shots).toHaveLength(1);
    expect(shots[0]?.base64Png).toBe('BBB');
  });
});

describe('handleSubscriptionRequested — rib_rejected', () => {
  it('marks FAILED + emits SUBSCRIPTION.FAILED, no READY/handoff', async () => {
    process.env.MAXANCE_SUBSCRIPTION_FORCE_DRYRUN = '0';
    const shots: RecordedScreenshot[] = [];
    const { ctx } = makeCtx(shots);
    // readErrorCode reads `.errorCode` off the typed error — use the real class.
    const { ExtensionClientError } =
      await import('../../../src/agents/maxance-operator/extension-client.js');
    const client = makeClient({
      completeThrows: new ExtensionClientError('rib rejected', 'maxance_subscription_rib_rejected'),
    });

    const res = await handleSubscriptionRequested(ctx, makeEnvelope(), client as never);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('maxance_subscription_rib_rejected');

    expect(markSubscriptionFailed).toHaveBeenCalledOnce();
    const failArg = (markSubscriptionFailed as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[2] as { errorCode: string };
    expect(failArg.errorCode).toBe('maxance_subscription_rib_rejected');

    const intents = emittedIntents();
    expect(intents).toContain('SUBSCRIPTION.FAILED');
    expect(intents).not.toContain('SUBSCRIPTION.READY');
    expect(intents).not.toContain('CONTRACT.PENDING_HUMAN');
    expect(createAction).not.toHaveBeenCalled();
    expect(shots).toHaveLength(0);
  });
});

describe('handleSubscriptionRequested — dryRun (default)', () => {
  it('emits READY but SKIPS the inspector handoff', async () => {
    // default (env unset) → dryRun = true.
    const shots: RecordedScreenshot[] = [];
    const { ctx } = makeCtx(shots);
    const client = makeClient({
      completeResult: {
        sessionId: 's',
        durationMs: 5,
        screenshots: [],
        dryRun: true,
        stoppedBefore: 'valider_souscription',
        comptantBreakdown: null,
        finalUrl: 'u',
      },
    });

    const res = await handleSubscriptionRequested(ctx, makeEnvelope(), client as never);

    expect(res.ok).toBe(true);
    const intents = emittedIntents();
    expect(intents).toContain('SUBSCRIPTION.READY');
    expect(intents).not.toContain('CONTRACT.PENDING_HUMAN');
    expect(intents).not.toContain('HUMAN_ACTION.REQUESTED');
    expect(createAction).not.toHaveBeenCalled();
    expect(shots).toHaveLength(0);

    const ready = payloadFor('SUBSCRIPTION.READY');
    expect(ready?.dryRun).toBe(true);
    // dryRun falls back to the resume breakdown: fraisComptant 17 → assuryal 33.
    expect(ready?.assuryalFraisEur).toBe(33);

    expect(markSubscriptionPendingInspector).toHaveBeenCalledOnce();
  });
});

describe('handleSubscriptionRequested — Stripe unconfigured', () => {
  it('emits READY with paymentLinkUrl null', async () => {
    process.env.MAXANCE_SUBSCRIPTION_FORCE_DRYRUN = '0';
    (getStripeClientFromEnv as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const shots: RecordedScreenshot[] = [];
    const { ctx } = makeCtx(shots);
    const client = makeClient({ completeResult: realCompleteResult() });

    const res = await handleSubscriptionRequested(ctx, makeEnvelope(), client as never);

    expect(res.ok).toBe(true);
    const ready = payloadFor('SUBSCRIPTION.READY');
    expect(ready?.paymentLinkUrl).toBeNull();
    expect(ready?.assuryalFraisEur).toBe(33);
  });
});
