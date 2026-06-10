/**
 * HubSpot dual-write worker (M5.T2) — Phase 1 rich mirror.
 *
 * Subscribes to the `lead` BullMQ queue as role `hubspot-sync`. Handles
 * LEAD.NEW and LEAD.SYNC_HUBSPOT intents.
 *
 * reconcileLead():
 *   - Build a full MirrorInput snapshot (lead + customer + latestQuote).
 *   - Ensure all custom properties + the Assuryal pipeline exist (ensureSchema).
 *   - Upsert the HubSpot Contact with rich props (address, preferred channel/time).
 *   - CREATE the Deal if hubspot_deal_id is null; UPDATE it otherwise.
 *   - On create: associate contact↔deal, write hubspot_deal_id back.
 *
 * Idempotency:
 *   - Create path: `hubspot_deal_id IS NULL` guard.
 *   - Update path: PATCH is idempotent (same props → same result).
 *
 * PII discipline:
 *   - No logs ever contain email/phone/name. Lead id + customer id + deal id
 *     + booleans only.
 *
 * Custom-property degrade (contact upsert only):
 *   - The degrade helper strips known F16 custom props and retries once when
 *     HubSpot reports "Property X does not exist". Kept for the contact path;
 *     the deal create passes props directly via `createDeal({ properties })`.
 */
import { eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import type { Database } from '../../db/index.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import {
  consume,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
} from '../../messaging/dispatcher.js';
import { HubSpotClient, HubSpotApiError } from './client.js';
import { ensureSchema } from './schema.js';
import {
  buildContactProps,
  buildDealProps,
  stageKeyForStatus,
  type MirrorInput,
} from './mirror-map.js';
import { getLatestQuoteForLead } from '../../db/repositories/quotes.js';
import { logger } from '../../logger.js';

export interface HubSpotSyncWorkerOptions {
  db: Database;
  client: HubSpotClient;
  /** Optional explicit pipeline ID; discovered on demand when absent. */
  pipelineId?: string;
  /** Optional explicit stage ID; discovered on demand when absent. */
  newDealStageId?: string;
}

/** Custom-property names we attempt to set, in one place so the degrade-list matches. */
const F16_CUSTOM_PROPS = ['f16_lead_id', 'f16_product_line', 'f16_source'] as const;

/**
 * Start the worker. Returns the BullMQ Worker handle so the caller can close
 * it on shutdown.
 */
export function startHubSpotSyncWorker(opts: HubSpotSyncWorkerOptions): Worker {
  return consume({
    db: opts.db,
    // Dedicated 'hubspot' queue — hubspot-sync is the SOLE consumer, so a job
    // is never grabbed by another role (lead-scorer) and dropped as a misroute.
    queue: 'hubspot',
    role: 'hubspot-sync',
    handler: async (envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> => {
      if (envelope.intent !== 'LEAD.NEW' && envelope.intent !== 'LEAD.SYNC_HUBSPOT') {
        return { ok: true, result: { skipped: 'wrong-intent' } };
      }
      const payload = envelope.payload as { leadId: string };
      return reconcileLead(opts, payload.leadId);
    },
  });
}

/**
 * Back-compat shim for existing tests/callers.
 *
 * The original handleLeadNew only accepted LEAD.NEW and created the deal.
 * reconcileLead now handles both LEAD.NEW + LEAD.SYNC_HUBSPOT and does
 * create-or-update. Callers passing LEAD.NEW still get create-or-update
 * semantics (create on first call, update on replay).
 */
export async function handleLeadNew(
  opts: HubSpotSyncWorkerOptions,
  env: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  if (env.intent !== 'LEAD.NEW' && env.intent !== 'LEAD.SYNC_HUBSPOT') {
    return { ok: true, result: { skipped: 'wrong-intent' } };
  }
  const payload = env.payload as { leadId: string };
  return reconcileLead(opts, payload.leadId);
}

/**
 * Reconcile a lead's full state into HubSpot (create-or-update). Idempotent.
 *
 * First call (hubspot_deal_id IS NULL): creates Contact + Deal, associates
 * them, and writes hubspot_deal_id back onto the lead.
 *
 * Subsequent calls: PATCHes Contact + Deal with the latest rich props + stage.
 */
export async function reconcileLead(
  opts: HubSpotSyncWorkerOptions,
  leadId: string,
): Promise<MessageHandlerResult> {
  // 1. Load the lead.
  const [lead] = await opts.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return { ok: false, error: `Lead ${leadId} not found` };
  if (!lead.customerId) return { ok: true, result: { skipped: 'no-customer' } };

  // 2. Load the customer.
  const [customerRow] = await opts.db
    .select()
    .from(customers)
    .where(eq(customers.id, lead.customerId))
    .limit(1);
  if (!customerRow) return { ok: false, error: `Customer ${lead.customerId} not found` };

  // 3. Decrypt PII. Never log these values.
  const email = decryptPII(customerRow.email);
  if (!email) return { ok: true, result: { skipped: 'no-email' } };
  const phone = decryptPII(customerRow.phone);
  const fullName = decryptPII(customerRow.fullName);
  const address = customerRow.address ? decryptPII(customerRow.address) : null;

  // 4. Fetch the latest quote (for amount + devis number on the deal).
  const latestQuote = await getLatestQuoteForLead(opts.db, lead.id);

  // 5. Ensure HubSpot schema (custom props + Assuryal pipeline). Cached after first call.
  const schema = await ensureSchema(opts.client);

  // 6. Build the mapping input.
  const mirror: MirrorInput = {
    lead: {
      id: lead.id,
      status: lead.status as MirrorInput['lead']['status'],
      source: lead.source,
      productLine: lead.productLine as 'scooter' | 'car',
      score: lead.score ?? null,
      preferredChannel: (lead.preferredChannel as 'whatsapp' | 'call' | null) ?? null,
      preferredTime: (lead.preferredTime as string | null) ?? null,
    },
    customer: {
      fullName,
      email,
      phone,
      address,
      vehicle: customerRow.vehicle ?? null,
    },
    latestQuote: latestQuote
      ? {
          status: latestQuote.status,
          monthlyPremium: latestQuote.monthlyPremium ?? null,
          comptantDue: latestQuote.comptantDue ?? null,
          maxanceDevisNumber: latestQuote.maxanceDevisNumber ?? null,
          productVariant: latestQuote.productVariant,
        }
      : null,
  };

  const contactProps = buildContactProps(mirror);
  const dealProps = buildDealProps(mirror);
  const stageKey = stageKeyForStatus(mirror.lead.status);
  const stageId = stageKey !== null ? schema.stageIdByKey[stageKey] : undefined;

  // 7. Upsert Contact (with custom-property degrade retained).
  const contact = await callWithPropertyDegrade(
    (props) =>
      opts.client.upsertContact({
        email,
        ...(contactProps.firstname ? { firstName: contactProps.firstname } : {}),
        ...(contactProps.lastname ? { lastName: contactProps.lastname } : {}),
        ...(phone ? { phone } : {}),
        properties: props,
      }),
    contactProps,
    { leadId: lead.id, op: 'upsertContact' },
  );

  // 8. Create or update the Deal.
  if (!lead.hubspotDealId) {
    // --- CREATE path ---
    const deal = await opts.client.createDeal({
      dealName: String(dealProps.dealname),
      pipeline: schema.pipelineId,
      ...(stageId ? { dealStage: stageId } : {}),
      productLine: mirror.lead.productLine,
      properties: dealProps,
    });

    await opts.client.associateContactDeal(contact.hubspotContactId, deal.hubspotDealId);

    await opts.db
      .update(leads)
      .set({ hubspotDealId: deal.hubspotDealId, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));

    logger.info(
      {
        leadId: lead.id,
        hubspotDealId: deal.hubspotDealId,
        hubspotContactId: contact.hubspotContactId,
        contactWasNew: contact.isNew,
      },
      'hubspot-sync: lead created',
    );

    return {
      ok: true,
      result: {
        created: true,
        hubspotDealId: deal.hubspotDealId,
        hubspotContactId: contact.hubspotContactId,
        contactWasNew: contact.isNew,
      },
    };
  }

  // --- UPDATE path ---
  const updateProps: Record<string, string | number> = { ...dealProps };
  if (stageId) updateProps.dealstage = stageId;

  await opts.client.updateDeal(lead.hubspotDealId, updateProps);

  logger.info({ leadId: lead.id, hubspotDealId: lead.hubspotDealId }, 'hubspot-sync: lead updated');

  return {
    ok: true,
    result: { updated: true, hubspotDealId: lead.hubspotDealId },
  };
}

/**
 * Run `fn(props)`. On HubSpot "Property X does not exist", strip the named
 * property (or, if HubSpot didn't name one, strip all known F16 custom props)
 * and retry once.
 *
 * Strategy: the strip-all fallback handles the case where multiple custom
 * properties are missing — HubSpot only reports one at a time, so a per-error
 * loop could thrash. One full strip is the pragmatic V1 stance.
 */
async function callWithPropertyDegrade<T>(
  fn: (props: Record<string, string>) => Promise<T>,
  startProps: Record<string, string>,
  ctx: { leadId: string; op: string },
): Promise<T> {
  try {
    return await fn(startProps);
  } catch (err) {
    if (err instanceof HubSpotApiError && err.missingProperty) {
      logger.warn(
        {
          leadId: ctx.leadId,
          op: ctx.op,
          missingProperty: err.missingProperty,
          status: err.status,
        },
        'hubspot-sync: custom property missing, retrying without F16 custom props',
      );
      // Strip every known F16 custom prop in one shot — see comment above.
      // `eslint(no-dynamic-delete)` is fine to silence here: F16_CUSTOM_PROPS
      // is a fixed `as const` tuple, not user input.
      const stripped: Record<string, string> = { ...startProps };
      for (const key of F16_CUSTOM_PROPS) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete stripped[key];
      }
      return fn(stripped);
    }
    throw err;
  }
}
