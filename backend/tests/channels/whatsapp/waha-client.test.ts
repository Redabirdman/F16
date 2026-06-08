/**
 * WahaClient retry/backoff tests (M16) — pure, no network.
 *
 * The fetch is stubbed via `fetchImpl` and the retry sleep via `sleepMs`, so
 * these run everywhere with no real waiting.
 */
import { describe, it, expect } from 'vitest';
import { WahaClient } from '../../../src/channels/whatsapp/waha-client.js';

const noSleep = (): Promise<void> => Promise.resolve();

function stubFetch(responder: (n: number) => { status: number; body?: unknown } | Error): {
  fetchImpl: typeof fetch;
  count: () => number;
} {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    const r = responder(n);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => n };
}

describe('WahaClient retry', () => {
  it('retries a 503 then succeeds', async () => {
    const { fetchImpl, count } = stubFetch((n) =>
      n === 1 ? { status: 503 } : { status: 200, body: { id: { _serialized: 'ok' } } },
    );
    const client = new WahaClient({ baseUrl: 'http://waha', fetchImpl, sleepMs: noSleep });
    const res = await client.sendText({ chatId: '33611@c.us', text: 'hi' });
    expect(res.id._serialized).toBe('ok');
    expect(count()).toBe(2);
  });

  it('retries a network error then succeeds', async () => {
    const { fetchImpl, count } = stubFetch((n) =>
      n === 1 ? new Error('ECONNRESET') : { status: 200, body: { id: { _serialized: 'x' } } },
    );
    const client = new WahaClient({ baseUrl: 'http://waha', fetchImpl, sleepMs: noSleep });
    await client.sendText({ chatId: '33611@c.us', text: 'hi' });
    expect(count()).toBe(2);
  });

  it('does NOT retry a 400 (surfaces immediately)', async () => {
    const { fetchImpl, count } = stubFetch(() => ({ status: 400, body: { error: 'bad chatId' } }));
    const client = new WahaClient({ baseUrl: 'http://waha', fetchImpl, sleepMs: noSleep });
    await expect(client.sendText({ chatId: 'bad', text: 'hi' })).rejects.toThrow(/400/);
    expect(count()).toBe(1);
  });

  it('gives up after MAX_ATTEMPTS on persistent 500', async () => {
    const { fetchImpl, count } = stubFetch(() => ({ status: 500 }));
    const client = new WahaClient({ baseUrl: 'http://waha', fetchImpl, sleepMs: noSleep });
    await expect(client.sendText({ chatId: '33611@c.us', text: 'hi' })).rejects.toThrow(/500/);
    expect(count()).toBe(3);
  });

  it('never echoes the request body (PII) in the error', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 400, body: {} }));
    const client = new WahaClient({ baseUrl: 'http://waha', fetchImpl, sleepMs: noSleep });
    const err = await client.sendText({ chatId: '33699@c.us', text: 'SECRET-PII' }).catch((e) => e);
    expect(String(err)).not.toContain('SECRET-PII');
    expect(String(err)).not.toContain('33699');
  });
});
