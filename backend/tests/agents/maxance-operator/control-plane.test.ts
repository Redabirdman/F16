/**
 * Phase-2d HTTP control plane (M8.T8) — pure unit tests with a stubbed
 * ExtensionClient. No live extension, no WS, no Postgres.
 *
 * Verifies:
 *   - Bearer-token gate (missing / wrong / right + ?token=-style env)
 *   - /health forwards client.health() + maps status to 200 / 503
 *   - /quote-preview validates body, calls runQuote, returns 200
 *   - /quote-preview rejects malformed bodies with 400
 *   - /quote-confirm defaults dryRun=true; respects explicit _dryRun=false
 *   - errors from the client surface as 500 with detail
 */
import { describe, expect, it } from 'vitest';
import { buildExtensionControlPlane } from '../../../src/agents/maxance-operator/control-plane.js';
import type { ExtensionClient } from '../../../src/agents/maxance-operator/extension-client.js';

/** Minimal recording stub matching only the surface the control plane touches. */
function makeStubClient(overrides: Partial<RecordingStub> = {}): RecordingStub & ExtensionClient {
  const calls: RecordingStub['calls'] = {
    health: 0,
    login: 0,
    runQuote: [] as unknown[],
    confirmQuote: [] as unknown[],
  };
  // Base methods always record into `calls` so per-test overrides don't
  // need to re-implement tracking just to count invocations.
  const base: RecordingStub = {
    calls,
    health: async () => {
      calls.health += 1;
      return { status: 'ok' as const };
    },
    ensureLoggedIn: async () => {
      calls.login += 1;
      return {
        sessionId: 'sess-1',
        durationMs: 100,
        screenshots: [],
        alreadyLoggedIn: true,
        requiredHumanAction: false,
        finalUrl: 'https://maxance.example/home',
      };
    },
    runQuote: async (_sessionName, params, opts) => {
      calls.runQuote.push({ params, opts });
      return {
        sessionId: 'sess-2',
        durationMs: 1234,
        screenshots: [],
        dryRun: true,
        pricePreviewEur: { monthly: 18.95 },
        finalUrl: 'https://maxance.example/quote',
      };
    },
    confirmQuote: async (_sessionName, subscriber, opts) => {
      calls.confirmQuote.push({ subscriber, opts });
      return {
        sessionId: 'sess-3',
        durationMs: 4321,
        screenshots: [],
        devisNumber: 'DR-TEST',
        pdfSentTo: 'test@example.com',
        finalUrl: 'https://maxance.example/devis',
      };
    },
  };
  const merged: RecordingStub = { ...base, ...overrides, calls };
  // Cast through unknown — the stub only implements the surface used by
  // the control plane. The full ExtensionClient class has WS internals
  // we don't need to mimic for HTTP-layer testing.
  return merged as unknown as RecordingStub & ExtensionClient;
}

interface RecordingStub {
  calls: {
    health: number;
    login: number;
    runQuote: unknown[];
    confirmQuote: unknown[];
  };
  health: () => Promise<{ status: 'ok' | 'no_extension' }>;
  ensureLoggedIn: () => Promise<unknown>;
  runQuote: (sessionName: string, params: unknown, opts: unknown) => Promise<unknown>;
  confirmQuote: (sessionName: string, subscriber: unknown, opts: unknown) => Promise<unknown>;
}

const validQuoteBody = {
  vehicleKind: 'trottinette',
  purchasePriceEur: 350,
  purchaseDate: '2025-01-15',
  postalCode: '75011',
  stationnement: 'garage_box',
  clientDateOfBirth: '1992-04-12',
};

const validSubscriberBody = {
  civilite: 'monsieur',
  lastName: 'Lefriekh',
  firstName: 'Ridaa',
  addressLine: '1 rue Test',
  postalCode: '75011',
  city: 'Paris',
  phoneMobile: '+33611111111',
  email: 'ridaa@example.com',
};

describe('control-plane Bearer-token gate', () => {
  it('passes every request when triggerToken is unset (dev mode)', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/health', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('401s without an Authorization header when token is set', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub, triggerToken: 't-secret' });
    const res = await app.request('/health', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('401s on a wrong token', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub, triggerToken: 't-secret' });
    const res = await app.request('/health', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-len' },
    });
    expect(res.status).toBe(401);
  });

  it('200s with the right token', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub, triggerToken: 't-secret' });
    const res = await app.request('/health', {
      method: 'POST',
      headers: { Authorization: 'Bearer t-secret' },
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /health', () => {
  it('returns 200 when the extension is connected', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/health', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 503 when no_extension', async () => {
    const stub = makeStubClient({ health: async () => ({ status: 'no_extension' as const }) });
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/health', { method: 'POST' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('no_extension');
  });
});

describe('POST /login', () => {
  it('forwards to ensureLoggedIn and returns the result', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/login', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyLoggedIn: boolean };
    expect(body.alreadyLoggedIn).toBe(true);
  });

  it('surfaces client errors as 500 with detail', async () => {
    const stub = makeStubClient({
      ensureLoggedIn: async () => {
        throw new Error('extension_disconnected');
      },
    });
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/login', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('login_failed');
    expect(body.detail).toMatch(/extension_disconnected/);
  });
});

describe('POST /quote-preview', () => {
  it('validates body + calls runQuote + returns 200 with price', async () => {
    const stub = makeStubClient({
      runQuote: async (_sessionName, params, opts) => {
        stub.calls.runQuote.push({ params, opts });
        return {
          sessionId: 'sess-x',
          durationMs: 1000,
          screenshots: [],
          dryRun: true,
          pricePreviewEur: { monthly: 22.5 },
          finalUrl: 'https://maxance.example/q',
        };
      },
    });
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/quote-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validQuoteBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pricePreviewEur: { monthly: number } };
    expect(body.pricePreviewEur.monthly).toBe(22.5);
    expect(stub.calls.runQuote).toHaveLength(1);
  });

  it('400s on a missing required field', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/quote-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validQuoteBody, postalCode: undefined }),
    });
    expect(res.status).toBe(400);
    expect(stub.calls.runQuote).toHaveLength(0);
  });

  it('400s on invalid JSON', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/quote-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json-{',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_json_body');
  });

  it('surfaces runQuote throws as 500 with detail', async () => {
    const stub = makeStubClient({
      runQuote: async () => {
        throw new Error('extension_timeout');
      },
    });
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/quote-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validQuoteBody),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('quote_preview_failed');
    expect(body.detail).toMatch(/extension_timeout/);
  });
});

describe('POST /quote-confirm', () => {
  it('defaults dryRun=true and strips _dryRun before forwarding', async () => {
    const stub = makeStubClient({
      confirmQuote: async (_sessionName, subscriber, opts) => {
        stub.calls.confirmQuote.push({ subscriber, opts });
        return {
          sessionId: 'sess-c',
          durationMs: 9999,
          screenshots: [],
          devisNumber: 'DR-PLAN',
          pdfSentTo: 'test@example.com',
          finalUrl: 'https://maxance.example/devis',
        };
      },
    });
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/quote-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validSubscriberBody),
    });
    expect(res.status).toBe(200);
    expect(stub.calls.confirmQuote).toHaveLength(1);
    const captured = stub.calls.confirmQuote[0] as {
      subscriber: { _dryRun?: unknown };
      opts: { dryRun: boolean };
    };
    expect(captured.opts.dryRun).toBe(true);
    expect(captured.subscriber._dryRun).toBeUndefined();
  });

  it('honors explicit _dryRun=false (lets the real email send fire)', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub });
    await app.request('/quote-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validSubscriberBody, _dryRun: false }),
    });
    expect(stub.calls.confirmQuote).toHaveLength(1);
    const captured = stub.calls.confirmQuote[0] as { opts: { dryRun: boolean } };
    expect(captured.opts.dryRun).toBe(false);
  });

  it('400s on an invalid email', async () => {
    const stub = makeStubClient();
    const app = buildExtensionControlPlane({ client: stub });
    const res = await app.request('/quote-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validSubscriberBody, email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    expect(stub.calls.confirmQuote).toHaveLength(0);
  });
});
