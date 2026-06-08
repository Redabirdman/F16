/**
 * Ad Expert — draft approval scanner (M12 Phase 3).
 *
 * Reacts to Ridaa/Achraf resolving a CAMPAIGN_DRAFT human-action (in WhatsApp
 * or admin). HUMAN_ACTION.RESOLVED is addressed to the reporter, so rather than
 * hijack that consumer we poll: find resolved CAMPAIGN_DRAFT actions whose draft
 * campaign is still 'DRAFT' (the natural not-yet-processed marker — launching /
 * rejecting / revising all move it off 'DRAFT', so it's processed exactly once).
 *
 *   approve → launch the campaign PAUSED on Meta (status → PAUSED).
 *   reject  → status → REJECTED.
 *   revise  → status → REVISING; regenerate the creatives + re-draft (new
 *             approval request) carrying the reviser's notes.
 *
 * A launch failure (e.g. the Page hasn't accepted Lead Ads ToS) flips the draft
 * to LAUNCH_FAILED and raises a human action with the Graph error so it isn't
 * retried forever and Ridaa sees what to fix.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { MetaGraphClient } from '../../integrations/meta/client.js';
import { campaigns } from '../../db/schema/index.js';
import { getCampaignTree } from '../../db/repositories/ads.js';
import * as humanActions from '../../db/repositories/human-actions.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { launchCampaignDraft } from './launch.js';
import { assembleCampaignDraft } from './drafting.js';
import {
  generateAndRegisterCreative,
  anglesFromFeedback,
  type CreativeAngle,
} from '../creative-agent/index.js';

const DEFAULT_INTERVAL_MS = 60_000;

export interface DraftApprovalOptions {
  db: Database;
  client: MetaGraphClient;
  adAccountId: string;
  pageId: string;
  dsaBeneficiary: string;
  dsaPayor: string;
  instagramUserId?: string;
}

export interface ApprovalScanResult {
  processed: number;
  launched: number;
  rejected: number;
  revised: number;
  failed: number;
}

interface ResolvedDraftRow {
  actionId: string;
  campaignId: string;
  resolution: { chosenOptionId?: string; notes?: string } | null;
}

async function setCampaignStatus(db: Database, campaignId: string, status: string): Promise<void> {
  await db
    .update(campaigns)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(campaigns.id, campaignId));
}

/** Regenerate creatives for the draft's angles + re-draft with the notes. */
async function redraft(
  opts: DraftApprovalOptions,
  oldCampaignId: string,
  notes?: string,
): Promise<void> {
  const tree = await getCampaignTree(opts.db, oldCampaignId);
  const adset = tree?.adsets[0];
  if (!tree || !adset) return;
  const angles = [
    ...new Set(adset.ads.map((a) => a.creative?.angle).filter((x): x is string => Boolean(x))),
  ] as CreativeAngle[];
  const leadFormId = (adset.rawMetaPayload as { leadFormId?: string } | null)?.leadFormId;
  if (angles.length === 0 || !leadFormId) return;

  // Regenerate only the angle(s) the feedback names (e.g. "the speed picture…"),
  // applying the feedback to the prompt; if none are named, regenerate all.
  const named = notes ? anglesFromFeedback(notes).filter((a) => angles.includes(a)) : [];
  const toRegen = named.length > 0 ? named : angles;
  logger.info(
    { oldCampaignId, toRegen, notes },
    'ads-approval: regenerating creatives per feedback',
  );
  for (const angle of toRegen) {
    await generateAndRegisterCreative({
      db: opts.db,
      angle,
      ...(notes ? { feedback: notes } : {}),
    });
  }
  await assembleCampaignDraft({
    db: opts.db,
    angles,
    dailyBudgetCents: Number(tree.dailyBudgetCents ?? 0n),
    currency: tree.currency,
    leadFormId,
    campaignName: tree.name,
    ...(notes ? { reviseNotes: notes } : {}),
  });
}

export async function scanDraftApprovals(opts: DraftApprovalOptions): Promise<ApprovalScanResult> {
  const res: ApprovalScanResult = { processed: 0, launched: 0, rejected: 0, revised: 0, failed: 0 };

  const rows = (await opts.db.execute(sql`
    SELECT h.id AS "actionId", h.correlation_id AS "campaignId", h.resolution AS "resolution"
    FROM human_actions h
    JOIN campaigns c ON c.id::text = h.correlation_id
    WHERE h.intent = 'CAMPAIGN_DRAFT' AND h.status = 'resolved' AND c.status = 'DRAFT'
  `)) as unknown as ResolvedDraftRow[];

  for (const r of rows) {
    res.processed += 1;
    const choice = r.resolution?.chosenOptionId;
    const notes = r.resolution?.notes;
    try {
      if (choice === 'approve') {
        await launchCampaignDraft({
          db: opts.db,
          client: opts.client,
          adAccountId: opts.adAccountId,
          pageId: opts.pageId,
          draftCampaignId: r.campaignId,
          dsaBeneficiary: opts.dsaBeneficiary,
          dsaPayor: opts.dsaPayor,
          ...(opts.instagramUserId ? { instagramUserId: opts.instagramUserId } : {}),
        });
        res.launched += 1;
      } else if (choice === 'reject') {
        await setCampaignStatus(opts.db, r.campaignId, 'REJECTED');
        res.rejected += 1;
      } else if (choice === 'revise') {
        await setCampaignStatus(opts.db, r.campaignId, 'REVISING');
        await redraft(opts, r.campaignId, notes);
        res.revised += 1;
      } else {
        // Unknown choice — leave as-is, log once by flipping to a terminal state.
        await setCampaignStatus(opts.db, r.campaignId, 'REJECTED');
      }
    } catch (err) {
      res.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { campaignId: r.campaignId, choice, err: msg },
        'ads-approval: processing failed',
      );
      await setCampaignStatus(opts.db, r.campaignId, 'LAUNCH_FAILED').catch(() => undefined);
      // Surface the failure to Ridaa so config gaps (e.g. Lead Ads ToS) are visible.
      try {
        const action = await humanActions.createAction(opts.db, {
          createdByAgent: 'ads-manager-agent#singleton',
          correlationId: r.campaignId,
          intent: 'CAMPAIGN_LAUNCH_FAILED',
          severity: 2,
          summary: `Échec du lancement de la campagne : ${msg.slice(0, 240)}`,
          options: [{ id: 'ack', label: 'Compris', kind: 'approve' }],
        });
        await sendMessage(
          { db: opts.db },
          {
            fromRole: 'ads-manager-agent',
            fromInstance: 'singleton',
            toRole: 'human-router',
            intent: 'HUMAN_ACTION.REQUESTED',
            payload: { humanActionId: action.id, severity: 2, summary: action.summary },
            correlationId: r.campaignId,
            requiresHuman: true,
            priority: 3,
          },
        );
      } catch {
        /* non-blocking */
      }
    }
  }

  if (res.processed > 0) logger.info({ ...res }, 'ads-approval: scan complete');
  return res;
}

export interface DraftApprovalSchedulerHandle {
  scheduler: NodeJS.Timeout;
  stop(): void;
  tickOnce(): Promise<ApprovalScanResult>;
}

export function startDraftApprovalScanner(
  opts: DraftApprovalOptions & { intervalMs?: number },
): DraftApprovalSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tick = (): Promise<ApprovalScanResult> =>
    scanDraftApprovals(opts).catch((err) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'ads-approval: tick failed',
      );
      return { processed: 0, launched: 0, rejected: 0, revised: 0, failed: 0 };
    });

  void tick();
  const scheduler = setInterval(() => void tick(), intervalMs);
  let stopped = false;
  return {
    scheduler,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(scheduler);
    },
    tickOnce: tick,
  };
}
