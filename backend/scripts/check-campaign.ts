/* eslint-disable no-console, @typescript-eslint/no-non-null-assertion -- ops check. */
import 'dotenv/config';
import { MetaGraphClient } from '../src/integrations/meta/client.js';

const client = new MetaGraphClient({
  accessToken: process.env.META_SYSTEM_USER_TOKEN!,
  appSecret: process.env.META_APP_SECRET,
  apiVersion: process.env.META_GRAPH_API_VERSION,
});
const id = process.argv[2]!;
(async () => {
  const c = await client.get(`/${id}`, {
    fields: 'name,status,effective_status,daily_budget,objective',
  });
  console.log('campaign:', JSON.stringify(c));
  const ins = await client.get<{ data?: unknown[] }>(`/${id}/insights`, {
    date_preset: 'maximum',
    fields: 'spend,impressions',
  });
  console.log('spend/insights:', JSON.stringify(ins.data ?? []));
  process.exit(0);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
