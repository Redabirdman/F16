/**
 * Jambonz REST client tests (M10).
 *
 * Pure unit — no DB, no Redis, no network. We inject a fake `fetchImpl` and
 * assert the EXACT createCall POST shape: URL, Bearer auth header, and the
 * body (from / to.{type,number,trunk} / call_hook.url+method / tag). Also
 * covers the call-hook URL builder (token in path + metadata in query) and
 * the error paths (non-2xx, missing sid, transport throw).
 */
import { describe, it, expect } from 'vitest';
import {
  JambonzClient,
  buildCallHookUrl,
  jambonzClientFromEnv,
  type FetchLike,
  type CallMetadata,
  type JambonzClientConfig,
} from '../../src/voice/jambonz-client.js';

const META: CallMetadata = {
  sessionId: 'voice-sess-1',
  leadId: '11111111-1111-4111-a111-111111111111',
  customerId: '22222222-2222-4222-b222-222222222222',
  callId: '33333333-3333-4333-8333-333333333333',
};

function baseCfg(overrides: Partial<JambonzClientConfig> = {}): JambonzClientConfig {
  return {
    baseUrl: 'https://jambonz.example.com',
    apiKey: 'jb-secret-key',
    accountSid: 'acc-sid-123',
    sipTrunk: 'ovh-trunk',
    voiceWsUrl: 'ws://pipecat:8765/voice/ws',
    outboundFrom: '+33184162750',
    callHookBaseUrl: 'https://api.f16.example.com',
    callHookToken: 'hook-tok',
    ...overrides,
  };
}

/** Records the single fetch call + returns a configurable response. */
function recordingFetch(resp: { status: number; ok?: boolean; body: string }): {
  fetch: FetchLike;
  calls: Array<{ url: string; init: Parameters<FetchLike>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      status: resp.status,
      ok: resp.ok ?? resp.status < 300,
      text: async () => resp.body,
    };
  };
  return { fetch, calls };
}

describe('JambonzClient.originateCall', () => {
  it('POSTs the exact createCall shape with Bearer auth', async () => {
    const { fetch, calls } = recordingFetch({
      status: 201,
      body: JSON.stringify({ sid: 'call-sid-999' }),
    });
    const client = new JambonzClient(baseCfg({ fetchImpl: fetch }));

    const res = await client.originateCall({ to: '+33612345678', metadata: META });

    expect(res.callSid).toBe('call-sid-999');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;

    // URL: {baseUrl}/v1/Accounts/{accountSid}/Calls
    expect(url).toBe('https://jambonz.example.com/v1/Accounts/acc-sid-123/Calls');
    expect(init.method).toBe('POST');
    // Bearer auth header.
    expect(init.headers.authorization).toBe('Bearer jb-secret-key');
    expect(init.headers['content-type']).toBe('application/json');

    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.from).toBe('+33184162750');
    expect(body.to).toEqual({ type: 'phone', number: '+33612345678', trunk: 'ovh-trunk' });

    const callHook = body.call_hook as { url: string; method: string };
    expect(callHook.method).toBe('POST');
    // call_hook URL carries the token in the path + metadata in the query.
    expect(callHook.url).toContain(
      'https://api.f16.example.com/v1/voice/jambonz/call-hook/hook-tok',
    );
    expect(callHook.url).toContain(`sessionId=${encodeURIComponent(META.sessionId)}`);
    expect(callHook.url).toContain(`leadId=${META.leadId}`);
    expect(callHook.url).toContain(`callId=${META.callId}`);

    // tag echoes the metadata back to the webhook as customerData.
    expect(body.tag).toEqual({
      sessionId: META.sessionId,
      leadId: META.leadId,
      customerId: META.customerId,
      callId: META.callId,
    });
  });

  it('honours a per-call `from` override', async () => {
    const { fetch, calls } = recordingFetch({ status: 201, body: JSON.stringify({ sid: 's' }) });
    const client = new JambonzClient(baseCfg({ fetchImpl: fetch }));
    await client.originateCall({ to: '+33600000000', metadata: META, from: '+33999999999' });
    const body = JSON.parse(calls[0]!.init.body) as { from: string };
    expect(body.from).toBe('+33999999999');
  });

  it('throws a tagged error on non-2xx (and does not leak the number)', async () => {
    const { fetch } = recordingFetch({ status: 422, ok: false, body: '{"msg":"bad trunk"}' });
    const client = new JambonzClient(baseCfg({ fetchImpl: fetch }));
    await expect(client.originateCall({ to: '+33611111111', metadata: META })).rejects.toThrow(
      'jambonz_create_call_failed_422',
    );
  });

  it('throws when the 201 body has no sid', async () => {
    const { fetch } = recordingFetch({ status: 201, body: '{}' });
    const client = new JambonzClient(baseCfg({ fetchImpl: fetch }));
    await expect(client.originateCall({ to: '+33611111111', metadata: META })).rejects.toThrow(
      'jambonz_create_call_no_sid',
    );
  });

  it('throws a transport error when fetch rejects', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = new JambonzClient(baseCfg({ fetchImpl: fetch }));
    await expect(client.originateCall({ to: '+33611111111', metadata: META })).rejects.toThrow(
      'jambonz_create_call_transport_error',
    );
  });

  it('validates required config at construction', () => {
    expect(() => new JambonzClient(baseCfg({ apiKey: '' }))).toThrow('apiKey required');
    expect(() => new JambonzClient(baseCfg({ sipTrunk: '' }))).toThrow('sipTrunk required');
  });
});

describe('buildCallHookUrl', () => {
  it('embeds the token in the path and metadata in the query', () => {
    const url = buildCallHookUrl(baseCfg(), META);
    expect(url.startsWith('https://api.f16.example.com/v1/voice/jambonz/call-hook/hook-tok?')).toBe(
      true,
    );
    const u = new URL(url);
    expect(u.searchParams.get('sessionId')).toBe(META.sessionId);
    expect(u.searchParams.get('leadId')).toBe(META.leadId);
    expect(u.searchParams.get('customerId')).toBe(META.customerId);
    expect(u.searchParams.get('callId')).toBe(META.callId);
  });

  it('strips a trailing slash on the base URL', () => {
    const url = buildCallHookUrl(
      baseCfg({ callHookBaseUrl: 'https://api.f16.example.com/' }),
      META,
    );
    expect(url).not.toContain('.com//v1');
  });
});

describe('jambonzClientFromEnv', () => {
  const KEYS = [
    'JAMBONZ_BASE_URL',
    'JAMBONZ_API_KEY',
    'JAMBONZ_ACCOUNT_SID',
    'JAMBONZ_SIP_TRUNK',
    'VOICE_WS_URL',
    'VOICE_OUTBOUND_FROM',
    'VOICE_CALL_HOOK_BASE_URL',
    'VOICE_CALL_HOOK_TOKEN',
  ] as const;

  it('returns null when env is incomplete', () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
    try {
      expect(jambonzClientFromEnv()).toBeNull();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = saved[k];
      }
    }
  });

  it('builds a client when every var is present', () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      JAMBONZ_BASE_URL: 'https://jb.example.com',
      JAMBONZ_API_KEY: 'k',
      JAMBONZ_ACCOUNT_SID: 'a',
      JAMBONZ_SIP_TRUNK: 't',
      VOICE_WS_URL: 'ws://p/voice/ws',
      VOICE_OUTBOUND_FROM: '+33184162750',
      VOICE_CALL_HOOK_BASE_URL: 'https://api.example.com',
      VOICE_CALL_HOOK_TOKEN: 'tok',
    });
    try {
      const client = jambonzClientFromEnv();
      expect(client).toBeInstanceOf(JambonzClient);
      expect(client?.voiceWsUrl).toBe('ws://p/voice/ws');
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = saved[k];
      }
    }
  });
});
