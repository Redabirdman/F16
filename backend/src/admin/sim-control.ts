/**
 * Admin Simulation control — inject a fake Facebook lead through the REAL
 * intake pipeline, reset (purge) a contact, and report channel/identity
 * status. Lets a remote tester (Achraf) run agent scenarios on his real
 * WhatsApp/phone.
 *
 * Sim leads are `source='meta'` + `attribution.f16_simulation='true'` so the
 * agents treat them identically to real Meta lead-form leads, while analytics
 * can exclude them. There is no 'simulation' source enum — the flag is the
 * marker.
 *
 * Reset is phone-keyed (purgeContact looks up by phone_hash); email is only
 * forwarded to the HubSpot archive, which can search by either.
 *
 * PII discipline: logs ids/counts/flags only — never decrypted names, phones,
 * or emails.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { leads } from '../db/schema/index.js';
import {
  ingestLead as realIngestLead,
  normalizePhone,
  type LeadIntakePayload,
  type IngestedLead,
} from '../leads/intake.js';
import { purgeContact as realPurgeContact } from '../leads/purge.js';
import { getCustomerByPhone } from '../db/repositories/customers.js';
import type { HubSpotClient } from '../integrations/hubspot/client.js';
import { logger } from '../logger.js';

export interface AdminSimRouterOptions {
  db: Database;
  /** Optional HubSpot mirror — when present, reset also archives there. */
  hubspot?: HubSpotClient;
  /** Injectable seams for unit tests (avoid hitting a real DB). */
  deps?: {
    ingestLead?: (db: Database, p: LeadIntakePayload) => Promise<IngestedLead>;
    purgeContact?: typeof realPurgeContact;
  };
}

const InjectSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional(),
  preferredChannel: z.enum(['whatsapp', 'call']),
  preferredTime: z.enum(['maintenant', 'matin', 'apres_midi', 'soir']).optional(),
  productLine: z.enum(['scooter', 'car']).default('scooter'),
  quote: z
    .object({
      purchasePriceEur: z.number().positive(),
      purchaseDate: z.string(),
      postalCode: z.string(),
      stationnement: z.string(),
      dateOfBirth: z.string(),
      city: z.string().optional(),
    })
    .optional(),
});

const PhoneBody = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

export function buildAdminSimRouter(opts: AdminSimRouterOptions): Hono {
  const app = new Hono();
  const ingestLead = opts.deps?.ingestLead ?? realIngestLead;
  const purgeContact = opts.deps?.purgeContact ?? realPurgeContact;

  // Inject a simulated Meta lead through the real intake pipeline.
  app.post('/v1/admin/sim/inject-lead', async (c) => {
    const parse = InjectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) {
      return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    }
    const b = parse.data;
    // Validate at the boundary: a phone we can't normalize would corrupt the
    // dedup hash + make the agent unreachable. Reject it.
    if (!normalizePhone(b.phone)) {
      return c.json({ error: 'invalid_phone' }, 400);
    }
    const runId = randomUUID();
    const payload: LeadIntakePayload = {
      source: 'meta',
      sourceId: `sim-${runId}`,
      productLine: b.productLine,
      fullName: b.fullName,
      ...(b.email ? { email: b.email } : {}),
      phone: b.phone,
      preferredChannel: b.preferredChannel,
      ...(b.preferredTime ? { preferredTime: b.preferredTime } : {}),
      attribution: {
        f16_simulation: 'true',
        sim_run_id: runId,
        utm_source: 'simulation',
      },
      ...(b.quote ? { formAnswers: b.quote as Record<string, unknown> } : {}),
      raw: { simulation: true, sim_run_id: runId },
    };
    const res = await ingestLead(opts.db, payload);
    logger.info(
      { leadId: res.leadId, dedup: res.dedup, simRunId: runId },
      'simulation lead injected',
    );
    return c.json(res, 200);
  });

  // Reset (purge) a contact by phone, best-effort archiving HubSpot too.
  app.post('/v1/admin/sim/reset', async (c) => {
    const parse = PhoneBody.safeParse(await c.req.json().catch(() => null));
    if (!parse.success || (!parse.data.phone && !parse.data.email)) {
      return c.json({ error: 'phone_or_email_required' }, 400);
    }
    const purged = await purgeContact(opts.db, {
      ...(parse.data.phone ? { phone: parse.data.phone } : {}),
    });
    let hubspot: 'archived' | 'not_found' | 'error' | 'skipped' = 'skipped';
    if (opts.hubspot) {
      hubspot = await opts.hubspot.archiveContactByPhoneOrEmail({
        ...(parse.data.phone ? { phone: parse.data.phone } : {}),
        ...(parse.data.email ? { email: parse.data.email } : {}),
      });
    }
    logger.info({ purged, hubspot }, 'simulation contact reset');
    return c.json({ purged, hubspot }, 200);
  });

  // Status — channel liveness + (optional) the contact's lead history.
  app.post('/v1/admin/sim/status', async (c) => {
    const parse = PhoneBody.safeParse(await c.req.json().catch(() => ({})));
    const phone = parse.success ? parse.data.phone : undefined;
    const channels = {
      whatsapp: Boolean(process.env.WAHA_BASE_URL),
      voice: Boolean(process.env.OPENAI_API_KEY),
    };
    let contact: { exists: boolean; leadCount: number; lastLeadStatus: string | null } | null =
      null;
    const e164 = normalizePhone(phone);
    if (e164) {
      const cust = await getCustomerByPhone(opts.db, e164);
      if (cust) {
        const rows = await opts.db
          .select({ id: leads.id, status: leads.status, createdAt: leads.createdAt })
          .from(leads)
          .where(eq(leads.customerId, cust.id));
        const last = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
        contact = { exists: true, leadCount: rows.length, lastLeadStatus: last?.status ?? null };
      } else {
        contact = { exists: false, leadCount: 0, lastLeadStatus: null };
      }
    }
    return c.json({ channels, contact }, 200);
  });

  return app;
}
