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
  deleteCampaign,
} from '../../integrations/meta/ads-write.js';
import { MetaApiError } from '../../integrations/meta/client.js';

/** Meta error subcode: the Page/account hasn't accepted the Lead Ads ToS. */
const LEAD_ADS_TOS_SUBCODE = 1815089;

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

  // 1. Campaign (PAUSED, CBO). Remember the pre-launch mirror marker so we can
  //    restore it if a later step fails and we roll the campaign back.
  const priorMetaCampaignId = tree.metaCampaignId;
  const camp = await createCampaign(client, adAccountId, {
    name: tree.name,
    objective: tree.objective ?? 'OUTCOME_LEADS',
    dailyBudgetCents,
  });
  await db
    .update(campaigns)
    .set({ metaCampaignId: camp.id, status: 'PAUSED', updatedAt: sql`now()` })
    .where(eq(campaigns.id, tree.id));

  // Steps 2-3 build the adset + ads ON TOP of the campaign. If ANY of them
  // throws (the classic case: adset rejected with Lead Ads ToS subcode 1815089),
  // we must DELETE the just-created campaign — otherwise every failed approval
  // leaves an orphan PAUSED campaign shell accumulating on the account. The
  // rollback is best-effort + never masks the original error.
  try {
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
  } catch (err) {
    // Roll back the orphan campaign + restore the mirror's pre-launch marker.
    await deleteCampaign(client, camp.id).catch((delErr: unknown) =>
      logger.error(
        { metaCampaignId: camp.id, err: delErr instanceof Error ? delErr.message : String(delErr) },
        'ads-launch: rollback delete of orphan campaign FAILED — clean up manually',
      ),
    );
    await db
      .update(campaigns)
      .set({ metaCampaignId: priorMetaCampaignId, updatedAt: sql`now()` })
      .where(eq(campaigns.id, tree.id))
      .catch(() => undefined);
    logger.warn(
      { metaCampaignId: camp.id },
      'ads-launch: launch failed after campaign creation → rolled back orphan campaign',
    );
    // Enrich the Lead Ads ToS failure into an actionable message for Ridaa.
    if (err instanceof MetaApiError && err.subcode === LEAD_ADS_TOS_SUBCODE) {
      throw new Error(
        `Lead Ads — conditions non acceptées (subcode ${LEAD_ADS_TOS_SUBCODE}). ` +
          `Accepter les CGU "Annonces à formulaire" pour la page ${pageId} ET le compte publicitaire ` +
          `(facebook.com/ads/leadgen/tos?page_id=${pageId}), avec le compte admin de la page/business. ` +
          `La campagne orpheline a été supprimée — relancer après acceptation.`,
      );
    }
    throw err;
  }
}
