/**
 * Ad Expert — campaign drafting (M12 Phase 3, Tier-2 assisted).
 *
 * Assembles a campaign DRAFT from generated creatives and asks Ridaa/Achraf to
 * approve it in WhatsApp before anything is created on Meta. The draft lives in
 * the local mirror as a campaign→adset→ad tree with status 'DRAFT' and
 * placeholder Meta ids (the poller never touches these — it keys on real Meta
 * ids), so the launch step can read it back via getCampaignTree and the admin
 * can show it.
 *
 * The approval gate reuses the existing human-action WhatsApp channel: a
 * CAMPAIGN_DRAFT action with approve/reject/revise options, correlated to the
 * draft campaign id. The draft-approval scanner (approval.ts) acts on the
 * resolution.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { creatives } from '../../db/schema/index.js';
import type { Creative } from '../../db/schema/ads.js';
import { upsertCampaign, upsertAdset, upsertAd } from '../../db/repositories/ads.js';
import * as humanActions from '../../db/repositories/human-actions.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { angleCopy, type CreativeAngle } from '../creative-agent/index.js';

export interface AssembleDraftOptions {
  db: Database;
  /** Angles to include — one creative (latest) is picked per angle. */
  angles: CreativeAngle[];
  /** CBO daily budget in cents (account currency). */
  dailyBudgetCents: number;
  currency?: string;
  /** Meta instant lead-form id the ads point at. */
  leadFormId: string;
  campaignName?: string;
  /** Carried into the draft adset for launch (notes from a prior revise). */
  reviseNotes?: string;
}

export interface DraftResult {
  draftCampaignId: string;
  adsetId: string;
  humanActionId: string;
  adCount: number;
  creativeIds: string[];
}

const DRAFT_PREFIX = 'draft:';

function buildSummary(
  name: string,
  picked: Creative[],
  dailyBudgetCents: number,
  currency: string,
  reviseNotes?: string,
): string {
  const budget = (dailyBudgetCents / 100).toFixed(2);
  const angles = picked.map((c) => c.angle).join(', ');
  return (
    `🛴 Nouvelle campagne prête à valider : « ${name} »\n` +
    `• Objectif : génération de leads (formulaire instantané)\n` +
    `• Cible : France, Facebook + Instagram\n` +
    `• Budget : ${budget} ${currency}/jour\n` +
    `• Produit : trottinette (dès 5€/mois)\n` +
    `• ${picked.length} créative(s) — angles : ${angles}\n` +
    (reviseNotes ? `• Révision demandée : « ${reviseNotes} »\n` : '') +
    `La campagne sera créée EN PAUSE (aucune dépense) jusqu'à activation manuelle. ` +
    `Répondez : approuver / rejeter / réviser.`
  );
}

export async function assembleCampaignDraft(opts: AssembleDraftOptions): Promise<DraftResult> {
  const { db } = opts;
  const currency = opts.currency ?? 'USD';

  // 1. Pick the latest creative per requested angle.
  const picked: Creative[] = [];
  for (const angle of opts.angles) {
    const [c] = await db
      .select()
      .from(creatives)
      .where(and(eq(creatives.productLine, 'scooter'), eq(creatives.angle, angle)))
      .orderBy(desc(creatives.createdAt))
      .limit(1);
    if (c) picked.push(c);
  }
  if (picked.length === 0) {
    throw new Error('assembleCampaignDraft: no creatives found for the requested angles');
  }

  const draftId = `${DRAFT_PREFIX}${randomUUID()}`;
  const name = opts.campaignName ?? 'Assuryal Trottinette — Leads';

  // 2. Draft campaign (placeholder meta id, status DRAFT).
  const campaign = await upsertCampaign(db, draftId, {
    name,
    objective: 'OUTCOME_LEADS',
    status: 'DRAFT',
    productLine: 'scooter',
    dailyBudgetCents: BigInt(opts.dailyBudgetCents),
    currency,
  });

  // 3. Draft adset — France, lead-gen; carry the lead form id for launch.
  const adset = await upsertAdset(db, `${draftId}:as`, {
    campaignId: campaign.id,
    name: 'France — 18-65',
    status: 'DRAFT',
    optimizationGoal: 'LEAD_GENERATION',
    billingEvent: 'IMPRESSIONS',
    targeting: { geo_locations: { countries: ['FR'] } },
    rawMetaPayload: {
      leadFormId: opts.leadFormId,
      ...(opts.reviseNotes ? { reviseNotes: opts.reviseNotes } : {}),
    },
  });

  // 4. Draft ads — one per creative, with angle copy.
  for (const c of picked) {
    const copy = angleCopy(c.angle as CreativeAngle);
    await upsertAd(db, `${draftId}:ad:${c.angle}`, {
      adsetId: adset.id,
      creativeId: c.id,
      name: `Assuryal trottinette — ${c.angle}`,
      status: 'DRAFT',
      primaryText: copy.primaryText,
      headline: copy.headline,
      description: copy.description,
      ctaType: 'SIGN_UP',
    });
  }

  // 5. Human approval action + WhatsApp request.
  const summary = buildSummary(name, picked, opts.dailyBudgetCents, currency, opts.reviseNotes);
  const action = await humanActions.createAction(db, {
    createdByAgent: 'ads-manager-agent#singleton',
    correlationId: campaign.id,
    intent: 'CAMPAIGN_DRAFT',
    severity: 2,
    summary,
    // English labels — these render verbatim in the management WA group.
    options: [
      { id: 'approve', label: 'Approve and launch (paused)', kind: 'approve' },
      { id: 'reject', label: 'Reject', kind: 'reject' },
      { id: 'revise', label: 'Ask for a revision', kind: 'revise' },
    ],
  });

  await sendMessage(
    { db },
    {
      fromRole: 'ads-manager-agent',
      fromInstance: 'singleton',
      toRole: 'human-router',
      intent: 'HUMAN_ACTION.REQUESTED',
      payload: { humanActionId: action.id, severity: 2, summary },
      correlationId: campaign.id,
      requiresHuman: true,
      priority: 3,
    },
  );

  logger.info(
    {
      draftCampaignId: campaign.id,
      adsetId: adset.id,
      humanActionId: action.id,
      ads: picked.length,
    },
    'ads-drafting: campaign draft assembled + sent for approval',
  );

  return {
    draftCampaignId: campaign.id,
    adsetId: adset.id,
    humanActionId: action.id,
    adCount: picked.length,
    creativeIds: picked.map((c) => c.id),
  };
}
