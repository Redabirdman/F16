/**
 * Website lead intake — `POST /v1/website-leads` (2026-07-15).
 *
 * Public endpoint consumed by the www.assuryalconseil.fr forms (QuoteForm +
 * ContactPage). Unlike `/v1/leads` this route is deliberately UNSIGNED: the
 * website is a public SPA, so any HMAC secret shipped in its JS bundle is
 * readable by anyone — and `HMAC_WEBHOOK_SECRET` also guards the Meta and
 * voice webhooks, so embedding it client-side would compromise those too.
 *
 * Defenses instead (cheapest first):
 *   1. CORS allowlist — browsers only send from the Assuryal origins.
 *      (Curl bypasses CORS; it's UX-scoping, not auth.)
 *   2. IP rate limit — same sliding-window limiter as `/v1/leads`, but a
 *      tighter default (10/min/IP): humans don't submit forms faster.
 *   3. Honeypot — the form ships a hidden `website` field; bots that fill it
 *      get a fake 200 and no ingest.
 *   4. Zod validation before any DB write.
 *
 * On success the lead flows through the REAL `ingestLead()` — DB row (admin),
 * HubSpot mirror, `LEAD.NEW` → Lead Scorer → Sales Agent — and a best-effort
 * WhatsApp notification is sent to the management group (Ridaa + Achraf) via
 * the WAHA default session.
 *
 * `productLine` mapping: the pg enum is binary ('scooter'|'car') and ripples
 * through HubSpot + compliance + TS types, so the 9 website products map to
 * the closest value and the TRUE product travels in `formAnswers.insurance_type`
 * (merged into the LEAD.NEW payload, so the Sales Agent sees it).
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import type { WahaClient } from '../channels/whatsapp/waha-client.js';
import { logger } from '../logger.js';
import { ingestLead, type LeadIntakePayload } from './intake.js';
import { makeRateLimiter } from './intake-http.js';

export interface WebsiteLeadIntakeRouterOptions {
  db: Database;
  /** WAHA client for the management-group notification (best-effort). */
  waha?: WahaClient;
  /** WhatsApp group chat id (HUMAN_ACTION_GROUP_CHAT_ID). */
  groupChatId?: string;
  rateLimit?: { maxPerMinutePerIp?: number };
}

/** Origins allowed to POST from a browser. */
const ALLOWED_ORIGINS = new Set([
  'https://www.assuryalconseil.fr',
  'https://assuryalconseil.fr',
  'http://localhost:8080', // vite dev
  'http://localhost:4173', // vite preview
]);

/**
 * Wire payload from the website forms. `.passthrough()` keeps per-product
 * extra fields (QuoteForm `extraValues`) — they land in `formAnswers`.
 */
const WebsiteLeadSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(8).max(20),
    email: z.string().trim().email().max(255),
    canal: z.enum(['telephone', 'whatsapp', 'email']).optional(),
    insurance_type: z.string().trim().min(2).max(40),
    source_page: z.string().max(200).optional(),
    timestamp: z.string().optional(),
    utm_source: z.string().max(100).nullish(),
    utm_medium: z.string().max(100).nullish(),
    utm_campaign: z.string().max(100).nullish(),
    /** Honeypot — humans never see it; a filled value means bot. */
    website: z.string().optional(),
    /** RGPD consent checkbox (always true when the form validates). */
    rgpd: z.boolean().optional(),
  })
  .passthrough();

/** Closest binary product line; the true product stays in formAnswers. */
const PRODUCT_LINE_MAP: Record<string, 'scooter' | 'car'> = {
  trottinette: 'scooter',
  velo: 'scooter',
  moto: 'scooter',
  auto: 'car',
};

const PRODUCT_LABELS: Record<string, string> = {
  auto: 'Auto',
  trottinette: 'Trottinette / NVEI',
  moto: 'Moto & 2-roues',
  velo: 'Vélo électrique',
  sante: 'Santé',
  prevoyance: 'Prévoyance',
  habitation: 'Habitation',
  emprunteur: 'Emprunteur',
  voyage: 'Voyage',
  contact: 'Contact général',
};

export function buildWebsiteLeadIntakeRouter(opts: WebsiteLeadIntakeRouterOptions): Hono {
  const app = new Hono();
  const rl = makeRateLimiter(opts.rateLimit?.maxPerMinutePerIp ?? 10);

  app.use(
    '/v1/website-leads',
    cors({
      origin: (origin) => (origin && ALLOWED_ORIGINS.has(origin) ? origin : null),
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 86400,
    }),
  );

  app.post('/v1/website-leads', async (c) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown';
    if (!rl.allow(ip)) {
      logger.warn({ ip }, 'website lead intake: rate limited');
      return c.json({ error: 'rate_limited' }, 429);
    }

    let parsed: z.infer<typeof WebsiteLeadSchema>;
    try {
      parsed = WebsiteLeadSchema.parse(await c.req.json());
    } catch (err) {
      logger.warn(
        { ip, err: err instanceof Error ? err.message : 'parse error' },
        'website lead intake: invalid payload',
      );
      return c.json({ error: 'invalid_payload' }, 400);
    }

    // Honeypot: pretend success so bots don't adapt, ingest nothing.
    if (parsed.website && parsed.website.length > 0) {
      logger.warn({ ip }, 'website lead intake: honeypot tripped — dropped');
      return c.json({ accepted: true }, 200);
    }

    const { name, phone, email, canal, insurance_type, source_page, rgpd, website, ...rest } =
      parsed;
    void rgpd;
    void website;

    const payload: LeadIntakePayload = {
      source: 'website',
      productLine: PRODUCT_LINE_MAP[insurance_type] ?? 'car',
      fullName: name,
      email,
      phone,
      ...(canal
        ? {
            preferredChannel:
              canal === 'telephone' ? 'call' : canal === 'whatsapp' ? 'whatsapp' : undefined,
          }
        : {}),
      formAnswers: {
        insurance_type,
        ...(canal ? { canal } : {}),
        ...(source_page ? { source_page } : {}),
        ...rest,
      },
      raw: parsed as Record<string, unknown>,
    };
    // exactOptionalPropertyTypes: drop the key entirely when email canal (no
    // preferredChannel mapping exists for it).
    if (payload.preferredChannel === undefined) delete payload.preferredChannel;

    let result;
    try {
      result = await ingestLead(opts.db, payload);
    } catch (err) {
      logger.error(
        { ip, err: err instanceof Error ? err.message : 'ingest error' },
        'website lead intake: ingest failed',
      );
      return c.json({ error: 'ingest_failed' }, 500);
    }

    // Best-effort management notification (English per comms mandate) — a
    // WAHA hiccup must never fail the lead ingest.
    if (opts.waha && opts.groupChatId) {
      const productLabel = PRODUCT_LABELS[insurance_type] ?? insurance_type;
      const canalLabel =
        canal === 'telephone' ? 'phone call' : canal === 'whatsapp' ? 'WhatsApp' : 'email';
      const text = [
        `🌐 New website lead — ${name}`,
        `Product: ${productLabel}`,
        `Phone: ${phone} (prefers ${canalLabel})`,
        `Email: ${email}`,
        ...(source_page ? [`Page: ${source_page}`] : []),
        ...(rest['utm_source'] ? [`Campaign: ${String(rest['utm_source'])}`] : []),
        result.dedup === 'matched_existing'
          ? 'Known customer — new signal added to their file.'
          : 'New customer — the sales agent is on it.',
      ].join('\n');
      opts.waha
        .sendText({ chatId: opts.groupChatId, text })
        .catch((err: unknown) =>
          logger.error(
            { err: err instanceof Error ? err.message : String(err), leadId: result.leadId },
            'website lead intake: WA group notification failed (lead ingested fine)',
          ),
        );
    }

    return c.json({ accepted: true }, 200);
  });

  return app;
}
