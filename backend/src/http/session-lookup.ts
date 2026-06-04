/**
 * Voice session-lookup HTTP route.
 *
 * Mounts `GET /v1/voice/session/:sessionId`. After Asterisk bridges an answered
 * call to AudioSocket, Pipecat knows only the AudioSocket UUID (= our F16
 * sessionId). It calls this route to resolve which lead/customer the call is
 * for, then drives the per-utterance brain via POST /v1/voice/turn.
 *
 * SECURITY — shared-secret header (not HMAC):
 *   A GET has no body, so the HMAC-over-body scheme used by /v1/voice/turn and
 *   /v1/leads doesn't apply. We gate on a shared secret in the
 *   `x-f16-internal-secret` header instead, compared in constant time. A
 *   missing/mismatched secret → 401. This is a server-to-server call (Pipecat →
 *   backend) over the trusted local network; the secret is rotatable via env.
 *   When `lookupSecret` is undefined the route still mounts but the check is
 *   skipped — dev only, mirroring the HMAC-optional pattern of the other routes.
 *
 * Responses:
 *   200 { leadId, customerId }   — session found
 *   401 { error: 'unauthorized' } — secret missing/mismatched
 *   404 { error: 'not_found' }    — session unknown/expired
 *
 * PII discipline: neither leadId nor customerId is PII (both UUIDs); we never
 * log the secret, and logs carry only the sessionId.
 */
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';
import { getSession, type RedisLike } from '../voice/session-store.js';

export interface SessionLookupOptions {
  /**
   * Shared secret required in the `x-f16-internal-secret` header. When
   * undefined the route mounts but skips the check (dev only).
   */
  lookupSecret?: string;
  /**
   * Optional redis override (tests inject a client bound to TEST_REDIS_URL).
   * Defaults to the app's shared singleton inside the session-store.
   */
  redis?: RedisLike;
}

/** Constant-time string compare that won't throw on length mismatch. */
function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function buildSessionLookupRouter(opts: SessionLookupOptions = {}): Hono {
  const app = new Hono();

  app.get('/v1/voice/session/:sessionId', async (c) => {
    // 1. Shared-secret gate (skipped only when no secret is configured).
    if (opts.lookupSecret) {
      const provided = c.req.header('x-f16-internal-secret') ?? '';
      if (!secretsMatch(provided, opts.lookupSecret)) {
        logger.warn({}, 'voice session-lookup: secret mismatch → 401');
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    // 2. Validate the path param.
    const sessionId = c.req.param('sessionId');
    if (!sessionId) {
      return c.json({ error: 'not_found' }, 404);
    }

    // 3. Resolve from the session store.
    const session = opts.redis
      ? await getSession(sessionId, opts.redis)
      : await getSession(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'voice session-lookup: unknown session → 404');
      return c.json({ error: 'not_found' }, 404);
    }

    return c.json({ leadId: session.leadId, customerId: session.customerId }, 200);
  });

  return app;
}
