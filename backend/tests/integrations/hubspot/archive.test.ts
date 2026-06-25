/**
 * HubSpotClient.archiveContactByPhoneOrEmail unit tests (M8-sim).
 *
 * Pure unit tests — no DB, no network. We inject `fetchImpl` (the ctor's
 * test-injection point) so every HTTP call returns a canned `Response`; the
 * client never reaches api.hubapi.com. The token is a fake string.
 */
import { describe, it, expect, vi } from 'vitest';
import { HubSpotClient } from '../../../src/integrations/hubspot/client.js';

function clientWithFetch(fetchImpl: typeof fetch): HubSpotClient {
  return new HubSpotClient({ accessToken: 'pat-test', fetchImpl });
}

describe('archiveContactByPhoneOrEmail', () => {
  it('searches by phone, archives the contact + its deals, returns archived', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? 'GET' });
      if (u.includes('/contacts/search')) {
        return new Response(JSON.stringify({ results: [{ id: '111' }] }), { status: 200 });
      }
      if (u.includes('/associations/')) {
        return new Response(JSON.stringify({ results: [{ toObjectId: '999' }] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const res = await clientWithFetch(fetchImpl).archiveContactByPhoneOrEmail({
      phone: '+33600000111',
    });
    expect(res).toBe('archived');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/deals/999'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/contacts/111'))).toBe(true);
  });

  it('falls back to email when no phone is given', async () => {
    let searchBody: unknown;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/contacts/search')) {
        searchBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(JSON.stringify({ results: [{ id: '222' }] }), { status: 200 });
      }
      if (u.includes('/associations/')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const res = await clientWithFetch(fetchImpl).archiveContactByPhoneOrEmail({
      email: 'achraf@example.com',
    });
    expect(res).toBe('archived');
    expect(searchBody).toMatchObject({
      filterGroups: [{ filters: [{ propertyName: 'email', value: 'achraf@example.com' }] }],
    });
  });

  it('returns not_found when search has no results', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(
      await clientWithFetch(fetchImpl).archiveContactByPhoneOrEmail({ phone: '+33600000111' }),
    ).toBe('not_found');
  });

  it('returns not_found when neither phone nor email is given', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await clientWithFetch(fetchImpl).archiveContactByPhoneOrEmail({})).toBe('not_found');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns error (never throws) when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    expect(
      await clientWithFetch(fetchImpl).archiveContactByPhoneOrEmail({ phone: '+33600000111' }),
    ).toBe('error');
  });
});
