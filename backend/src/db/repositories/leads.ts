/**
 * Leads repository — status transitions + HubSpot mirror trigger.
 *
 * `setLeadStatus` is the single chokepoint for all `leads.status` writes.
 * Routing every transition through here means every status change is
 * automatically mirrored to HubSpot via the idempotent hubspot-sync worker,
 * without callers having to remember to emit the sync themselves.
 *
 * `emitHubSpotSync` is the ONE place that enqueues LEAD.SYNC_HUBSPOT — lead
 * intake (`src/leads/intake.ts`) and status transitions both go through it.
 * It is also exported for non-status changes (e.g. a quote becoming ready
 * with a new price/devis number) where the caller wants to trigger a CRM
 * refresh without changing the lead status.
 *
 * PII boundary: no PII is logged here — only lead ids + error strings.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { leads } from '../schema/index.js';
import type { Lead } from '../schema/leads.js';
import { logger } from '../../logger.js';
import { sendMessage } from '../../messaging/dispatcher.js';

/** Lead lifecycle states — derived from the `lead_status` pg enum column. */
export type LeadStatus = Lead['status'];

/**
 * Update a lead's status AND mirror it to HubSpot. The single chokepoint for
 * status writes so every transition reflects in the CRM. The sync is
 * fire-and-forget on the `hubspot` queue (idempotent reconcile); a HubSpot
 * hiccup never blocks the status write.
 *
 * Returns the updated lead row. Throws when the lead is not found.
 */
export async function setLeadStatus(
  db: Database,
  leadId: string,
  status: LeadStatus,
): Promise<Lead> {
  const [updated] = await db
    .update(leads)
    .set({ status, updatedAt: new Date() })
    .where(eq(leads.id, leadId))
    .returning();
  if (!updated) throw new Error(`setLeadStatus: no lead with id=${leadId}`);
  await emitHubSpotSync(db, leadId);
  return updated;
}

/** Optional knobs for `emitHubSpotSync` — defaults fit status transitions. */
export interface EmitHubSpotSyncOptions {
  /** Recorded as the message sender. Default 'system'. */
  fromRole?: string;
  /** BullMQ priority — 0 highest, 9 lowest. Dispatcher default (5) when omitted. */
  priority?: number;
}

/**
 * Emit a HubSpot reconcile request for a lead (idempotent worker-side, on
 * the dedicated `hubspot` queue whose sole consumer is hubspot-sync).
 *
 * No-op when HUBSPOT_API_KEY is unset (dev / test without HubSpot). NEVER
 * throws — a Redis/DB hiccup is logged (ids only) and swallowed so it can't
 * block the caller; the next transition (or a manual replay) reconciles.
 *
 * Returns the agent_messages row id, or null when skipped or failed.
 */
export async function emitHubSpotSync(
  db: Database,
  leadId: string,
  opts: EmitHubSpotSyncOptions = {},
): Promise<string | null> {
  if (!process.env.HUBSPOT_API_KEY) return null;
  try {
    return await sendMessage(
      { db },
      {
        fromRole: opts.fromRole ?? 'system',
        toRole: 'hubspot-sync',
        intent: 'LEAD.SYNC_HUBSPOT',
        payload: { leadId },
        correlationId: leadId,
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      },
    );
  } catch (err) {
    logger.warn(
      { leadId, err: err instanceof Error ? err.message : 'unknown' },
      'emitHubSpotSync: failed to enqueue HubSpot sync (non-fatal)',
    );
    return null;
  }
}
