/**
 * Admin API — read-only leads list endpoint (option D).
 *
 * Backs the admin UI's lead board with a single GET that joins leads +
 * customers, decrypts the customer's full name (read-side decryption only
 * — fullName is the one PII field the operator needs to see at a glance),
 * and returns a paginated array newest-first.
 *
 * Auth: V0 ships open on localhost. The admin UI runs behind Caddy in prod
 * and the F16 PC isn't exposed to the public internet (per
 * project_hosting_pivot.md). Phase 2 of D wires Cloudflare Access in front
 * if the admin ever goes public.
 *
 * Out of scope here (deferred):
 *   - Mutations (status changes, manual escalations) — read-only V0
 *   - Filtering by status / product / source — V0 returns the latest 50
 *   - Server-side search by name/email/phone — needs the encrypted-search
 *     helper, deferred
 */
import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { leads, customers } from '../db/schema/index.js';
import { decryptPII } from '../db/crypto.js';
import { logger } from '../logger.js';

export interface AdminLeadsRouterOptions {
  db: Database;
  /** Page-size cap so the admin UI can't accidentally request the world. Default 200. */
  maxLimit?: number;
}

/** Wire shape of one row in the response — what the admin UI consumes. */
export interface LeadRow {
  leadId: string;
  customerId: string | null;
  customerName: string | null;
  source: string;
  productLine: string;
  status: string;
  score: number | null;
  createdAt: string;
  hubspotDealId: string | null;
}

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function buildAdminLeadsRouter(opts: AdminLeadsRouterOptions): Hono {
  const app = new Hono();
  const maxLimit = opts.maxLimit ?? 200;

  app.get('/v1/admin/leads', async (c) => {
    const parse = QuerySchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
    if (!parse.success) {
      return c.json({ error: 'invalid_query', issues: parse.error.issues }, 400);
    }
    const limit = Math.min(parse.data.limit, maxLimit);
    const { offset } = parse.data;

    const rows = await opts.db
      .select({
        leadId: leads.id,
        customerId: leads.customerId,
        customerNameCipher: customers.fullName,
        source: leads.source,
        productLine: leads.productLine,
        status: leads.status,
        score: leads.score,
        createdAt: leads.createdAt,
        hubspotDealId: leads.hubspotDealId,
      })
      .from(leads)
      .leftJoin(customers, eq(customers.id, leads.customerId))
      .orderBy(desc(leads.createdAt))
      .limit(limit)
      .offset(offset);

    const mapped: LeadRow[] = rows.map((r) => {
      // Decrypt fullName best-effort — a junk cipher (test fixture, dev seed
      // without proper key) should NOT 500 the whole list. Log + fall back
      // to null so the operator can still see the lead.
      let customerName: string | null = null;
      if (r.customerNameCipher) {
        try {
          customerName = decryptPII(r.customerNameCipher);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), leadId: r.leadId },
            'admin/leads: fullName decrypt failed (returning null)',
          );
        }
      }
      return {
        leadId: r.leadId,
        customerId: r.customerId,
        customerName,
        source: r.source,
        productLine: r.productLine,
        status: r.status,
        score: r.score,
        createdAt: r.createdAt.toISOString(),
        hubspotDealId: r.hubspotDealId,
      };
    });

    return c.json(
      {
        rows: mapped,
        pagination: { limit, offset, returned: mapped.length },
      },
      200,
    );
  });

  return app;
}
