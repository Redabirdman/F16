/**
 * Integration tests for the M8.T1 Stagehand HTTP service.
 *
 * Runs against a LIVE Stagehand + real Chromium + real Anthropic API call
 * (Stagehand's act/extract use the LLM to interpret instructions). Each run
 * costs ~$0.01 in Sonnet 4.5 tokens. Gated on ANTHROPIC_API_KEY — skipped on
 * machines without it so CI without the secret stays green.
 *
 * The target HTML is served from an in-process Node http server bound to
 * 127.0.0.1 on an ephemeral port. No external internet dependency.
 *
 * First Chromium launch on a fresh machine can take 60s+ (Playwright's
 * download cache); per-test timeouts are 90s.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../src/index.js';
import { pool } from '../src/browser-pool.js';

const liveSkip = !process.env.ANTHROPIC_API_KEY;

let target: Server;
let targetUrl: string;
let dataDir: string;

beforeAll(async () => {
  // Throwaway data root so screenshots/sessions don't leak between test runs
  // or pollute the dev `./data` checkout.
  dataDir = await mkdtemp(join(tmpdir(), 'f16-stagehand-test-'));
  process.env.STAGEHAND_DATA_DIR = dataDir;

  // Tiny HTML target with one h1 and one clickable link. Two routes so an
  // `act` ("Click the Continue link") can be verified by an `extract` ("Get
  // the h1 text") on the destination page.
  target = createServer((req, res) => {
    if (req.url === '/click') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end(
        '<html><head><title>Click Done</title></head><body><h1>Clicked OK</h1></body></html>',
      );
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html');
    res.end(
      '<html><head><title>Test Page</title></head><body><h1>Hello F16</h1><a href="/click" id="cta">Continue</a></body></html>',
    );
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await pool.closeAll();
  await new Promise<void>((r) => target.close(() => r()));
  // Best-effort cleanup; if Stagehand leaked a child process the rm may fail —
  // not a test failure since the OS cleans tmp eventually.
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * Cheap unit-y tests that don't need to boot Chromium. Keep this block above
 * the live block so a misconfigured machine still gets the security + routing
 * coverage.
 */
describe('Stagehand HTTP service — routing + HMAC', () => {
  beforeEach(async () => {
    // Each test starts from an empty pool; otherwise stale sessions from a
    // prior test would change /v1/sessions counts.
    await pool.closeAll();
  });

  it('HMAC verification — bad signature returns 401', async () => {
    const saved = process.env.STAGEHAND_HMAC_SECRET;
    process.env.STAGEHAND_HMAC_SECRET = 'test-secret';
    try {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'x-stagehand-signature': 'sha256=baadf00d' },
        body: JSON.stringify({ name: 'hmac-test' }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_signature');
    } finally {
      if (saved === undefined) delete process.env.STAGEHAND_HMAC_SECRET;
      else process.env.STAGEHAND_HMAC_SECRET = saved;
    }
  });

  it('GET /v1/sessions when empty', async () => {
    const list = await app.request('/v1/sessions');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it('intent on unknown session — 404', async () => {
    const res = await app.request('/v1/sessions/does-not-exist/intent', {
      method: 'POST',
      body: JSON.stringify({ intent: 'goto', payload: { url: targetUrl } }),
    });
    expect(res.status).toBe(404);
  });

  it('screenshot path traversal — rejects', async () => {
    // Hono's path matcher normalizes `..` segments out of `:f`, so the literal
    // dotted file won't match the route → 404. The percent-encoded form keeps
    // the unsafe characters intact and exercises the guard → 400.
    const res = await app.request('/v1/static/screenshots/..%2Fetc%2Fpasswd');
    expect([400, 404]).toContain(res.status);
  });

  it('intent payload missing intent field — 400', async () => {
    const res = await app.request('/v1/sessions/anything/intent', {
      method: 'POST',
      body: JSON.stringify({ payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('intent payload invalid JSON — 400', async () => {
    const res = await app.request('/v1/sessions/anything/intent', {
      method: 'POST',
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});

/**
 * Live block — boots Chromium and a Stagehand instance. ~$0.01/run in
 * Anthropic spend. Skipped without ANTHROPIC_API_KEY.
 */
describe.skipIf(liveSkip)('Stagehand HTTP service — LIVE', () => {
  beforeEach(async () => {
    await pool.closeAll();
  });

  it('creates a session, does goto, gets a screenshot URL', { timeout: 90_000 }, async () => {
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 't1' }),
    });
    expect(create.status).toBe(200);
    const { sessionId } = (await create.json()) as { sessionId: string };

    const list = await app.request('/v1/sessions');
    expect(((await list.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);

    const intent = await app.request(`/v1/sessions/${sessionId}/intent`, {
      method: 'POST',
      body: JSON.stringify({ intent: 'goto', payload: { url: targetUrl } }),
    });
    expect(intent.status).toBe(200);
    const out = (await intent.json()) as {
      ok: boolean;
      result: { title: string; url: string };
      screenshotUrl: string;
    };
    expect(out.ok).toBe(true);
    expect(out.result.title).toBe('Test Page');
    expect(out.screenshotUrl).toMatch(/^\/v1\/static\/screenshots\//);

    // Round-trip the archived screenshot — proves both write + serve work.
    const png = await app.request(out.screenshotUrl);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const bytes = await png.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(100);

    const del = await app.request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
  });

  it('act + extract roundtrip', { timeout: 120_000 }, async () => {
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 't2' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    await app.request(`/v1/sessions/${sessionId}/intent`, {
      method: 'POST',
      body: JSON.stringify({ intent: 'goto', payload: { url: targetUrl } }),
    });
    const act = await app.request(`/v1/sessions/${sessionId}/intent`, {
      method: 'POST',
      body: JSON.stringify({
        intent: 'act',
        payload: { instruction: 'Click the "Continue" link' },
      }),
    });
    expect(act.status).toBe(200);
    const actOut = (await act.json()) as { ok: boolean };
    expect(actOut.ok).toBe(true);

    // After the click, the h1 should read "Clicked OK". Extract is the cleanest
    // way to verify navigation without coupling to selectors.
    const verify = await app.request(`/v1/sessions/${sessionId}/intent`, {
      method: 'POST',
      body: JSON.stringify({
        intent: 'extract',
        payload: { instruction: 'Get the heading text', schema: { heading: 'string' } },
      }),
    });
    const verifyOut = (await verify.json()) as { ok: boolean; result: { heading: string } };
    expect(verifyOut.ok).toBe(true);
    expect(verifyOut.result.heading).toMatch(/Clicked/i);

    await app.request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
  });

  it('live GET /v1/sessions/:id/screenshot returns PNG', { timeout: 90_000 }, async () => {
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 't3' }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    await app.request(`/v1/sessions/${sessionId}/intent`, {
      method: 'POST',
      body: JSON.stringify({ intent: 'goto', payload: { url: targetUrl } }),
    });

    const shot = await app.request(`/v1/sessions/${sessionId}/screenshot`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');

    await app.request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
  });
});
