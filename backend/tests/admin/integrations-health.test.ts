/**
 * Admin integrations health (M14.T7) — pure unit tests with stubbed fetch.
 *
 * Each probe runs through a single fake fetch; we verify the URLs hit, the
 * status taxonomy is correct (ok / unconfigured / unreachable / degraded),
 * and env-presence probes report `ok` only when the env var is set.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminIntegrationsRouter } from '../../src/admin/integrations-health.js';

interface FakeResponse {
  url: string;
  status: number;
  body?: unknown;
}

function makeFetch(responses: Record<string, FakeResponse | Error>): typeof fetch {
  return (async (url: string | URL | Request): Promise<Response> => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const match = Object.entries(responses).find(([prefix]) => u.startsWith(prefix));
    if (!match) throw new Error(`unstubbed_fetch: ${u}`);
    const r = match[1];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const ENV_KEYS = [
  'WAHA_BASE_URL',
  'WAHA_API_KEY',
  'WAHA_SESSION',
  'HUBSPOT_API_KEY',
  'ASTERISK_OVH_TRUNK',
  'MAXANCE_DRIVER',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'BILLIONMAIL_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_WEBHOOK_SECRET',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('GET /v1/admin/integrations/health', () => {
  it('marks every integration unconfigured when no env vars are set', async () => {
    const app = buildAdminIntegrationsRouter({ fetchImpl: makeFetch({}) });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string }>;
    };
    expect(body.integrations.length).toBeGreaterThan(0);
    for (const i of body.integrations) {
      expect(i.status).toBe('unconfigured');
    }
  });

  it('returns ok for WAHA when the session is WORKING', async () => {
    process.env.WAHA_BASE_URL = 'http://127.0.0.1:3000';
    const app = buildAdminIntegrationsRouter({
      fetchImpl: makeFetch({
        'http://127.0.0.1:3000/api/sessions/default': {
          url: '',
          status: 200,
          body: { status: 'WORKING' },
        },
      }),
    });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string }>;
    };
    const waha = body.integrations.find((i) => i.name === 'waha');
    expect(waha?.status).toBe('ok');
  });

  it('returns degraded for WAHA when session is not WORKING', async () => {
    process.env.WAHA_BASE_URL = 'http://127.0.0.1:3000';
    const app = buildAdminIntegrationsRouter({
      fetchImpl: makeFetch({
        'http://127.0.0.1:3000/api/sessions/default': {
          url: '',
          status: 200,
          body: { status: 'SCAN_QR_CODE' },
        },
      }),
    });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string; detail?: string }>;
    };
    const waha = body.integrations.find((i) => i.name === 'waha');
    expect(waha?.status).toBe('degraded');
    expect(waha?.detail).toMatch(/SCAN_QR_CODE/);
  });

  it('returns unreachable for HubSpot when the API responds 401', async () => {
    process.env.HUBSPOT_API_KEY = 'pat-test';
    const app = buildAdminIntegrationsRouter({
      fetchImpl: makeFetch({
        'https://api.hubapi.com/': {
          url: '',
          status: 401,
        },
      }),
    });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string; detail?: string }>;
    };
    const hubspot = body.integrations.find((i) => i.name === 'hubspot');
    expect(hubspot?.status).toBe('unreachable');
    expect(hubspot?.detail).toMatch(/401/);
  });

  it('reports ok for env-presence probes when their env var is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const app = buildAdminIntegrationsRouter({ fetchImpl: makeFetch({}) });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string }>;
    };
    const anthropic = body.integrations.find((i) => i.name === 'anthropic');
    expect(anthropic?.status).toBe('ok');
  });

  it('marks voice unconfigured when ASTERISK_OVH_TRUNK is unset, and never surfaces pipecat', async () => {
    const app = buildAdminIntegrationsRouter({ fetchImpl: makeFetch({}) });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string }>;
    };
    const voice = body.integrations.find((i) => i.name === 'voice');
    expect(voice?.status).toBe('unconfigured');
    // The legacy Pipecat probe was removed — it must not appear at all.
    expect(body.integrations.some((i) => /pipecat/i.test(i.name))).toBe(false);
  });

  it('reports voice degraded (watchdog not reporting) when the OVH trunk is configured', async () => {
    process.env.ASTERISK_OVH_TRUNK = 'ovh-trunk';
    const app = buildAdminIntegrationsRouter({ fetchImpl: makeFetch({}) });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string; detail?: string; required?: boolean }>;
    };
    const voice = body.integrations.find((i) => i.name === 'voice');
    // No watchdog tick has run in this pure test → degraded + required.
    expect(voice?.status).toBe('degraded');
    expect(voice?.required).toBe(true);
    expect(voice?.detail).toMatch(/watchdog not reporting/);
  });

  it('reports openai_sip ok + signature ON when key + webhook secret are set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_WEBHOOK_SECRET = 'whsec_test';
    const app = buildAdminIntegrationsRouter({ fetchImpl: makeFetch({}) });
    const res = await app.request('/v1/admin/integrations/health');
    const body = (await res.json()) as {
      integrations: Array<{ name: string; status: string; detail?: string }>;
    };
    const sip = body.integrations.find((i) => i.name === 'openai_sip');
    expect(sip?.status).toBe('ok');
    expect(sip?.detail).toMatch(/signature verification ON/);
  });
});
