/* eslint-disable no-console -- standalone ops helper. */
/**
 * Reset a LAUNCH_FAILED campaign draft back to DRAFT so the running approval
 * scanner re-launches it (its approve resolution is still on record). Used to
 * retry a launch after fixing an external blocker (e.g. Lead Ads ToS).
 *
 *   npx tsx scripts/reset-draft.ts <campaignId>
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/db/index.js';

const id = process.argv[2];
if (!id) {
  console.error('usage: reset-draft <campaignId>');
  process.exit(1);
}
const db = createDb(process.env.DATABASE_URL as string);
(async () => {
  await db.execute(
    sql`UPDATE campaigns SET status='DRAFT', updated_at=now() WHERE id=${id} AND status IN ('LAUNCH_FAILED','REVISING')`,
  );
  console.log(
    `campaign ${id} reset to DRAFT — the approval scanner will re-launch on its next tick.`,
  );
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
