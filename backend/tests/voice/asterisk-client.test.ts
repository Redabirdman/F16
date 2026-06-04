/**
 * Asterisk ARI client tests.
 *
 * Pure unit — no DB, no Redis, no network. We inject a fake `fetchImpl` and
 * assert the EXACT POST /channels shape: URL, Basic auth header, and the body
 * (endpoint PJSIP/<num>@<trunk> / extension / context / priority / callerId /
 * timeout / variables.{AS_UUID,PIPECAT_HOST,PIPECAT_PORT}). Also covers the
 * error paths (non-2xx, missing channel id, transport throw), config
 * validation, and the PII guard (the dialed number / endpoint is never logged).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AsteriskAriClient,
  asteriskClientFromEnv,
  type FetchLike,
  type AsteriskAriConfig,
} from '../../src/voice/asterisk-client.js';
import { logger } from '../../src/logger.js';

const SESSION_ID = '11111111-1111-4111-a111-111111111111';

function baseCfg(overrides: Partial<AsteriskAriConfig> = {}): AsteriskAriConfig {
  return {
    ariUrl: 'http://localhost:8088/ari',
    ariUser: 'f16',
    ariPassword: 'ari-secret',
    trunk: 'ovh-trunk',
    dialplanContext: 'f16-dial',
    callerId: '+33184162750',
    audioSocketHost: '127.0.0.1',
    audioSocketPort: '9092',
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

describe('AsteriskAriClient.originateCall', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the exact ARI /channels shape with Basic auth', async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      body: JSON.stringify({ id: 'chan-9999.1', name: 'PJSIP/x' }),
    });
    const client = new AsteriskAriClient(baseCfg({ fetchImpl: fetch }));

    const res = await client.originateCall({ to: '+33612345678', sessionId: SESSION_ID });

    expect(res.channelId).toBe('chan-9999.1');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;

    // URL: {ariUrl}/channels
    expect(url).toBe('http://localhost:8088/ari/channels');
    expect(init.method).toBe('POST');
    // HTTP Basic auth: base64(user:password).
    expect(init.headers.authorization).toBe(
      'Basic ' + Buffer.from('f16:ari-secret').toString('base64'),
    );
    expect(init.headers['content-type']).toBe('application/json');

    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.endpoint).toBe('PJSIP/+33612345678@ovh-trunk');
    expect(body.extension).toBe('+33612345678');
    expect(body.context).toBe('f16-dial');
    expect(body.priority).toBe(1);
    expect(body.callerId).toBe('+33184162750');
    expect(body.timeout).toBe(30);
    expect(body.variables).toEqual({
      AS_UUID: SESSION_ID,
      PIPECAT_HOST: '127.0.0.1',
      PIPECAT_PORT: '9092',
    });
  });

  it('strips a trailing slash on the ARI base URL', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: JSON.stringify({ id: 'c' }) });
    const client = new AsteriskAriClient(
      baseCfg({ ariUrl: 'http://localhost:8088/ari/', fetchImpl: fetch }),
    );
    await client.originateCall({ to: '+33600000000', sessionId: SESSION_ID });
    expect(calls[0]!.url).toBe('http://localhost:8088/ari/channels');
  });

  it('honours a custom dial timeout', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: JSON.stringify({ id: 'c' }) });
    const client = new AsteriskAriClient(baseCfg({ timeout: 45, fetchImpl: fetch }));
    await client.originateCall({ to: '+33600000000', sessionId: SESSION_ID });
    expect((JSON.parse(calls[0]!.init.body) as { timeout: number }).timeout).toBe(45);
  });

  it('NEVER logs the dialed number or endpoint (PII guard)', async () => {
    const errSpy = vi.spyOn(logger, 'error');
    const infoSpy = vi.spyOn(logger, 'info');
    const { fetch } = recordingFetch({ status: 200, body: JSON.stringify({ id: 'chan-1' }) });
    const client = new AsteriskAriClient(baseCfg({ fetchImpl: fetch }));

    await client.originateCall({ to: '+33698765432', sessionId: SESSION_ID });

    const allLogArgs = JSON.stringify([...errSpy.mock.calls, ...infoSpy.mock.calls]);
    expect(allLogArgs).not.toContain('+33698765432');
    expect(allLogArgs).not.toContain('PJSIP/+33698765432');
  });

  it('does not leak the number on a non-2xx error', async () => {
    const errSpy = vi.spyOn(logger, 'error');
    const { fetch } = recordingFetch({ status: 503, ok: false, body: '{"message":"no trunk"}' });
    const client = new AsteriskAriClient(baseCfg({ fetchImpl: fetch }));
    await expect(
      client.originateCall({ to: '+33611111111', sessionId: SESSION_ID }),
    ).rejects.toThrow('asterisk_originate_failed_503');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('+33611111111');
  });

  it('throws when the 2xx body has no channel id', async () => {
    const { fetch } = recordingFetch({ status: 200, body: '{}' });
    const client = new AsteriskAriClient(baseCfg({ fetchImpl: fetch }));
    await expect(
      client.originateCall({ to: '+33611111111', sessionId: SESSION_ID }),
    ).rejects.toThrow('asterisk_originate_no_channel_id');
  });

  it('throws a transport error when fetch rejects', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = new AsteriskAriClient(baseCfg({ fetchImpl: fetch }));
    await expect(
      client.originateCall({ to: '+33611111111', sessionId: SESSION_ID }),
    ).rejects.toThrow('asterisk_originate_transport_error');
  });

  it('validates required config at construction', () => {
    expect(() => new AsteriskAriClient(baseCfg({ ariPassword: '' }))).toThrow(
      'ariPassword required',
    );
    expect(() => new AsteriskAriClient(baseCfg({ trunk: '' }))).toThrow('trunk required');
    expect(() => new AsteriskAriClient(baseCfg({ dialplanContext: '' }))).toThrow(
      'dialplanContext required',
    );
    expect(() => new AsteriskAriClient(baseCfg({ callerId: '' }))).toThrow('callerId required');
  });
});

describe('asteriskClientFromEnv', () => {
  const KEYS = [
    'ASTERISK_ARI_URL',
    'ASTERISK_ARI_USER',
    'ASTERISK_ARI_PASSWORD',
    'ASTERISK_OVH_TRUNK',
    'ASTERISK_DIALPLAN_CONTEXT',
    'VOICE_CALLER_ID',
    'AUDIOSOCKET_HOST',
    'AUDIOSOCKET_PORT',
  ] as const;

  function withSavedEnv(fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) saved[k] = process.env[k];
    try {
      for (const k of KEYS) Reflect.deleteProperty(process.env, k);
      fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = saved[k];
      }
    }
  }

  it('returns null when the no-default required vars are missing', () => {
    withSavedEnv(() => {
      // url/user/host/port have defaults; password/trunk/context/callerId do not.
      expect(asteriskClientFromEnv()).toBeNull();
    });
  });

  it('builds a client from the required vars (url/user/host/port default)', () => {
    withSavedEnv(() => {
      process.env.ASTERISK_ARI_PASSWORD = 'pw';
      process.env.ASTERISK_OVH_TRUNK = 'ovh-trunk';
      process.env.ASTERISK_DIALPLAN_CONTEXT = 'f16-dial';
      process.env.VOICE_CALLER_ID = '+33184162750';
      const client = asteriskClientFromEnv();
      expect(client).toBeInstanceOf(AsteriskAriClient);
    });
  });
});
