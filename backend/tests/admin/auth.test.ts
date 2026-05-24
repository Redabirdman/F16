/**
 * Admin auth middleware (M14.T1 lite) — pure unit tests, no DB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireAdminAuth } from '../../src/admin/auth.js';

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.ADMIN_BEARER_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.ADMIN_BEARER_TOKEN;
  else process.env.ADMIN_BEARER_TOKEN = savedToken;
});

function buildTestApp(): Hono {
  const app = new Hono();
  app.use('/v1/admin/*', requireAdminAuth());
  app.get('/v1/admin/test', (c) => c.json({ ok: true }));
  return app;
}

describe('requireAdminAuth — no token configured (dev mode)', () => {
  it('passes every request when ADMIN_BEARER_TOKEN is unset', async () => {
    delete process.env.ADMIN_BEARER_TOKEN;
    const app = buildTestApp();
    const res = await app.request('/v1/admin/test');
    expect(res.status).toBe(200);
  });
});

describe('requireAdminAuth — token configured', () => {
  beforeEach(() => {
    process.env.ADMIN_BEARER_TOKEN = 'super-secret-token';
  });

  it('401s requests without an Authorization header', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/admin/test');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toMatch(/Bearer/);
  });

  it('401s requests with a wrong token', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/admin/test', {
      headers: { Authorization: 'Bearer wrong-token-xxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(401);
  });

  it('200s requests with the correct bearer token', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/admin/test', {
      headers: { Authorization: 'Bearer super-secret-token' },
    });
    expect(res.status).toBe(200);
  });

  it('accepts ?token= query param as a fallback (for SSE + download URLs)', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/admin/test?token=super-secret-token');
    expect(res.status).toBe(200);
  });

  it('401s an empty bearer payload', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/admin/test', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(res.status).toBe(401);
  });
});
