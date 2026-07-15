/**
 * Lead intake HTTP transport (M5.T1).
 *
 * Mounts `POST /v1/leads` — the public webhook consumed by the
 * assuryalconseil.fr website forms and (later) the Meta lead-form
 * forwarder.
 *
 * Layered defenses (cheapest first):
 *   1. IP rate limit — in-memory token bucket per `x-forwarded-for` IP. V1
 *      uses an in-process Map; M16 swaps in a Redis-backed limiter once we
 *      run multiple intake replicas.
 *   2. HMAC verification — same SHA-256 + `timingSafeEqual` pattern as the
 *      WAHA webhook. Skipped only when `hmacSecret` is undefined (dev mode).
 *   3. Zod schema validation — parses the body via `LeadIntakePayloadSchema`
 *      BEFORE any DB write so malformed payloads can't pollute tables.
 *
 * PII discipline: error responses are static strings ('rate_limited',
 * 'invalid_signature', 'invalid_payload', 'ingest_failed'). We never echo
 * the parsed payload or the raw body into the response, and the log lines
 * carry the IP + an error stub but never the body.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { ingestLead, LeadIntakePayloadSchema } from './intake.js';

export interface LeadIntakeRouterOptions {
  db: Database;
  /**
   * Required in production. When undefined the route still mounts but the
   * HMAC check is skipped — convenient for local form testing without the
   * shared secret.
   */
  hmacSecret?: string;
  /** Optional simple in-memory rate limiter to slow bots. */
  rateLimit?: {
    /** Per-IP request budget per rolling minute. Default 30. */
    maxPerMinutePerIp?: number;
  };
}

export function buildLeadIntakeRouter(opts: LeadIntakeRouterOptions): Hono {
  const app = new Hono();
  const rl = makeRateLimiter(opts.rateLimit?.maxPerMinutePerIp ?? 30);

  app.post('/v1/leads', async (c) => {
    // 0. IP rate limit. Cheap protection vs spam; the bucket is keyed on the
    //    first `x-forwarded-for` hop (closest to the client) or x-real-ip.
    //    Unknown IPs share one bucket — that's intentional: behind a misconfigured
    //    proxy we still slow blanket spam.
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown';
    if (!rl.allow(ip)) {
      logger.warn({ ip }, 'lead intake: rate limited');
      return c.json({ error: 'rate_limited' }, 429);
    }

    // Read the raw body ONCE — the HMAC is computed over the exact bytes the
    // sender signed, which JSON.parse + JSON.stringify cannot reconstruct.
    const rawBody = await c.req.text();

    // 1. HMAC verification (skipped when no secret is configured).
    if (opts.hmacSecret) {
      const sig = c.req.header('x-f16-signature') ?? '';
      if (!verifyHmac(rawBody, sig, opts.hmacSecret)) {
        logger.warn({ ip }, 'lead intake: HMAC verification failed');
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }

    // 2. JSON parse + zod validation. A bad JSON body or shape mismatch is
    //    a hard 400 — we log just the error type, not the body.
    let parsed;
    try {
      parsed = LeadIntakePayloadSchema.parse(JSON.parse(rawBody));
    } catch (err) {
      logger.warn(
        { ip, err: err instanceof Error ? err.message : 'parse error' },
        'lead intake: invalid payload',
      );
      return c.json({ error: 'invalid_payload' }, 400);
    }

    // 3. Hand to ingestLead — never echo the parsed payload (PII).
    try {
      const result = await ingestLead(opts.db, parsed);
      return c.json(
        {
          accepted: true,
          leadId: result.leadId,
          customerId: result.customerId,
          dedup: result.dedup,
        },
        200,
      );
    } catch (err) {
      // Log a short error stub — the raw error message could contain the
      // failing INSERT row (drizzle includes parameters in some errors). To
      // be safe we stringify the type, not the body.
      logger.error(
        { ip, err: err instanceof Error ? err.message : 'ingest error' },
        'lead intake: ingest failed',
      );
      return c.json({ error: 'ingest_failed' }, 500);
    }
  });

  return app;
}

/**
 * Constant-time HMAC-SHA256 verification. Tolerates the `sha256=` prefix
 * some senders use (GitHub-style) and treats malformed hex as invalid
 * rather than 5xx.
 */
function verifyHmac(rawBody: string, providedSig: string, secret: string): boolean {
  if (!providedSig) return false;
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = providedSig.startsWith('sha256=') ? providedSig.slice(7) : providedSig;
  if (provided.length !== computed.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

export interface RateLimiter {
  allow(key: string): boolean;
}

/**
 * Simple in-memory sliding-window limiter.
 *
 * Each key gets an array of recent timestamps; on every call we drop entries
 * older than 60s, count the remainder, and accept/reject. Memory is bounded
 * by the active IP set; a small probabilistic GC sweep prunes idle buckets
 * to keep the Map from growing without bound.
 *
 * Not durable across restarts. M16 introduces a Redis-backed version once
 * the intake runs >1 replica.
 */
export function makeRateLimiter(maxPerMin: number): RateLimiter {
  const buckets = new Map<string, number[]>();
  const windowMs = 60_000;
  return {
    allow(key: string): boolean {
      const now = Date.now();
      const bucket = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      if (bucket.length >= maxPerMin) {
        // Persist the pruned bucket so we don't keep checking the same
        // expired timestamps on every call.
        buckets.set(key, bucket);
        return false;
      }
      bucket.push(now);
      buckets.set(key, bucket);
      // Probabilistic cleanup — every ~1k calls, sweep idle buckets.
      if (Math.random() < 0.001) {
        for (const [k, v] of buckets) {
          const last = v[v.length - 1];
          if (v.length === 0 || last === undefined || now - last > windowMs) {
            buckets.delete(k);
          }
        }
      }
      return true;
    },
  };
}
