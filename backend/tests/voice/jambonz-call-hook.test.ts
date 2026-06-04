/**
 * Jambonz call-hook route tests (M10).
 *
 * Pure HTTP unit (no DB/Redis) — exercises the Hono router directly. Asserts:
 *   - the returned jambonz application JSON (the `listen` verb + bridge config)
 *   - the per-call metadata is threaded from the URL query into the verb
 *   - metadata can fall back to the POSTed `tag`/`customerData`
 *   - the shared path token gates access (404 on mismatch, ok when omitted)
 *   - missing/invalid metadata → 400
 */
import { describe, it, expect } from 'vitest';
import { buildJambonzCallHookRouter, buildListenApp } from '../../src/http/jambonz-call-hook.js';

const META = {
  sessionId: 'voice-sess-1',
  leadId: '11111111-1111-4111-a111-111111111111',
  customerId: '22222222-2222-4222-b222-222222222222',
  callId: '33333333-3333-4333-8333-333333333333',
};
const WS_URL = 'ws://pipecat:8765/voice/ws';
const TOKEN = 'hook-tok';

function query(): string {
  return new URLSearchParams(META).toString();
}

describe('buildListenApp', () => {
  it('produces a single bidirectional listen verb with metadata', () => {
    const app = buildListenApp(WS_URL, META);
    expect(app).toHaveLength(1);
    const verb = app[0] as Record<string, unknown>;
    expect(verb.verb).toBe('listen');
    expect(verb.url).toBe(WS_URL);
    expect(verb.mixType).toBe('mono');
    expect(verb.sampleRate).toBe(16000);
    expect(verb.bidirectionalAudio).toEqual({
      enabled: true,
      streaming: true,
      sampleRate: 16000,
    });
    expect(verb.metadata).toEqual(META);
  });
});

describe('POST /v1/voice/jambonz/call-hook/:token', () => {
  it('returns the listen app from URL-query metadata (200)', async () => {
    const app = buildJambonzCallHookRouter({ voiceWsUrl: WS_URL, callHookToken: TOKEN });
    const res = await app.request(`/v1/voice/jambonz/call-hook/${TOKEN}?${query()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Array<Record<string, unknown>>;
    expect(j).toHaveLength(1);
    expect(j[0]!.verb).toBe('listen');
    expect(j[0]!.url).toBe(WS_URL);
    expect(j[0]!.metadata).toEqual(META);
  });

  it('falls back to the POSTed customerData when query is absent', async () => {
    const app = buildJambonzCallHookRouter({ voiceWsUrl: WS_URL, callHookToken: TOKEN });
    const res = await app.request(`/v1/voice/jambonz/call-hook/${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call_sid: 'x', customerData: META }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Array<Record<string, unknown>>;
    expect(j[0]!.metadata).toEqual(META);
  });

  it('404s when the path token does not match', async () => {
    const app = buildJambonzCallHookRouter({ voiceWsUrl: WS_URL, callHookToken: TOKEN });
    const res = await app.request(`/v1/voice/jambonz/call-hook/wrong-token?${query()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('400s when metadata is missing/invalid (bad uuid)', async () => {
    const app = buildJambonzCallHookRouter({ voiceWsUrl: WS_URL, callHookToken: TOKEN });
    const bad = new URLSearchParams({ ...META, leadId: 'not-a-uuid' }).toString();
    const res = await app.request(`/v1/voice/jambonz/call-hook/${TOKEN}?${bad}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('skips the token check in dev (no token configured)', async () => {
    const app = buildJambonzCallHookRouter({ voiceWsUrl: WS_URL });
    const res = await app.request(`/v1/voice/jambonz/call-hook/anything?${query()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('accepts GET (defensive probe) with valid token + metadata', async () => {
    const app = buildJambonzCallHookRouter({ voiceWsUrl: WS_URL, callHookToken: TOKEN });
    const res = await app.request(`/v1/voice/jambonz/call-hook/${TOKEN}?${query()}`, {
      method: 'GET',
    });
    expect(res.status).toBe(200);
  });
});
