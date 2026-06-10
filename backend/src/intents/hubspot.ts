import { z } from 'zod';
import { registerIntent } from './_registry.js';

/**
 * Log an activity engagement to HubSpot (Phase 3 activity timeline).
 *
 * Consumed by the `hubspot-sync` worker on the existing `hubspot` queue.
 * The worker no-ops unless F16_HUBSPOT_ACTIVITIES==='true' AND HUBSPOT_API_KEY
 * is set — the scopes are not yet on the Service Key (crm.objects.calls.write,
 * crm.objects.communications.write, crm.objects.notes.write).
 *
 * `customerId` is always required (used to resolve contactId via email lookup).
 * `leadId` is optional but strongly preferred — it carries hubspot_deal_id
 * directly without a secondary lookup.
 *
 * The `activity` field is an opaque record carrying the serialised F16ActivityEvent
 * (see activity-map.ts). It is stored/forwarded as-is; the worker deserialises it.
 */
export const HubSpotLogActivityPayload = registerIntent(
  'HUBSPOT.LOG_ACTIVITY',
  z.object({
    customerId: z.string().uuid(),
    leadId: z.string().uuid().optional(),
    /** Serialised F16ActivityEvent — kind + all variant fields. */
    activity: z.record(z.string(), z.unknown()),
  }),
);
