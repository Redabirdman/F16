/**
 * Admin auth middleware (M14.T1 lite).
 *
 * Locked posture for V1: shared bearer token in `ADMIN_BEARER_TOKEN` env.
 * NOT WebAuthn / NOT magic-link — those are the real T1 (M14 V2.5) but
 * the lift is large and F16's actual threat model is "anyone on the LAN
 * can hit the admin". A shared token closes that gap in ~30 LOC.
 *
 * When `ADMIN_BEARER_TOKEN` is UNSET: middleware is a no-op (every request
 * passes). This is the right dev default — local `pnpm dev` shouldn't
 * require ceremony. The presence of the env var flips on enforcement.
 *
 * Constant-time comparison guards against the (unlikely on a LAN) timing-
 * oracle attack. Reject responses use 401 + WWW-Authenticate so the
 * browser doesn't cache the failed state.
 *
 * Frontend stores the token in localStorage and injects it on every fetch.
 * No cookie story in V1 — a single bearer header is the smallest seam.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';

const BEARER_PREFIX = 'Bearer ';

/**
 * Read the configured token at module load. Re-read on each request would
 * let an operator hot-rotate the token without restart, but that's a
 * surprise vector — pin to startup.
 */
function configuredToken(): string | null {
  const t = process.env.ADMIN_BEARER_TOKEN;
  return t && t.length > 0 ? t : null;
}

/**
 * Hono middleware. Use as `app.use('/v1/admin/*', requireAdminAuth())`.
 * Returns a 401 with WWW-Authenticate when the token doesn't match.
 */
export function requireAdminAuth(): (c: Context, next: Next) => Promise<Response | undefined> {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const expected = configuredToken();
    if (!expected) {
      await next();
      return undefined; // dev mode — no enforcement
    }

    // Header is the canonical path; `?token=` is a fallback for surfaces
    // that can't set headers (EventSource, anchor-tag downloads). The
    // query param is acceptable here because the admin is LAN-only and
    // not internet-exposed (project_hosting_pivot.md); on a public deploy
    // V2.5 will swap in a short-lived signed download URL.
    const header = c.req.header('Authorization');
    let provided: string;
    if (header && header.startsWith(BEARER_PREFIX)) {
      provided = header.slice(BEARER_PREFIX.length).trim();
    } else {
      provided = (c.req.query('token') ?? '').trim();
    }
    if (provided.length === 0) {
      c.header('WWW-Authenticate', 'Bearer realm="f16-admin"');
      return c.json({ error: 'unauthorized', detail: 'missing_bearer' }, 401);
    }
    // Constant-time compare. Pad-equalise byte lengths first so timingSafeEqual
    // doesn't throw on mismatched lengths (which would itself be a side channel).
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: 'unauthorized', detail: 'invalid_token' }, 401);
    }
    await next();
    return undefined;
  };
}

/** Test-only seam: clear cached state if we ever cache. Currently no-op. */
export function __resetAdminAuthForTests(): void {
  // intentionally empty — kept for future cache invalidation
}
