/* eslint-disable no-console, @typescript-eslint/no-non-null-assertion -- standalone ops driver. */
/**
 * Send ONE fresh campaign draft to WhatsApp for real approval (M12 Phase 3).
 * Cancels stale pending human-actions + lingering DRAFT campaigns first so the
 * inbound "approuver" resolves unambiguously, then assembles a fresh draft —
 * the running reporter agent WhatsApps Ridaa the summary + the 3 creatives.
 *
 *   npx tsx scripts/send-draft.ts [leadFormId]
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/db/index.js';
import { assembleCampaignDraft } from '../src/agents/ads-manager-agent/index.js';

const db = createDb(process.env.DATABASE_URL!);
const leadFormId = process.argv[2] ?? '4169806926486850';

(async () => {
  await db.execute(sql`UPDATE human_actions SET status='cancelled' WHERE status='pending'`);
  await db.execute(sql`UPDATE campaigns SET status='CANCELLED' WHERE status='DRAFT'`);
  console.log('cleared stale pending actions + draft campaigns');

  const draft = await assembleCampaignDraft({
    db,
    angles: ['fear', 'value', 'speed'],
    dailyBudgetCents: 5000,
    currency: 'USD',
    leadFormId,
  });
  console.log('fresh draft:', draft);
  console.log(
    '-> reporter is WhatsApping Ridaa the draft + 3 images. Reply "approuver" to launch.',
  );
  process.exit(0);
})().catch((e) => {
  console.error('send-draft failed:', e);
  process.exit(1);
});
