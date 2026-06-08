/* eslint-disable no-console, @typescript-eslint/no-non-null-assertion -- ops listing. */
/**
 * Inspect / clean the Assuryal ad account.
 *
 *   npx tsx scripts/list-campaigns.ts                 # list campaigns/adsets/ads
 *   npx tsx scripts/list-campaigns.ts delete <id...>  # delete campaigns by id
 */
import 'dotenv/config';
import { MetaGraphClient } from '../src/integrations/meta/client.js';
import { deleteCampaign } from '../src/integrations/meta/ads-write.js';

const client = new MetaGraphClient({
  accessToken: process.env.META_SYSTEM_USER_TOKEN!,
  appSecret: process.env.META_APP_SECRET,
  apiVersion: process.env.META_GRAPH_API_VERSION,
});
const acct = (process.env.META_AD_ACCOUNT_ID ?? '').replace(/^act_/, '');

async function main(): Promise<void> {
  if (!acct) throw new Error('META_AD_ACCOUNT_ID not set');

  if (process.argv[2] === 'delete') {
    const ids = process.argv.slice(3);
    if (ids.length === 0) throw new Error('delete: pass at least one campaign id');
    for (const id of ids) {
      try {
        await deleteCampaign(client, id);
        console.log(`DELETED ${id}`);
      } catch (e) {
        console.error(`FAILED ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return;
  }

  const camps = await client.get<{ data?: Array<Record<string, string>> }>(
    `/act_${acct}/campaigns`,
    { fields: 'id,name,status,effective_status,created_time,daily_budget,objective', limit: '200' },
  );
  console.log(`\n=== CAMPAIGNS (${camps.data?.length ?? 0}) ===`);
  for (const c of camps.data ?? []) {
    const budget = c.daily_budget
      ? `$${(Number(c.daily_budget) / 100).toFixed(0)}/day`
      : 'no-budget';
    console.log(
      `${c.id}  [${c.status}]  ${budget}  ${c.objective}  "${c.name}"  ${c.created_time}`,
    );
  }

  const adsets = await client.get<{
    data?: Array<{ id: string; name: string; status: string; campaign_id: string }>;
  }>(`/act_${acct}/adsets`, { fields: 'id,name,status,campaign_id', limit: '200' });
  console.log(`\n=== ADSETS (${adsets.data?.length ?? 0}) ===`);
  for (const a of adsets.data ?? []) {
    console.log(`${a.id}  [${a.status}]  campaign=${a.campaign_id}  "${a.name}"`);
  }

  const ads = await client.get<{
    data?: Array<{
      id: string;
      name: string;
      status: string;
      campaign_id: string;
      adset_id: string;
    }>;
  }>(`/act_${acct}/ads`, { fields: 'id,name,status,campaign_id,adset_id', limit: '200' });
  console.log(`\n=== ADS (${ads.data?.length ?? 0}) ===`);
  for (const a of ads.data ?? []) {
    console.log(
      `${a.id}  [${a.status}]  campaign=${a.campaign_id}  adset=${a.adset_id}  "${a.name}"`,
    );
  }
}

main().then(
  () => setTimeout(() => process.exit(0), 100),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    setTimeout(() => process.exit(1), 100);
  },
);
