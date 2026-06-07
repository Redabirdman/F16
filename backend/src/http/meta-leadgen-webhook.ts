/**
 * Meta Lead Ads webhook (M12).
 *
 * Mounts:
 *   - `GET  /v1/meta/leadgen-webhook` — Meta's subscription handshake. Echoes
 *     `hub.challenge` when `hub.verify_token` matches our configured token.
 *   - `POST /v1/meta/leadgen-webhook` — the leadgen notification. Verifies the
 *     `X-Hub-Signature-256` HMAC, then for each `leadgen` change fetches the
 *     full lead via the Graph client, maps it, and hands it to `ingestLead`
 *     (which dual-writes DB + HubSpot and emits LEAD.NEW). `call`-preference
 *     leads also get a scheduled callback (callback_due_at) the scheduler dials.
 *
 * Reliability: Meta re-delivers on any non-2xx. We dedup on `meta_leadgen_id`
 * (unique index) so a retry after a partial success is a no-op. We return 200
 * once every change in the batch is processed-or-deduped, and 500 if any change
 * failed to fetch/ingest — so Meta retries just the failing batch.
 *
 * PII discipline: lead `field_data` carries name/phone/email — never logged.
 * Responses are static; logs key on leadgenId + counts only.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { leads } from '../db/schema/leads.js';
import { ingestLead } from '../leads/intake.js';
import { mapLeadgenToIntake, computeCallbackDueAt } from '../leads/meta-leadgen.js';
import type { MetaGraphClient } from '../integrations/meta/client.js';

export interface MetaLeadgenRouterOptions {
  db: Database;
  client: MetaGraphClient;
  /** The `hub.verify_token` we registered with Meta (GET handshake). */
  verifyToken: string;
  /** App secret for `X-Hub-Signature-256` verification. Skipped if undefined (dev). */
  appSecret?: string;
  /** Product line for leads from this page. V1: 'scooter' (trottinette). */
  productLine?: 'scooter' | 'car';
}

interface LeadgenChangeValue {
  leadgen_id?: string;
  form_id?: string;
  page_id?: string;
  ad_id?: string;
  created_time?: number;
}

export function buildMetaLeadgenRouter(opts: MetaLeadgenRouterOptions): Hono {
  const app = new Hono();
  const productLine = opts.productLine ?? 'scooter';

  // --- Subscription handshake ----------------------------------------------
  app.get('/v1/meta/leadgen-webhook', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && token === opts.verifyToken && challenge) {
      logger.info({}, 'meta-leadgen: webhook verified');
      return c.text(challenge, 200);
    }
    logger.warn({ mode }, 'meta-leadgen: webhook verification failed');
    return c.text('forbidden', 403);
  });

  // --- Leadgen notifications ------------------------------------------------
  app.post('/v1/meta/leadgen-webhook', async (c) => {
    const rawBody = await c.req.text();

    if (opts.appSecret) {
      const sig = c.req.header('x-hub-signature-256') ?? '';
      if (!verifyMetaSignature(rawBody, sig, opts.appSecret)) {
        logger.warn({}, 'meta-leadgen: signature verification failed');
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }

    let body: {
      object?: string;
      entry?: Array<{ changes?: Array<{ field?: string; value?: LeadgenChangeValue }> }>;
    };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }

    // Collect leadgen ids across the batch.
    const leadgenIds: string[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'leadgen' && change.value?.leadgen_id) {
          leadgenIds.push(change.value.leadgen_id);
        }
      }
    }

    let processed = 0;
    let deduped = 0;
    let failed = 0;
    for (const leadgenId of leadgenIds) {
      try {
        // Dedup — a retry after a prior success must not double-insert.
        const existing = await opts.db
          .select({ id: leads.id })
          .from(leads)
          .where(eq(leads.metaLeadgenId, leadgenId))
          .limit(1);
        if (existing.length > 0) {
          deduped += 1;
          continue;
        }

        const leadgen = await opts.client.getLeadgenData(leadgenId);
        const payload = mapLeadgenToIntake(leadgen, { productLine });
        if (payload.preferredChannel === 'call') {
          payload.callbackDueAt = computeCallbackDueAt(
            payload.preferredTime ?? 'maintenant',
          ).toISOString();
        }
        await ingestLead(opts.db, payload);
        processed += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          { leadgenId, err: err instanceof Error ? err.message : String(err) },
          'meta-leadgen: failed to process lead',
        );
      }
    }

    logger.info(
      { received: leadgenIds.length, processed, deduped, failed },
      'meta-leadgen: batch handled',
    );

    // Ask Meta to retry only if something genuinely failed.
    if (failed > 0) return c.json({ error: 'partial_failure' }, 500);
    return c.json({ received: true, processed, deduped }, 200);
  });

  return app;
}

/**
 * Verify Meta's `X-Hub-Signature-256: sha256=<hex>` over the raw body.
 * Constant-time; malformed signatures are rejected rather than throwing.
 */
function verifyMetaSignature(rawBody: string, providedSig: string, appSecret: string): boolean {
  if (!providedSig) return false;
  const provided = providedSig.startsWith('sha256=') ? providedSig.slice(7) : providedSig;
  const computed = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (provided.length !== computed.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}
