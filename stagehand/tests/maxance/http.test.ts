/**
 * HTTP-layer tests for `/v1/maxance/login` and `/v1/maxance/2fa-code` (M8.T2).
 *
 * The pool's session.stagehand is monkey-patched into a scripted stub so we
 * can hit `loginMaxance` through the real Hono routes without booting
 * Chromium or paying Anthropic tokens. The pool.create() path is also
 * stubbed for the same reason.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../../src/index.js';
import { pool } from '../../src/browser-pool.js';
import type { MaxancePageType } from '../../src/maxance/types.js';

const ORIGINAL_ENV = { ...process.env };
let dataDir: string;

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Drop a fake session directly into the pool with a scripted Stagehand stub.
 * Bypasses the `pool.create` Chromium launch.
 */
function plantSession(
  name: string,
  extractResponses: MaxancePageType[],
): { sessionId: string; restore: () => void } {
  const sessionId = `stub-${name}-${Date.now()}`;
  const calls: { instruction: string }[] = [];
  const fakePage = {
    goto: async () => undefined,
    url: () => 'https://www.maxance.com/Proximeo/home',
    title: async () => 'stub',
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };
  const fakeStagehand = {
    context: { activePage: () => fakePage },
    extract: async () => {
      const next = extractResponses.shift();
      if (!next) throw new Error('out of scripted responses');
      return { pageType: next };
    },
    act: async (instruction: string) => {
      calls.push({ instruction });
    },
    close: async () => undefined,
  };

  // Mirror the PooledSession shape — `pool` is a singleton so we mutate its
  // internal map. The cast keeps the test honest about poking into internals.
  const internal = pool as unknown as {
    sessions: Map<
      string,
      {
        sessionId: string;
        name: string;
        createdAt: Date;
        stagehand: unknown;
        busy: boolean;
        dataDir: string;
      }
    >;
  };
  internal.sessions.set(sessionId, {
    sessionId,
    name,
    createdAt: new Date(),
    stagehand: fakeStagehand,
    busy: false,
    dataDir: dataDir,
  });

  return {
    sessionId,
    restore: () => {
      internal.sessions.delete(sessionId);
    },
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'f16-maxance-http-'));
  process.env.STAGEHAND_DATA_DIR = dataDir;
  process.env.MAXANCE_USERNAME = 'test-broker.FAKE123';
  process.env.MAXANCE_PASSWORD = 'p@ssw0rd-test-only';
  process.env.MAXANCE_BASE_URL = 'https://extranet.maxance.com/MaXance/';
});

beforeEach(async () => {
  await pool.closeAll().catch(() => undefined);
});

afterEach(async () => {
  await pool.closeAll().catch(() => undefined);
});

afterEach(() => {
  for (const k of [
    'STAGEHAND_HMAC_SECRET',
    'MAXANCE_USERNAME',
    'MAXANCE_PASSWORD',
    'MAXANCE_BASE_URL',
  ]) {
    if (ORIGINAL_ENV[k] === undefined && process.env[k] !== undefined) {
      // restore only after the test block tears down
    }
  }
});

describe('POST /v1/maxance/login — happy path', () => {
  it('reuses existing session by name', async () => {
    const planted = plantSession('maxance-default', ['dashboard', 'proximeo_home']);
    try {
      const res = await app.request('/v1/maxance/login', {
        method: 'POST',
        body: JSON.stringify({ sessionName: 'maxance-default' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionId: string;
        alreadyLoggedIn: boolean;
        screenshots: unknown[];
      };
      expect(body.sessionId).toBe(planted.sessionId);
      expect(body.alreadyLoggedIn).toBe(true);
      expect(body.screenshots.length).toBeGreaterThanOrEqual(2);
    } finally {
      planted.restore();
    }
  });

  it('returns 500 with sanitised error on login failure', async () => {
    const planted = plantSession('maxance-fail', ['login_form', 'password_form', 'login_form']);
    try {
      const res = await app.request('/v1/maxance/login', {
        method: 'POST',
        body: JSON.stringify({ sessionName: 'maxance-fail' }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/maxance_bad_credentials/);
      // No creds in the response.
      expect(body.error).not.toContain('p@ssw0rd-test-only');
      expect(body.error).not.toContain('test-broker.FAKE123');
    } finally {
      planted.restore();
    }
  });
});

describe('POST /v1/maxance/login — HMAC', () => {
  it('bad signature → 401', async () => {
    process.env.STAGEHAND_HMAC_SECRET = 'test-secret-hmac';
    try {
      const res = await app.request('/v1/maxance/login', {
        method: 'POST',
        headers: { 'x-stagehand-signature': 'sha256=baadf00d' },
        body: JSON.stringify({ sessionName: 'whatever' }),
      });
      expect(res.status).toBe(401);
    } finally {
      delete process.env.STAGEHAND_HMAC_SECRET;
    }
  });

  it('valid signature → passes auth', async () => {
    process.env.STAGEHAND_HMAC_SECRET = 'test-secret-hmac';
    const planted = plantSession('maxance-hmac', ['dashboard', 'proximeo_home']);
    try {
      const body = JSON.stringify({ sessionName: 'maxance-hmac' });
      const res = await app.request('/v1/maxance/login', {
        method: 'POST',
        headers: { 'x-stagehand-signature': sign('test-secret-hmac', body) },
        body,
      });
      expect(res.status).toBe(200);
    } finally {
      planted.restore();
      delete process.env.STAGEHAND_HMAC_SECRET;
    }
  });
});

describe('POST /v1/maxance/2fa-code', () => {
  it('no pending prompt → 404', async () => {
    const res = await app.request('/v1/maxance/2fa-code', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'nobody', code: '123456' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no_pending_2fa');
  });

  it('missing fields → 400', async () => {
    const res = await app.request('/v1/maxance/2fa-code', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('resolves a pending prompt end-to-end', async () => {
    const planted = plantSession('maxance-2fa', [
      'login_form',
      'password_form',
      'sms_prompt',
      'dashboard',
      'proximeo_home',
    ]);
    try {
      // Kick off the login in the background; it will park on the 2FA prompt.
      const loginPromise = app.request('/v1/maxance/login', {
        method: 'POST',
        body: JSON.stringify({ sessionName: 'maxance-2fa' }),
      });

      // Poll until the pending2fa entry shows up. Implementation detail —
      // simpler than rigging a real event bus for the test.
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const probe = await app.request('/v1/maxance/2fa-code', {
          method: 'POST',
          body: JSON.stringify({ sessionId: planted.sessionId, code: '987654' }),
        });
        if (probe.status === 200) {
          const accept = (await probe.json()) as { accepted: boolean };
          expect(accept.accepted).toBe(true);
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const loginRes = await loginPromise;
      expect(loginRes.status).toBe(200);
      const body = (await loginRes.json()) as { requiredHumanAction: boolean };
      expect(body.requiredHumanAction).toBe(true);
    } finally {
      planted.restore();
    }
  });
});

describe('No-op fixture to keep vitest happy when other describes are skipped', () => {
  it('imports cleanly', () => {
    expect(typeof app.request).toBe('function');
  });
});

// Silence noisy console warnings from intentionally-failing tests.
vi.spyOn(console, 'warn').mockImplementation(() => undefined);
vi.spyOn(console, 'error').mockImplementation(() => undefined);
