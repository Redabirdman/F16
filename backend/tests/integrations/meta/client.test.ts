/**
 * MetaGraphClient unit tests (M12) — pure, no DB/network.
 *
 * The Graph API is stubbed via the `fetchImpl` + `sleepMs` injection seams, so
 * these run everywhere (no live gate).
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { MetaGraphClient, MetaApiError } from '../../../src/integrations/meta/client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Build a fetch stub from a per-call responder. Records every call. */
function stubFetch(
  responder: (call: RecordedCall, n: number) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? String(init.body) : null,
    };
    calls.push(call);
    const { status, body } = responder(call, calls.length);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('MetaGraphClient.getLeadgenData', () => {
  it('normalizes field_data + attribution chain', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: {
        id: 'LEAD123',
        created_time: '2026-06-07T10:00:00+0000',
        field_data: [
          { name: 'full_name', values: ['Jean Dupont'] },
          { name: 'email', values: ['jean@example.com'] },
          { name: 'phone_number', values: ['+33612345678'] },
        ],
        ad_id: 'AD1',
        ad_name: 'Trottinette Fear V1',
        adset_id: 'AS1',
        adset_name: 'France 25-45',
        campaign_id: 'C1',
        campaign_name: 'Trottinette Leads',
        form_id: 'F1',
        platform: 'fb',
      },
    }));
    const client = new MetaGraphClient({ accessToken: 'TKN', fetchImpl, sleepMs: noSleep });
    const lead = await client.getLeadgenData('LEAD123');

    expect(lead.id).toBe('LEAD123');
    expect(lead.fieldData).toHaveLength(3);
    expect(lead.fieldData[0]).toEqual({ name: 'full_name', values: ['Jean Dupont'] });
    expect(lead.campaignId).toBe('C1');
    expect(lead.campaignName).toBe('Trottinette Leads');
    expect(lead.adId).toBe('AD1');
    expect(lead.formId).toBe('F1');
    expect(lead.platform).toBe('fb');

    // Sends Bearer auth + requests field_data.
    expect(calls[0]!.headers['authorization']).toBe('Bearer TKN');
    expect(calls[0]!.url).toContain('field_data');
    expect(calls[0]!.url).toContain('/v21.0/LEAD123');
  });

  it('adds appsecret_proof when an app secret is configured', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: { id: 'x', field_data: [] },
    }));
    const client = new MetaGraphClient({
      accessToken: 'TKN',
      appSecret: 'SECRET',
      fetchImpl,
      sleepMs: noSleep,
    });
    await client.getLeadgenData('x');
    const expectedProof = createHmac('sha256', 'SECRET').update('TKN').digest('hex');
    expect(calls[0]!.url).toContain(`appsecret_proof=${expectedProof}`);
  });
});

describe('MetaGraphClient.del', () => {
  it('issues an HTTP DELETE to the given path with no body', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { success: true } }));
    const client = new MetaGraphClient({ accessToken: 'TKN', fetchImpl, sleepMs: noSleep });
    const res = await client.del<{ success: boolean }>('/120999');
    expect(res).toEqual({ success: true });
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/v21.0/120999');
    expect(calls[0]!.body).toBeNull();
    expect(calls[0]!.headers['authorization']).toBe('Bearer TKN');
  });
});

describe('MetaGraphClient retry', () => {
  it('retries on HTTP 500 then succeeds', async () => {
    const { fetchImpl, calls } = stubFetch((_c, n) =>
      n === 1
        ? { status: 500, body: { error: { message: 'boom' } } }
        : { status: 200, body: { id: 'ok', field_data: [] } },
    );
    const client = new MetaGraphClient({ accessToken: 'TKN', fetchImpl, sleepMs: noSleep });
    const lead = await client.getLeadgenData('ok');
    expect(lead.id).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('retries on a Graph throttling error code (4) returned with HTTP 400', async () => {
    const { fetchImpl, calls } = stubFetch((_c, n) =>
      n === 1
        ? { status: 400, body: { error: { code: 4, message: 'rate limit' } } }
        : { status: 200, body: { id: 'ok', field_data: [] } },
    );
    const client = new MetaGraphClient({ accessToken: 'TKN', fetchImpl, sleepMs: noSleep });
    await client.getLeadgenData('ok');
    expect(calls).toHaveLength(2);
  });

  it('throws MetaApiError on a non-retryable 4xx (token expired, code 190)', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 400,
      body: { error: { code: 190, type: 'OAuthException', message: 'token expired' } },
    }));
    const client = new MetaGraphClient({ accessToken: 'TKN', fetchImpl, sleepMs: noSleep });
    await expect(client.getLeadgenData('x')).rejects.toBeInstanceOf(MetaApiError);
    // No retry on a hard auth failure.
    expect(calls).toHaveLength(1);
    try {
      await client.getLeadgenData('x');
    } catch (err) {
      expect(err).toBeInstanceOf(MetaApiError);
      expect((err as MetaApiError).status).toBe(400);
      expect((err as MetaApiError).code).toBe(190);
    }
  });
});

describe('MetaGraphClient.healthCheck', () => {
  it('returns healthy on a /me with an id', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: { id: '123', name: 'Assuryal' } }));
    const client = new MetaGraphClient({ accessToken: 'TKN', fetchImpl, sleepMs: noSleep });
    expect(await client.healthCheck()).toEqual({ healthy: true });
  });

  it('returns unhealthy on an auth error', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: { error: { code: 190 } } }));
    const client = new MetaGraphClient({ accessToken: 'BAD', fetchImpl, sleepMs: noSleep });
    const res = await client.healthCheck();
    expect(res.healthy).toBe(false);
    expect(res.detail).toBeTruthy();
  });
});

describe('MetaGraphClient.subscribePageToLeadgen', () => {
  it('resolves a page token then POSTs subscribed_fields=leadgen with it', async () => {
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.method === 'GET' && call.url.includes('access_token')) {
        return { status: 200, body: { access_token: 'PAGETOKEN' } };
      }
      if (call.method === 'POST' && call.url.includes('/subscribed_apps')) {
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: { error: { message: 'unexpected' } } };
    });
    const client = new MetaGraphClient({
      accessToken: 'USERTKN',
      appSecret: 'SECRET',
      fetchImpl,
      sleepMs: noSleep,
    });
    const res = await client.subscribePageToLeadgen('PAGE1');
    expect(res.success).toBe(true);

    const post = calls.find((c) => c.method === 'POST')!;
    // POST uses the PAGE token, signed with the page token's appsecret_proof.
    expect(post.headers['authorization']).toBe('Bearer PAGETOKEN');
    expect(post.body).toContain('subscribed_fields=leadgen');
    const pageProof = createHmac('sha256', 'SECRET').update('PAGETOKEN').digest('hex');
    expect(post.url).toContain(`appsecret_proof=${pageProof}`);
  });
});
