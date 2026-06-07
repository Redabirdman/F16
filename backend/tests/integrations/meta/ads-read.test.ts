/**
 * Meta ads-read parsing + paging tests (M12 Phase 2) — pure, no DB.
 */
import { describe, it, expect } from 'vitest';
import { MetaGraphClient } from '../../../src/integrations/meta/client.js';
import {
  listCampaigns,
  listAdsets,
  getAdInsights,
} from '../../../src/integrations/meta/ads-read.js';

function stub(responder: (url: string, n: number) => { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const { status, body } = responder(url, urls.length);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('listCampaigns', () => {
  it('parses budgets to cents + times to Dates', async () => {
    const { fetchImpl } = stub(() => ({
      status: 200,
      body: {
        data: [
          {
            id: 'C1',
            name: 'Trottinette Leads',
            objective: 'OUTCOME_LEADS',
            status: 'ACTIVE',
            daily_budget: '5000',
            start_time: '2026-06-01T00:00:00+0000',
          },
        ],
      },
    }));
    const client = new MetaGraphClient({ accessToken: 'T', fetchImpl, sleepMs: noSleep });
    const rows = await listCampaigns(client, '123');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metaCampaignId).toBe('C1');
    expect(rows[0]!.objective).toBe('OUTCOME_LEADS');
    expect(rows[0]!.dailyBudgetCents).toBe(5000n);
    expect(rows[0]!.startedAt).toBeInstanceOf(Date);
  });
});

describe('getAllData paging', () => {
  it('follows paging.cursors.after until exhausted', async () => {
    const { fetchImpl, urls } = stub((_url, n) =>
      n === 1
        ? {
            status: 200,
            body: {
              data: [{ id: 'AS1', name: 'a', campaign_id: 'C1' }],
              paging: { cursors: { after: 'CURSOR2' }, next: 'https://next' },
            },
          }
        : { status: 200, body: { data: [{ id: 'AS2', name: 'b', campaign_id: 'C1' }] } },
    );
    const client = new MetaGraphClient({ accessToken: 'T', fetchImpl, sleepMs: noSleep });
    const rows = await listAdsets(client, '123');
    expect(rows.map((r) => r.metaAdsetId)).toEqual(['AS1', 'AS2']);
    // Second request carried the cursor.
    expect(urls[1]).toContain('after=CURSOR2');
  });
});

describe('getAdInsights', () => {
  it('normalizes ctr (% → fraction), spend (→ cents), and lead actions', async () => {
    const { fetchImpl } = stub(() => ({
      status: 200,
      body: {
        data: [
          {
            ad_id: 'AD1',
            impressions: '1000',
            clicks: '50',
            ctr: '5.0',
            spend: '12.34',
            reach: '800',
            frequency: '1.25',
            actions: [
              { action_type: 'lead', value: '3' },
              { action_type: 'link_click', value: '50' },
            ],
          },
        ],
      },
    }));
    const client = new MetaGraphClient({ accessToken: 'T', fetchImpl, sleepMs: noSleep });
    const ins = await getAdInsights(client, '123', { datePreset: 'today' });
    expect(ins).toHaveLength(1);
    const r = ins[0]!;
    expect(r.metaAdId).toBe('AD1');
    expect(r.impressions).toBe(1000);
    expect(r.clicks).toBe(50);
    expect(r.ctr).toBeCloseTo(0.05, 5);
    expect(r.spendCents).toBe(1234n);
    expect(r.reach).toBe(800);
    expect(r.frequency).toBeCloseTo(1.25, 5);
    expect(r.conversions).toBe(3); // only the 'lead' action counts
  });

  it('handles a decimal spend with one fractional digit', async () => {
    const { fetchImpl } = stub(() => ({
      status: 200,
      body: { data: [{ ad_id: 'AD2', spend: '7.5', impressions: '0' }] },
    }));
    const client = new MetaGraphClient({ accessToken: 'T', fetchImpl, sleepMs: noSleep });
    const ins = await getAdInsights(client, '123');
    expect(ins[0]!.spendCents).toBe(750n);
    expect(ins[0]!.ctr).toBeNull(); // no clicks/ctr
  });
});
