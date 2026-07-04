/**
 * Bridge a `human_actions` row to the WhatsApp group (2026-07-04 audit, H1).
 *
 * `humanActions.createAction()` only writes the DB row — the admin panel sees
 * it, but Ridaa/Achraf live in the WA group, and the reporter-agent only posts
 * there when someone emits `HUMAN_ACTION.REQUESTED`. Several sales-agent and
 * supervisor escalations (QUOTE_FAILED, DEVIS_DELIVERY_FAILED,
 * SUBSCRIPTION_FAILED, COMPLIANCE_BLOCKED) called createAction without the
 * emit, so failures sat unseen in the admin while the customer waited.
 *
 * Best-effort by contract: the DB row is the source of truth and already
 * exists; a failed enqueue must never fail the calling handler (the admin
 * still shows the action). Failures are logged loudly instead.
 */
import type { Database } from '../db/index.js';
import { sendMessage } from '../messaging/dispatcher.js';
import { logger } from '../logger.js';

export async function notifyHumanAction(
  db: Database,
  action: { id: string; severity: number; summary: string },
  from: { role: string; instanceId: string; correlationId?: string },
): Promise<void> {
  try {
    await sendMessage(
      { db },
      {
        fromRole: from.role,
        fromInstance: from.instanceId,
        toRole: 'human-router',
        intent: 'HUMAN_ACTION.REQUESTED',
        payload: {
          humanActionId: action.id,
          severity: action.severity,
          summary: action.summary,
        },
        // Correlate on the ACTION id, never the caller's lead/quote id: the
        // supervisor's loop detector scans agent_messages per correlation,
        // and injecting a third fromRole→toRole pair into a lead's stream
        // masked a real A↔B loop (arbitration dedup test caught it). The
        // action row itself carries the caller's correlation for tracing.
        correlationId: action.id,
        requiresHuman: true,
        priority: 3,
      },
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), humanActionId: action.id },
      'notifyHumanAction: HUMAN_ACTION.REQUESTED enqueue failed — action visible in admin only',
    );
  }
}
