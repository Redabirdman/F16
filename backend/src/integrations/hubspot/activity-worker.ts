/**
 * HubSpot activity worker (Phase 3) — logs F16 events as HubSpot engagements.
 *
 * Handles the HUBSPOT.LOG_ACTIVITY intent on the shared `hubspot` queue
 * (same queue + consumer role as LEAD.SYNC_HUBSPOT / hubspot-sync worker).
 *
 * GATE: Everything in this file no-ops when F16_HUBSPOT_ACTIVITIES !== 'true'
 * OR HUBSPOT_API_KEY is unset. The three required scopes are NOT yet on the
 * Service Key:
 *   - crm.objects.notes.write
 *   - crm.objects.calls.write
 *   - crm.objects.communications.write
 *
 * TO GO LIVE: Ridaa adds those three scopes to the HubSpot Service Key, then
 * set F16_HUBSPOT_ACTIVITIES=true in .env and restart the backend.
 *
 * PII discipline:
 *   - Activity BODIES are never logged here — only ids + booleans reach the logger.
 *   - We decrypt PII only to derive the email needed for contactId lookup;
 *     the email is not stored in a variable that outlives the function call.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import type { HubSpotClient } from './client.js';
import { mapActivityToEngagement, type F16ActivityEvent } from './activity-map.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Gate check — exported for tests
// ---------------------------------------------------------------------------

/**
 * Returns true only when both the feature flag AND the API key are present.
 * Called at the top of every activity path so the rest of the module can
 * be exercised in tests by mocking this.
 */
export function isActivityEnabled(): boolean {
  return process.env.F16_HUBSPOT_ACTIVITIES === 'true' && Boolean(process.env.HUBSPOT_API_KEY);
}

// ---------------------------------------------------------------------------
// Activity handler (called by the existing hubspot-sync worker)
// ---------------------------------------------------------------------------

export interface ActivityWorkerOptions {
  db: Database;
  client: HubSpotClient;
}

/**
 * Handle a HUBSPOT.LOG_ACTIVITY envelope.
 *
 * Resolution flow:
 *   1. Gate check — skip when flag is off.
 *   2. Deserialise the activity event from the opaque payload.
 *   3. Load the lead (for hubspot_deal_id) and the customer (for email → contactId).
 *   4. Upsert the HubSpot contact to get contactId (cheap PATCH when already exists).
 *   5. Call the right engagement method (note / call / communication).
 *
 * Idempotency: HubSpot engagement creates are NOT idempotent (there is no
 * dedup key). BullMQ retry on transient error could create a duplicate note/
 * call, but that is acceptable V1 behaviour (same trade-off as LEAD.SYNC_HUBSPOT
 * retries). The gate flag default-off means this only runs when explicitly enabled.
 */
export async function handleLogActivity(
  opts: ActivityWorkerOptions,
  envelope: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  if (!isActivityEnabled()) {
    return { ok: true, result: { skipped: 'flag-off' } };
  }

  const payload = envelope.payload as {
    customerId: string;
    leadId?: string;
    activity: Record<string, unknown>;
  };

  // Deserialise + validate the activity event (basic duck-typing; zod schema
  // already validated the outer envelope at sendMessage time).
  const event = deserialiseActivity(payload.activity);
  if (!event) {
    logger.warn(
      { intent: envelope.intent, customerId: payload.customerId },
      'hubspot-activity: unknown activity kind — skipping',
    );
    return { ok: true, result: { skipped: 'unknown-kind' } };
  }

  // Load the customer to get their email (needed for contactId upsert).
  const [customerRow] = await opts.db
    .select()
    .from(customers)
    .where(eq(customers.id, payload.customerId))
    .limit(1);
  if (!customerRow) {
    return { ok: false, error: `Customer ${payload.customerId} not found` };
  }

  const email = decryptPII(customerRow.email);
  if (!email) {
    return { ok: true, result: { skipped: 'no-email' } };
  }

  // Upsert the contact to resolve its HubSpot id (cheap when already exists).
  const contact = await opts.client.upsertContact({ email });
  const contactId = contact.hubspotContactId;

  // Resolve the deal id — prefer the lead's stored hubspot_deal_id.
  let dealId: string | null = null;
  if (payload.leadId) {
    const [leadRow] = await opts.db
      .select({ hubspotDealId: leads.hubspotDealId })
      .from(leads)
      .where(eq(leads.id, payload.leadId))
      .limit(1);
    dealId = leadRow?.hubspotDealId ?? null;
  }

  if (!dealId) {
    // No deal yet — log as a standalone contact note, skip deal association.
    // This is acceptable for early-funnel events before a deal is created.
    logger.info(
      { customerId: payload.customerId, leadId: payload.leadId ?? null, activityKind: event.kind },
      'hubspot-activity: no deal id yet — skipping (deal not created yet)',
    );
    return { ok: true, result: { skipped: 'no-deal-id' } };
  }

  // Map the event to an engagement spec and call the right client method.
  const spec = mapActivityToEngagement(event);

  switch (spec.kind) {
    case 'note': {
      const { noteId } = await opts.client.createNote({
        body: spec.body,
        contactId,
        dealId,
        timestamp: spec.timestamp,
      });
      logger.info(
        { customerId: payload.customerId, leadId: payload.leadId ?? null, noteId },
        'hubspot-activity: note created',
      );
      return { ok: true, result: { kind: 'note', noteId } };
    }

    case 'call': {
      const { callId } = await opts.client.createCall({
        title: spec.title,
        body: spec.body,
        ...(typeof spec.durationMs === 'number' ? { durationMs: spec.durationMs } : {}),
        contactId,
        dealId,
        timestamp: spec.timestamp,
      });
      logger.info(
        { customerId: payload.customerId, leadId: payload.leadId ?? null, callId },
        'hubspot-activity: call engagement created',
      );
      return { ok: true, result: { kind: 'call', callId } };
    }

    case 'communication': {
      const { communicationId } = await opts.client.createCommunication({
        channel: spec.channel,
        body: spec.body,
        contactId,
        dealId,
        timestamp: spec.timestamp,
      });
      logger.info(
        {
          customerId: payload.customerId,
          leadId: payload.leadId ?? null,
          communicationId,
          channel: spec.channel,
        },
        'hubspot-activity: communication engagement created',
      );
      return { ok: true, result: { kind: 'communication', communicationId } };
    }
  }
}

// ---------------------------------------------------------------------------
// Emit helper — gated, fire-and-forget
// ---------------------------------------------------------------------------

export interface EmitHubSpotActivityInput {
  customerId: string;
  leadId?: string;
  activity: F16ActivityEvent;
}

/**
 * Enqueue a HUBSPOT.LOG_ACTIVITY message. No-ops unless the gate is active.
 * Always wrapped in try/catch — a Redis/BullMQ hiccup must NEVER break the
 * real flow that called this (voice, WhatsApp, engagement, admin).
 *
 * Returns the agent_messages row id, or null when skipped/failed.
 */
export async function emitHubSpotActivity(
  db: Database,
  input: EmitHubSpotActivityInput,
): Promise<string | null> {
  if (!isActivityEnabled()) return null;

  // Serialise the typed event into the opaque record the intent schema expects.
  // Date → ISO string so the JSON round-trip is lossless.
  const activityRecord: Record<string, unknown> = {
    ...input.activity,
    timestamp: input.activity.timestamp.toISOString(),
  };

  try {
    return await sendMessage(
      { db },
      {
        fromRole: 'system',
        toRole: 'hubspot-sync',
        intent: 'HUBSPOT.LOG_ACTIVITY',
        payload: {
          customerId: input.customerId,
          ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
          activity: activityRecord,
        },
        correlationId: input.customerId,
        priority: 7, // low priority — activities are best-effort, not blocking
      },
    );
  } catch (err) {
    logger.warn(
      {
        customerId: input.customerId,
        leadId: input.leadId ?? null,
        activityKind: input.activity.kind,
        err: err instanceof Error ? err.message : 'unknown',
      },
      'emitHubSpotActivity: failed to enqueue (non-fatal)',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal deserialiser
// ---------------------------------------------------------------------------

/**
 * Deserialise an opaque payload record back into a typed F16ActivityEvent.
 * Converts the ISO timestamp string back to a Date. Returns null on unknown kind.
 */
function deserialiseActivity(raw: Record<string, unknown>): F16ActivityEvent | null {
  const kind = raw.kind;
  const timestamp = typeof raw.timestamp === 'string' ? new Date(raw.timestamp) : new Date();

  switch (kind) {
    case 'voice-call-ended':
      return {
        kind: 'voice-call-ended',
        customerId: String(raw.customerId ?? ''),
        ...(raw.leadId !== undefined ? { leadId: String(raw.leadId) } : {}),
        transcriptSummary: String(raw.transcriptSummary ?? ''),
        ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
        timestamp,
      };

    case 'whatsapp-turn':
      return {
        kind: 'whatsapp-turn',
        customerId: String(raw.customerId ?? ''),
        ...(raw.leadId !== undefined ? { leadId: String(raw.leadId) } : {}),
        body: String(raw.body ?? ''),
        direction: raw.direction === 'inbound' ? 'inbound' : 'outbound',
        timestamp,
      };

    case 'engagement-followup': {
      const step = Number(raw.step);
      return {
        kind: 'engagement-followup',
        customerId: String(raw.customerId ?? ''),
        ...(raw.leadId !== undefined ? { leadId: String(raw.leadId) } : {}),
        nudgeText: String(raw.nudgeText ?? ''),
        step: (step === 0 || step === 1 || step === 2 ? step : 0) as 0 | 1 | 2,
        timestamp,
      };
    }

    case 'human-action-resolved':
      return {
        kind: 'human-action-resolved',
        customerId: String(raw.customerId ?? ''),
        ...(raw.leadId !== undefined ? { leadId: String(raw.leadId) } : {}),
        humanActionId: String(raw.humanActionId ?? ''),
        chosenOptionId: String(raw.chosenOptionId ?? ''),
        source: raw.source === 'whatsapp' ? 'whatsapp' : 'admin',
        timestamp,
      };

    default:
      return null;
  }
}
