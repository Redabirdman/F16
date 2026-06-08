/* eslint-disable no-console, @typescript-eslint/no-non-null-assertion -- standalone test/ops driver. */
/**
 * End-to-end test of the M12 Phase-3 draft → approve → launch flow (PAUSED).
 *
 *   npx tsx scripts/test-campaign-draft.ts [leadFormId]
 *
 * Assembles a campaign draft from existing creatives (fear/value/speed),
 * approves it directly (simulating Ridaa's WhatsApp approval), runs the
 * approval scanner which creates the campaign/adset/creative/ad PAUSED on Meta,
 * then prints the resulting Meta campaign id. Nothing spends (all PAUSED).
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/index.js';
import { MetaGraphClient } from '../src/integrations/meta/client.js';
import { campaigns } from '../src/db/schema/index.js';
import {
  assembleCampaignDraft,
  scanDraftApprovals,
} from '../src/agents/ads-manager-agent/index.js';
import { resolveAction } from '../src/db/repositories/human-actions.js';

const db = createDb(process.env.DATABASE_URL!);
const client = new MetaGraphClient({
  accessToken: process.env.META_SYSTEM_USER_TOKEN!,
  appSecret: process.env.META_APP_SECRET,
  apiVersion: process.env.META_GRAPH_API_VERSION,
});
const adAccountId = process.env.META_AD_ACCOUNT_ID!;
const pageId = process.env.META_PAGE_ID!;
const leadFormId = process.argv[2] ?? '4169806926486850';

(async () => {
  console.log('1) assembling draft (fear/value/speed, $50/day, FR)…');
  const draft = await assembleCampaignDraft({
    db,
    angles: ['fear', 'value', 'speed'],
    dailyBudgetCents: 5000,
    currency: 'USD',
    leadFormId,
  });
  console.log('   draft:', draft);

  console.log('2) approving (simulating WhatsApp approval)…');
  await resolveAction(db, draft.humanActionId, {
    chosenOption: { id: 'approve', label: 'Approuver', kind: 'approve' },
    by: 'test-script',
    source: 'admin',
  });

  console.log('3) running approval scanner → launching PAUSED on Meta…');
  const res = await scanDraftApprovals({
    db,
    client,
    adAccountId,
    pageId,
    dsaBeneficiary: 'Assuryal',
    dsaPayor: 'Assuryal',
  });
  console.log('   scan result:', res);

  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, draft.draftCampaignId));
  console.log('4) launched campaign row:', {
    status: row?.status,
    metaCampaignId: row?.metaCampaignId,
  });
  process.exit(0);
})().catch((e) => {
  console.error('test failed:', e);
  process.exit(1);
});
