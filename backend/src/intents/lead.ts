import { z } from 'zod';
import { registerIntent } from './_registry.js';

export const LeadNewPayload = registerIntent(
  'LEAD.NEW',
  z.object({
    leadId: z.string().uuid(),
    source: z.enum(['website', 'meta', 'organic', 'referral', 'other']),
    sourceId: z.string().optional(),
    productLine: z.enum(['scooter', 'car']),
    // M12: stated first-contact preference from a paid lead form. Lets the
    // Lead Scorer honor the customer's choice over the LLM's channel guess.
    preferredChannel: z.enum(['whatsapp', 'call']).optional(),
    preferredTime: z.enum(['maintenant', 'matin', 'apres_midi', 'soir']).optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  }),
);

export const LeadProfileUpdatedPayload = registerIntent(
  'LEAD.PROFILE_UPDATED',
  z.object({
    leadId: z.string().uuid(),
    fields: z.array(z.string()),
  }),
);

export const LeadScoredPayload = registerIntent(
  'LEAD.SCORED',
  z.object({
    leadId: z.string().uuid(),
    score: z.number().min(0).max(100),
    opening: z.string(),
    channel: z.enum(['whatsapp', 'voice', 'email', 'sms']),
  }),
);

export const LeadStatusChangedPayload = registerIntent(
  'LEAD.STATUS_CHANGED',
  z.object({
    leadId: z.string().uuid(),
    from: z.string(),
    to: z.string(),
  }),
);

/**
 * Request a HubSpot reconcile for a lead. Consumed SOLELY by the `hubspot-sync`
 * worker on its dedicated `hubspot` queue — gives it a single-consumer queue so
 * it never races the lead-scorer on the shared `lead` queue. The handler runs
 * the idempotent create-or-update reconcile, so emitting this on every lifecycle
 * transition keeps the CRM mirror live (Phase 2 trigger).
 */
export const LeadSyncHubspotPayload = registerIntent(
  'LEAD.SYNC_HUBSPOT',
  z.object({
    leadId: z.string().uuid(),
  }),
);
