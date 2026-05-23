/**
 * Stagehand HTTP client tests (M8.T4).
 *
 * Pure unit tests — no Stagehand server, no Anthropic, no DB. Each case
 * stubs `globalThis.fetch` to assert the client constructs the right
 * request and surfaces errors correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StagehandClient,
  StagehandClientError,
} from '../../../src/agents/maxance-operator/stagehand-client.js';

const baseUrl = 'http://stagehand.test';

let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Builds a Response-like object with the given status + JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('StagehandClient — HMAC signing', () => {
  it('attaches x-stagehand-signature when hmacSecret is configured', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { sessionId: 's1', alreadyLoggedIn: true, screenshots: [] }),
    );
    const client = new StagehandClient({ baseUrl, hmacSecret: 'test-secret' });
    await client.ensureLoggedIn('any');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sig = (init.headers as Record<string, string>)['x-stagehand-signature'];
    expect(sig).toMatch(/^sha256=[a-f0-9]+$/);
  });

  it('omits signature when no hmacSecret', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const client = new StagehandClient({ baseUrl });
    await client.ensureLoggedIn('any');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-stagehand-signature']).toBeUndefined();
  });
});

describe('StagehandClient — runQuote', () => {
  it('posts dryRun=true by default with the params verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 's1',
        durationMs: 4200,
        screenshots: [{ step: 'initial_load', url: '/v1/static/screenshots/x.png' }],
        dryRun: true,
        pricePreviewEur: { monthly: 18.95, annual: null },
        finalUrl: 'https://maxance.com/quote/preview',
      }),
    );
    const client = new StagehandClient({ baseUrl });
    const result = await client.runQuote('maxance-default', {
      vehicleKind: 'trottinette',
      purchasePriceEur: 350,
      purchaseDate: '2026-01-15T00:00:00Z',
      postalCode: '75001',
      stationnement: 'garage_box',
      clientDateOfBirth: '1990-06-12T00:00:00Z',
    });

    expect(result.pricePreviewEur.monthly).toBe(18.95);
    expect(result.durationMs).toBe(4200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/v1/maxance/quote`);
    const body = JSON.parse(init.body as string) as { dryRun: boolean; sessionName: string };
    expect(body.dryRun).toBe(true);
    expect(body.sessionName).toBe('maxance-default');
  });

  it('honours explicit dryRun=false (M8.T6 path — keeps the client flexible)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sessionId: 's1', screenshots: [] }));
    const client = new StagehandClient({ baseUrl });
    await client.runQuote(
      'any',
      {
        vehicleKind: 'trottinette',
        purchasePriceEur: 100,
        purchaseDate: '2026-01-01',
        postalCode: '75001',
        stationnement: 'rue',
        clientDateOfBirth: '1990-01-01',
      },
      { dryRun: false },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { dryRun: boolean };
    expect(body.dryRun).toBe(false);
  });
});

describe('StagehandClient — error mapping', () => {
  it('converts a 5xx JSON-error body to a StagehandClientError carrying the error code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: 'maxance_quote_unexpected_entry_page:unknown' }),
    );
    const client = new StagehandClient({ baseUrl });
    await expect(
      client.runQuote('any', {
        vehicleKind: 'trottinette',
        purchasePriceEur: 100,
        purchaseDate: '2026-01-01',
        postalCode: '75001',
        stationnement: 'rue',
        clientDateOfBirth: '1990-01-01',
      }),
    ).rejects.toMatchObject({
      errorCode: 'maxance_quote_unexpected_entry_page:unknown',
      status: 500,
    });
  });

  it('converts a non-JSON 502 to a stagehand_http_502 error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream blah', { status: 502 }));
    const client = new StagehandClient({ baseUrl });
    await expect(client.ensureLoggedIn('any')).rejects.toMatchObject({
      errorCode: 'http_502',
      status: 502,
    });
  });

  it('converts an AbortError to a stagehand_timeout error', async () => {
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          const e = new Error('abort');
          e.name = 'AbortError';
          reject(e);
        }),
    );
    const client = new StagehandClient({ baseUrl });
    await expect(client.ensureLoggedIn('any')).rejects.toMatchObject({
      errorCode: 'stagehand_timeout',
    });
  });

  it('converts a network throw to a stagehand_network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('ECONNREFUSED'));
    const client = new StagehandClient({ baseUrl });
    await expect(client.ensureLoggedIn('any')).rejects.toBeInstanceOf(StagehandClientError);
    await expect(client.ensureLoggedIn('any').catch((e) => e)).resolves.toBeInstanceOf(
      StagehandClientError,
    );
  });
});

describe('StagehandClient — health', () => {
  it('returns 200 body on healthy', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'ok' }));
    const client = new StagehandClient({ baseUrl });
    expect(await client.health()).toEqual({ status: 'ok' });
  });

  it('throws StagehandClientError on non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    const client = new StagehandClient({ baseUrl });
    await expect(client.health()).rejects.toBeInstanceOf(StagehandClientError);
  });
});
