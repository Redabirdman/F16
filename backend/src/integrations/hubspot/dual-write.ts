/**
 * HubSpot dual-write worker (M5.T2).
 *
 * Subscribes to the `lead` BullMQ queue as role `hubspot-sync`. Whenever an
 * intake produces a LEAD.NEW message, this worker fans out to HubSpot:
 *
 *   1. Decrypt the customer's PII (email/phone/name).
 *   2. Upsert a contact by email (idempotent — repeat emails merge).
 *   3. Resolve the default pipeline + first stage (cached after first hit).
 *   4. Create a deal in that stage.
 *   5. Associate contact <-> deal.
 *   6. Write `hubspot_deal_id` back onto the lead row — idempotency anchor.
 *
 * Idempotency:
 *   - We early-return on `leads.hubspot_deal_id != null`. The dispatcher's
 *     row-claim already guarantees once-and-only-once delivery for LEAD.NEW,
 *     but a manual requeue or replay must not double-write to HubSpot.
 *
 * PII discipline:
 *   - No logs ever contain email/phone/name. Lead id + customer id + deal id
 *     + booleans only.
 *
 * Custom-property degrade:
 *   - We send `f16_lead_id`, `f16_product_line`, `f16_source` as a hint to
 *     the runbook setup, but a fresh portal won't have those properties yet.
 *     If HubSpot returns "Property X does not exist", we strip those props
 *     and retry once. The runbook (M5.T5) tells Ridaa to create them so the
 *     fallback path becomes rare.
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

type LeadNewPayload = {
  leadId: string;
  productLine: 'scooter' | 'car';
  source?: string;
};

/**
 * Start the worker. Returns the BullMQ Worker handle so the caller can close
 * it on shutdown.
 */
export function startHubSpotSyncWorker(opts: HubSpotSyncWorkerOptions): Worker {
  return consume({
    db: opts.db,
    queue: 'lead',
    role: 'hubspot-sync',
    handler: async (envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> =>
      handleLeadNew(opts, envelope),
  });
}

/**
 * Exported for direct testing (no BullMQ in the path). The integration test
 * still exercises the worker; unit-style tests can call this without a queue.
 */
export async function handleLeadNew(
  opts: HubSpotSyncWorkerOptions,
  env: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  if (env.intent !== 'LEAD.NEW') {
    return { ok: true, result: { skipped: 'wrong-intent' } };
  }
  const payload = env.payload as LeadNewPayload;

  // 1. Load the lead. Defensive: a stale BullMQ job might race a deletion.
  const [lead] = await opts.db.select().from(leads).where(eq(leads.id, payload.leadId)).limit(1);
  if (!lead) {
    return { ok: false, error: `Lead ${payload.leadId} not found` };
  }

  // 2. Idempotency guard — already synced this lead.
  if (lead.hubspotDealId) {
    logger.debug(
      { leadId: lead.id, hubspotDealId: lead.hubspotDealId },
      'hubspot-sync: already synced, skipping',
    );
    return {
      ok: true,
      result: { skipped: 'already-synced', hubspotDealId: lead.hubspotDealId },
    };
  }

  if (!lead.customerId) {
    logger.warn(
      { leadId: lead.id },
      'hubspot-sync: lead has no customer_id; cannot sync without contact info',
    );
    return { ok: true, result: { skipped: 'no-customer' } };
  }

  const [customerRow] = await opts.db
    .select()
    .from(customers)
    .where(eq(customers.id, lead.customerId))
    .limit(1);
  if (!customerRow) {
    return { ok: false, error: `Customer ${lead.customerId} not found` };
  }

  // 3. Decrypt PII. We never log these values.
  const email = decryptPII(customerRow.email);
  const phone = decryptPII(customerRow.phone);
  const fullName = decryptPII(customerRow.fullName);

  if (!email) {
    // Email is the upsert key. Without it we'd have to invent a HubSpot
    // identifier per lead, which would break dedup across submissions.
    logger.warn(
      { leadId: lead.id },
      'hubspot-sync: no email on customer; deferring (V1 limitation)',
    );
    return { ok: true, result: { skipped: 'no-email' } };
  }

  const trimmedName = (fullName ?? '').trim();
  const [firstName, ...rest] = trimmedName.split(/\s+/).filter(Boolean);
  const lastName = rest.join(' ') || undefined;

  // 4. Build the props we'd LIKE to set. Degrade list is built from the
  //    canonical custom-property names so the retry path stays in sync.
  const productLine = payload.productLine;
  const customProps: Record<string, string> = {
    f16_lead_id: lead.id,
    f16_product_line: productLine,
    f16_source: lead.source,
  };

  // 5. Upsert contact (with degrade-on-missing-property).
  const contact = await callWithPropertyDegrade(
    (props) =>
      opts.client.upsertContact({
        email,
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
        ...(phone ? { phone } : {}),
        properties: props,
      }),
    customProps,
    { leadId: lead.id, op: 'upsertContact' },
  );

  // 6. Resolve pipeline + stage (cached on the client after first hit).
  const { pipelineId, newDealStageId } = await resolvePipelineAndStage(opts);

  // 7. Create deal.
  const dealName = buildDealName(productLine, fullName, email);
  const deal = await callWithPropertyDegrade(
    (props) =>
      opts.client.createDeal({
        dealName,
        pipeline: pipelineId,
        dealStage: newDealStageId,
        productLine,
        properties: props,
      }),
    { f16_lead_id: lead.id },
    { leadId: lead.id, op: 'createDeal' },
  );

  // 8. Associate.
  await opts.client.associateContactDeal(contact.hubspotContactId, deal.hubspotDealId);

  // 9. Persist deal id back onto the lead — the idempotency anchor for any
  //    replay.
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
    'hubspot-sync: lead synced',
  );

  return {
    ok: true,
    result: {
      hubspotDealId: deal.hubspotDealId,
      hubspotContactId: contact.hubspotContactId,
      contactWasNew: contact.isNew,
    },
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

async function resolvePipelineAndStage(
  opts: HubSpotSyncWorkerOptions,
): Promise<{ pipelineId: string; newDealStageId: string }> {
  if (opts.pipelineId && opts.newDealStageId) {
    return { pipelineId: opts.pipelineId, newDealStageId: opts.newDealStageId };
  }
  const discovered = await opts.client.getDefaultDealPipelineAndStage();
  return {
    pipelineId: opts.pipelineId ?? discovered.pipelineId,
    newDealStageId: opts.newDealStageId ?? discovered.newDealStageId,
  };
}

/** "Trottinette — Marie Curie" / "Auto — marie@example.fr" / "Trottinette — Lead" */
function buildDealName(
  productLine: 'scooter' | 'car',
  fullName: string | null,
  email: string,
): string {
  const product = productLine === 'scooter' ? 'Trottinette' : 'Auto';
  const subject = (fullName && fullName.trim()) || email || 'Lead';
  return `${product} — ${subject}`;
}
