/**
 * Ad Expert — campaign launch (M12 Phase 3).
 *
 * Turns an APPROVED draft into real Meta objects, ALL PAUSED (zero spend until
 * a human activates them in Ads Manager). Reads the draft tree from the mirror,
 * creates campaign → adset → (upload image → creative) → ad on Meta, and writes
 * the real Meta ids + status='PAUSED' back onto the mirror rows so the poller
 * takes over from there.
 */
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { MetaGraphClient } from '../../integrations/meta/client.js';
import { campaigns, adsets, ads } from '../../db/schema/index.js';
import { getCampaignTree } from '../../db/repositories/ads.js';
import {
  createCampaign,
  createAdset,
  uploadAdImage,
  createLeadCreative,
  createAd,
} from '../../integrations/meta/ads-write.js';

export interface LaunchOptions {
  db: Database;
  client: MetaGraphClient;
  adAccountId: string;
  pageId: string;
  draftCampaignId: string;
  /** DSA (EU) beneficiary + payor — required for France. */
  dsaBeneficiary: string;
  dsaPayor: string;
  instagramUserId?: string;
}

export interface LaunchResult {
  metaCampaignId: string;
  metaAdsetId: string;
  ads: Array<{ adId: string; metaAdId: string; creativeId: string }>;
}

export async function launchCampaignDraft(opts: LaunchOptions): Promise<LaunchResult> {
  const { db, client, adAccountId, pageId } = opts;

  const tree = await getCampaignTree(db, opts.draftCampaignId);
  if (!tree) throw new Error(`launch: draft campaign ${opts.draftCampaignId} not found`);
  const adset = tree.adsets[0];
  if (!adset) throw new Error('launch: draft has no adset');
  const leadFormId = (adset.rawMetaPayload as { leadFormId?: string } | null)?.leadFormId;
  if (!leadFormId) throw new Error('launch: draft adset missing leadFormId');

  const dailyBudgetCents = Number(tree.dailyBudgetCents ?? 0n);
  if (dailyBudgetCents <= 0) throw new Error('launch: draft has no daily budget');

  // 1. Campaign (PAUSED, CBO).
  const camp = await createCampaign(client, adAccountId, {
    name: tree.name,
    objective: tree.objective ?? 'OUTCOME_LEADS',
    dailyBudgetCents,
  });
  await db
    .update(campaigns)
    .set({ metaCampaignId: camp.id, status: 'PAUSED', updatedAt: sql`now()` })
    .where(eq(campaigns.id, tree.id));

  // 2. Adset (PAUSED, France lead-gen).
  const as = await createAdset(client, adAccountId, {
    campaignId: camp.id,
    name: adset.name,
    pageId,
    countries: ['FR'],
    dsaBeneficiary: opts.dsaBeneficiary,
    dsaPayor: opts.dsaPayor,
    ageMin: 18,
    ageMax: 65,
  });
  await db
    .update(adsets)
    .set({ metaAdsetId: as.id, status: 'PAUSED', updatedAt: sql`now()` })
    .where(eq(adsets.id, adset.id));

  // 3. Per ad: upload image → lead creative → ad (all PAUSED).
  const results: LaunchResult['ads'] = [];
  for (const ad of adset.ads) {
    if (!ad.creative) {
      logger.warn({ adId: ad.id }, 'launch: ad has no creative — skipping');
      continue;
    }
    const bytes = await readFile(ad.creative.fileUrl);
    const img = await uploadAdImage(client, adAccountId, bytes);
    const creative = await createLeadCreative(client, adAccountId, {
      name: ad.name,
      pageId,
      imageHash: img.hash,
      message: ad.primaryText ?? '',
      headline: ad.headline ?? '',
      description: ad.description ?? '',
      leadFormId,
      ctaType: ad.ctaType ?? 'SIGN_UP',
      ...(opts.instagramUserId ? { instagramUserId: opts.instagramUserId } : {}),
    });
    const newAd = await createAd(client, adAccountId, {
      adsetId: as.id,
      name: ad.name,
      creativeId: creative.id,
    });
    await db
      .update(ads)
      .set({ metaAdId: newAd.id, status: 'PAUSED', updatedAt: sql`now()` })
      .where(eq(ads.id, ad.id));
    results.push({ adId: ad.id, metaAdId: newAd.id, creativeId: ad.creative.id });
  }

  logger.info(
    { metaCampaignId: camp.id, metaAdsetId: as.id, ads: results.length },
    'ads-launch: campaign launched PAUSED on Meta',
  );
  return { metaCampaignId: camp.id, metaAdsetId: as.id, ads: results };
}
