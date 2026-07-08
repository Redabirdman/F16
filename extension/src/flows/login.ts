/**
 * login.ensure flow — V1 Chrome-extension Maxance driver.
 *
 * Massively simpler than the Stagehand M8.T2 step planner because the
 * extension runs INSIDE Ridaa's daily Chrome — the cookies, the device
 * trust, Cloudflare Turnstile bypass — all already in place. We don't
 * need to type a password, click "Se souvenir 30 jours", or wait for
 * SMS. We just confirm the operator is on Proximéo home (or get them
 * there from the dashboard).
 *
 * Three cases:
 *   1. Already on Proximéo home → return alreadyLoggedIn=true.
 *   2. On the extranet dashboard → click "Accès Proximéo", wait for the
 *      SSO bounce, return.
 *   3. On the public login form → return requiredHumanAction=true with
 *      a clear errorCode so the backend escalates to the operator. We
 *      will NOT enter credentials — that's Ridaa's job (once per ~30
 *      days when the Auth0 cookie expires).
 */
import { clickByText, captureScreenshot, waitForUrl } from '../dom.js';
import { PROXIMEO_URL_SIGNATURES, PROXIMEO_SSO_URL } from '../maxance/selectors.js';
import {
  LoginEnsureResponseSchema,
  ErrorResponseSchema,
  type LoginEnsureCommandSchema,
  type Response,
} from '../wire.js';
import type { z } from 'zod';

type LoginEnsureCommand = z.infer<typeof LoginEnsureCommandSchema>;

/** What URL pattern we think we're currently on. */
function classifyCurrentUrl(href: string): 'proximeo_home' | 'dashboard' | 'login' | 'other' {
  const u = new URL(href);
  // Proximéo home: Proximeo path OR the SSO callback OR after-quote pages.
  if (u.hostname === 'www.maxance.com' && u.pathname.startsWith('/Proximeo/')) {
    return 'proximeo_home';
  }
  if (
    u.hostname === 'extranet.maxance.com' &&
    u.pathname.startsWith(PROXIMEO_URL_SIGNATURES.dashboard)
  ) {
    return 'dashboard';
  }
  if (u.hostname.endsWith('ciam.vilavi.fr') || u.pathname.includes('login')) {
    return 'login';
  }
  return 'other';
}

export async function runLoginEnsure(cmd: LoginEnsureCommand): Promise<Response> {
  const t0 = Date.now();
  const initialUrl = location.href;
  const initial = classifyCurrentUrl(initialUrl);

  try {
    // Case 1 — already on Proximéo home. Cheap warm path.
    if (initial === 'proximeo_home') {
      return LoginEnsureResponseSchema.parse({
        id: cmd.id,
        kind: 'login.ensure.ok',
        alreadyLoggedIn: true,
        requiredHumanAction: false,
        finalUrl: location.href,
        durationMs: Date.now() - t0,
      });
    }

    // Case 3 — login form. The operator (Ridaa) signs in manually.
    if (initial === 'login') {
      return ErrorResponseSchema.parse({
        id: cmd.id,
        kind: 'error',
        errorCode: 'maxance_login_required_human_action',
        detail: 'Auth0 cookie expired or never set — Ridaa must sign in manually with SMS code',
      });
    }

    // Case 2 — extranet dashboard. Click "Accès Proximéo" and wait for
    // the SSO bounce. The fallback is direct navigation if the sidebar
    // click misses (some dashboard layouts use a dropdown instead).
    if (initial === 'dashboard') {
      try {
        await clickByText('Accès Proximéo', { timeoutMs: 5_000, label: 'acces_proximeo' });
      } catch {
        // Fallback: navigate directly to the SSO entry URL.
        location.assign(PROXIMEO_SSO_URL);
      }
      await waitForUrl(
        (u) => u.hostname === 'www.maxance.com' && u.pathname.startsWith('/Proximeo/'),
        {
          timeoutMs: cmd.timeoutMs ?? 30_000,
          label: 'await_proximeo_home',
        },
      );
      const shot = await captureScreenshot('login_proximeo_home_after_sso');
      return LoginEnsureResponseSchema.parse({
        id: cmd.id,
        kind: 'login.ensure.ok',
        alreadyLoggedIn: false,
        requiredHumanAction: false,
        finalUrl: location.href,
        durationMs: Date.now() - t0,
        // schema doesn't include screenshots on login but we capture for the operator UI via progress
        screenshots: [shot],
      });
    }

    // Case 4 — anything else. Try a direct navigation to Proximéo home.
    location.assign(PROXIMEO_SSO_URL);
    await waitForUrl(
      (u) => u.hostname === 'www.maxance.com' && u.pathname.startsWith('/Proximeo/'),
      {
        timeoutMs: cmd.timeoutMs ?? 30_000,
        label: 'await_proximeo_home_from_other',
      },
    );
    return LoginEnsureResponseSchema.parse({
      id: cmd.id,
      kind: 'login.ensure.ok',
      alreadyLoggedIn: false,
      requiredHumanAction: false,
      finalUrl: location.href,
      durationMs: Date.now() - t0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Re-classify BEFORE reporting (2026-07-08, Achraf's run: the tab sat on
    // the public maxance.com homepage with a dead Auth0 session — the SSO
    // bounce timed out and surfaced as an opaque maxance_login_unknown).
    // If we ended up on the login form, any password page, or we're STILL
    // on the public site after attempting the SSO entry, the session is
    // dead and only Ridaa can fix it → surface the STRUCTURED
    // login-required code so the backend PARKS the quote (short retry,
    // auto-resume after login) and pings the group exactly once.
    const here = new URL(location.href);
    const stuckLoggedOut =
      classifyCurrentUrl(location.href) === 'login' ||
      document.querySelector('input[type="password"]') !== null ||
      (here.hostname === 'www.maxance.com' && !here.pathname.startsWith('/Proximeo/'));
    if (stuckLoggedOut) {
      return ErrorResponseSchema.parse({
        id: cmd.id,
        kind: 'error',
        errorCode: 'maxance_login_required_human_action',
        detail: `session dead — landed on ${here.hostname}${here.pathname.slice(0, 60)} (${msg.slice(0, 120)})`,
      });
    }
    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: msg.startsWith('maxance_') ? msg.split(':')[0] : 'maxance_login_unknown',
      detail: msg.slice(0, 240),
    });
  }
}
