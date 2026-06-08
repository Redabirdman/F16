/**
 * Meta Graph — ads write layer (M12 Phase 3, launch).
 *
 * Creates campaign → adset → creative → ad, ALL in PAUSED state, plus the
 * ad-image upload. Tuned for the Assuryal funnel: OUTCOME_LEADS + an instant
 * lead form, France geo (DSA fields required as an EU country), CBO budget on
 * the campaign. Nothing here ever sets a live/ACTIVE status — a human flips the
 * campaign on in Ads Manager (or a future, separately-authorized step).
 *
 * All complex params are JSON-stringified into the form body (Graph's
 * convention for `targeting`, `promoted_object`, `object_story_spec`, …).
 */
import type { MetaGraphClient } from './client.js';

export interface CreateCampaignInput {
  name: string;
  /** ODAX objective, e.g. 'OUTCOME_LEADS'. */
  objective: string;
  /** CBO daily budget in cents (account currency). */
  dailyBudgetCents: number;
}

export async function createCampaign(
  client: MetaGraphClient,
  adAccountId: string,
  input: CreateCampaignInput,
): Promise<{ id: string }> {
  const res = await client.post<{ id?: string }>(`/act_${adAccountId}/campaigns`, {
    name: input.name,
    objective: input.objective,
    status: 'PAUSED',
    buying_type: 'AUCTION',
    special_ad_categories: '[]',
    // Graph campaign-budget field is `daily_budget` (the MCP's
    // `campaign_daily_budget` is its own wrapper name) — this is true CBO.
    daily_budget: String(input.dailyBudgetCents),
    // CBO now requires this flag explicitly when a campaign budget is set.
    is_adset_budget_sharing_enabled: 'false',
    // Automatic bidding (no cap) — so child adsets don't need a bid amount.
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
  });
  if (!res.id) throw new Error('createCampaign: no id returned');
  return { id: res.id };
}

export interface CreateAdsetInput {
  campaignId: string;
  name: string;
  pageId: string;
  /** Country codes, e.g. ['FR']. */
  countries: string[];
  /** DSA (EU) beneficiary + payor — required for EU geos. */
  dsaBeneficiary: string;
  dsaPayor: string;
  ageMin?: number;
  ageMax?: number;
}

export async function createAdset(
  client: MetaGraphClient,
  adAccountId: string,
  input: CreateAdsetInput,
): Promise<{ id: string }> {
  const targeting = {
    geo_locations: { countries: input.countries },
    ...(input.ageMin ? { age_min: input.ageMin } : {}),
    ...(input.ageMax ? { age_max: input.ageMax } : {}),
    // FB + Instagram only (no Audience Network for lead forms by default).
    publisher_platforms: ['facebook', 'instagram'],
  };
  const res = await client.post<{ id?: string }>(`/act_${adAccountId}/adsets`, {
    name: input.name,
    campaign_id: input.campaignId,
    status: 'PAUSED',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LEAD_GENERATION',
    destination_type: 'ON_AD',
    promoted_object: JSON.stringify({ page_id: input.pageId }),
    targeting: JSON.stringify(targeting),
    dsa_beneficiary: input.dsaBeneficiary,
    dsa_payor: input.dsaPayor,
    // Under CBO the budget lives on the campaign — none here.
  });
  if (!res.id) throw new Error('createAdset: no id returned');
  return { id: res.id };
}

/** Upload a PNG to the ad account → returns the image_hash. */
export async function uploadAdImage(
  client: MetaGraphClient,
  adAccountId: string,
  pngBytes: Buffer,
): Promise<{ hash: string }> {
  const res = await client.post<{ images?: Record<string, { hash?: string }> }>(
    `/act_${adAccountId}/adimages`,
    { bytes: pngBytes.toString('base64') },
  );
  const first = res.images ? Object.values(res.images)[0] : undefined;
  if (!first?.hash) throw new Error('uploadAdImage: no image hash returned');
  return { hash: first.hash };
}

export interface CreateLeadCreativeInput {
  name: string;
  pageId: string;
  imageHash: string;
  /** Primary text (above the image). */
  message: string;
  headline: string;
  description: string;
  /** Meta instant-form id the CTA opens. */
  leadFormId: string;
  /** CTA enum, e.g. 'SIGN_UP' | 'GET_QUOTE' | 'LEARN_MORE'. */
  ctaType?: string;
  /** Optional IG account id for Instagram delivery. */
  instagramUserId?: string;
}

export async function createLeadCreative(
  client: MetaGraphClient,
  adAccountId: string,
  input: CreateLeadCreativeInput,
): Promise<{ id: string }> {
  const objectStorySpec = {
    page_id: input.pageId,
    ...(input.instagramUserId ? { instagram_user_id: input.instagramUserId } : {}),
    link_data: {
      image_hash: input.imageHash,
      message: input.message,
      name: input.headline,
      description: input.description,
      // Instant-form ads still require a link; the CTA's lead_gen_form_id is
      // what actually opens the form.
      link: 'https://fb.me/',
      call_to_action: {
        type: input.ctaType ?? 'SIGN_UP',
        value: { lead_gen_form_id: input.leadFormId },
      },
    },
  };
  const res = await client.post<{ id?: string }>(`/act_${adAccountId}/adcreatives`, {
    name: input.name,
    object_story_spec: JSON.stringify(objectStorySpec),
  });
  if (!res.id) throw new Error('createLeadCreative: no id returned');
  return { id: res.id };
}

export async function createAd(
  client: MetaGraphClient,
  adAccountId: string,
  input: { adsetId: string; name: string; creativeId: string },
): Promise<{ id: string }> {
  const res = await client.post<{ id?: string }>(`/act_${adAccountId}/ads`, {
    name: input.name,
    adset_id: input.adsetId,
    status: 'PAUSED',
    creative: JSON.stringify({ creative_id: input.creativeId }),
  });
  if (!res.id) throw new Error('createAd: no id returned');
  return { id: res.id };
}
