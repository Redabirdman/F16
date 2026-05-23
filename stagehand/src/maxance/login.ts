/**
 * Maxance login + SSO-bootstrap flow (M8.T2).
 *
 * Encodes Achraf's walkthrough (`Assuryal/Maxance insstructions/ETAPE MAXANCE AI.pdf`)
 * as a deterministic Stagehand step planner. The function opens the broker
 * portal, signs in, follows the "Accès Proximéo" SSO bounce, and confirms the
 * Proximéo home — STOPPING before any state-mutating click.
 *
 * Side-effects:
 *   - Captures one screenshot per material step (pre-submit, post-submit,
 *     post-SSO). Files land under `<dataRoot>/screenshots/`; the URL surfaced
 *     in the result uses the same `/v1/static/screenshots/...` path the M8.T1
 *     intent layer already serves.
 *   - Pauses on the SMS-prompt branch to call `humanActionResolver`, which
 *     M8.T4 will wire to the backend's HUMAN_ACTION queue. The login function
 *     stays Maxance-agnostic — it doesn't import any backend code.
 *
 * Credentials handling:
 *   - Username + password are read FROM `process.env` AT CALL TIME (never
 *     captured at module load or in closures that outlive the call). They're
 *     passed to Stagehand v3's `act({ variables })` so the LLM sees the
 *     placeholder name (`%password%`) and never the real value in its
 *     reasoning trace.
 *   - On error: we wrap with a sanitiser that strips any substring matching
 *     the actual creds, so a Stagehand trace that accidentally echoes them
 *     can't escape into the API response or logs.
 */
import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type {
  HumanActionResolver,
  MaxanceLoginOptions,
  MaxanceLoginResult,
  MaxanceLoginScreenshot,
  MaxancePageType,
} from './types.js';

const PROXIMEO_SSO_URL = 'https://www.maxance.com/Proximeo/ConnexionCourtierSSO.do';
const DEFAULT_2FA_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Read the live-run settle-delay budget. The login flow waits this many ms
 * between act calls to let Maxance's SPA swap pages. Tests override to 0 via
 * `MAXANCE_LOGIN_STEP_DELAY_MS=0` so the stubbed-Stagehand cases run fast.
 */
function settleMs(defaultMs: number): number {
  const raw = process.env.MAXANCE_LOGIN_STEP_DELAY_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return defaultMs;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((r) => setTimeout(r, ms));
}

const PAGE_TYPE_VALUES = [
  'login_form',
  'password_form',
  'dashboard',
  'sms_prompt',
  'proximeo_home',
  'error_page',
  'unknown',
] as const;

/**
 * Zod schema fed to `stagehand.extract`. The page-type label is the only
 * branching key — keep the prompt narrow so the LLM doesn't invent labels.
 */
const PageDetectionSchema = z.object({
  pageType: z.enum(PAGE_TYPE_VALUES),
});

const PageDetectionInstruction =
  'Identify which Maxance authentication page is currently displayed. Use exactly one of these labels:' +
  ' "login_form" (step 1 — only an "Identifiant" field is visible, no password field, with a "Continuer" button),' +
  ' "password_form" (step 2 — heading "Saisissez votre mot de passe" with a "Mot de passe" field visible and a "Modifier" link next to the previously-entered identifiant),' +
  ' "sms_prompt" (a one-time SMS / code verification is being requested — heading "Vérifiez votre identité" and "Code MFA" field),' +
  ' "proximeo_home" (the broker is logged in and the quote-creation home is visible — i.e. the' +
  ' "Faire un devis pour un nouveau client" heading is shown above a grid of vehicle / product cards' +
  ' such as Auto, Camping car, VSP, Deux Roues, Nouvelles mobilités, Habitation, Santé. The MaXance' +
  ' sidebar may also be visible — that is fine, still "proximeo_home". This is also valid when the' +
  ' top menu shows "Tarif - Nouveau Client"),' +
  ' "dashboard" (logged-in broker view that does NOT show the "Faire un devis" card grid — e.g. a' +
  ' contracts list, a documentation page, or another sub-tab),' +
  ' "error_page" (an explicit error / locked-account / rate-limit page),' +
  ' "unknown" (anything else, including a blank page or a cookie-consent banner).' +
  ' IMPORTANT: if BOTH the sidebar AND the "Faire un devis" card grid are visible, ALWAYS pick' +
  ' "proximeo_home" — the card grid is the stronger signal.';

const ProximeoConfirmInstruction =
  'Is the Maxance quote-creation home currently loaded? It shows the heading' +
  ' "Faire un devis pour un nouveau client" above a grid of vehicle / product cards' +
  ' (Auto, Camping car, VSP, Deux Roues, Nouvelles mobilités, Habitation, Santé, etc.).' +
  ' The MaXance sidebar may also be visible — that is fine. Answer only the pageType,' +
  ' preferring "proximeo_home" when the card grid is visible regardless of sidebar.';

/**
 * Read MAXANCE_USERNAME / MAXANCE_PASSWORD at call time. Throws cleanly if
 * either is missing — without echoing the env value. The error message is
 * safe to surface.
 */
function readCredentialsOrThrow(): { username: string; password: string; baseUrl: string } {
  const username = process.env.MAXANCE_USERNAME;
  const password = process.env.MAXANCE_PASSWORD;
  const baseUrl = process.env.MAXANCE_BASE_URL;
  if (!username || username.startsWith('<') || username === '') {
    throw new Error('MAXANCE_USERNAME unset or placeholder');
  }
  if (!password || password.startsWith('<') || password === '') {
    throw new Error('MAXANCE_PASSWORD unset or placeholder');
  }
  if (!baseUrl) {
    throw new Error('MAXANCE_BASE_URL unset');
  }
  return { username, password, baseUrl };
}

/**
 * Build a sanitiser that replaces any occurrence of the live creds with
 * `<redacted>`. Used on every error message and on optional structured logs.
 * We keep this scoped to the call site so the secrets don't live in a
 * module-level variable.
 */
function makeRedactor(secrets: string[]): (s: string) => string {
  const escaped = secrets
    .filter((v) => v.length > 0)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return (s) => s;
  const re = new RegExp(escaped.join('|'), 'g');
  return (s: string) => s.replace(re, '<redacted>');
}

/**
 * Capture one screenshot of the active page. Best-effort: a screenshot
 * failure is logged but doesn't fail the step (we still need the login flow
 * to proceed on a flaky disk).
 */
async function captureStep(
  stagehand: Stagehand,
  sessionId: string,
  step: string,
  dataRoot: string,
  callback?: (shot: MaxanceLoginScreenshot) => void,
): Promise<MaxanceLoginScreenshot | undefined> {
  try {
    const page = stagehand.context.activePage();
    if (!page) return undefined;
    const dir = join(dataRoot, 'screenshots');
    await mkdir(dir, { recursive: true });
    const filename = `${sessionId}-${Date.now()}-maxance-${step}.png`;
    const png = await page.screenshot({ type: 'png', fullPage: false });
    await writeFile(join(dir, filename), png);
    const shot: MaxanceLoginScreenshot = {
      step,
      url: `/v1/static/screenshots/${filename}`,
    };
    callback?.(shot);
    return shot;
  } catch (err) {
    logger.warn({ err, sessionId, step }, 'maxance: screenshot capture failed');
    return undefined;
  }
}

/**
 * Cloudflare IUAM challenge interstitial detection. While the IUAM page is up,
 * the document.title is "Just a moment..." (i18n: same string in all locales).
 *
 * Resolution paths:
 *   1. Cloudflare auto-passes (5-30s) for clients holding a valid cf_clearance
 *      cookie. Happy path.
 *   2. Cloudflare shows a Turnstile checkbox that requires a human click. The
 *      visible Chromium window lets the operator click it; we just keep
 *      polling the title.
 *
 * Default budget is 5 min — covers both paths comfortably. Cheap polling:
 * just reads page.title() — no LLM call, no DOM extract.
 *
 * Override via `MAXANCE_CLOUDFLARE_WAIT_MS` env for tests / impatient runs.
 */
async function waitForCloudflareIuam(
  page: { title: () => Promise<string> },
  sessionId: string,
  maxWaitMs = Number(process.env.MAXANCE_CLOUDFLARE_WAIT_MS ?? 10 * 60_000),
  pollIntervalMs = 500,
): Promise<void> {
  const start = Date.now();
  let sawChallenge = false;
  let nextReminderAt = 0;
  while (Date.now() - start < maxWaitMs) {
    let title = '';
    try {
      title = await page.title();
    } catch {
      // Title fetch transient errors during navigation are expected.
      title = '';
    }
    if (!title.includes('Just a moment')) {
      if (sawChallenge) {
        logger.info(
          { sessionId, elapsedMs: Date.now() - start },
          'maxance: Cloudflare IUAM cleared',
        );
        // eslint-disable-next-line no-console
        console.log(
          `\n✓ Cloudflare challenge cleared after ${Math.round(
            (Date.now() - start) / 1000,
          )}s — continuing.\n`,
        );
      }
      return;
    }
    if (!sawChallenge) {
      sawChallenge = true;
      logger.warn(
        { sessionId, maxWaitMs },
        'maxance: Cloudflare IUAM challenge detected — needs human click in visible browser',
      );
      // Print a LOUD console message that's easy to spot in the test output.
      // The Chromium window may be behind other windows — switch to it via
      // the OS taskbar/dock and look for "Verify you are human".
      // eslint-disable-next-line no-console
      console.log(
        '\n' +
          '═══════════════════════════════════════════════════════════════\n' +
          '🛡️  CLOUDFLARE CHALLENGE — manual action needed\n' +
          '═══════════════════════════════════════════════════════════════\n' +
          '   Switch to the visible Chromium window (Maxance tab).\n' +
          '   Click the "Verify you are human" checkbox.\n' +
          '   The test will continue automatically once you pass.\n' +
          '   Window may be hidden behind your current view — check the taskbar.\n' +
          '═══════════════════════════════════════════════════════════════\n',
      );
      nextReminderAt = Date.now() + 60_000;
    } else if (Date.now() >= nextReminderAt) {
      // Repeated reminder every 60s so the operator notices if they walked away.
      // eslint-disable-next-line no-console
      console.log(
        `[cloudflare] still waiting for human click — ${Math.round(
          (Date.now() - start) / 1000,
        )}s elapsed, ${Math.round((maxWaitMs - (Date.now() - start)) / 1000)}s remaining`,
      );
      nextReminderAt = Date.now() + 60_000;
    }
    await sleep(pollIntervalMs);
  }
  logger.warn(
    { sessionId, maxWaitMs },
    'maxance: Cloudflare IUAM did not pass within budget — proceeding anyway, detectPage will likely return unknown',
  );
}

/**
 * Run one page-type detection. Wraps `stagehand.extract` with our narrow
 * schema and returns the label. Retries up to `attempts` times on `unknown`,
 * waiting `waitMs` between tries — defends against slow client-side renders
 * (Maxance is a JSP app whose login form is painted in a second pass).
 *
 * Best-effort dismisses an "Accepter / Tout accepter / Continuer" cookie
 * banner between the first and second attempt — common cause of `unknown`
 * on a cold visit.
 */
async function detectPage(
  stagehand: Stagehand,
  attempts = 3,
  waitMs = 1500,
): Promise<MaxancePageType> {
  let last: MaxancePageType = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const out = await stagehand.extract(PageDetectionInstruction, PageDetectionSchema);
    last = out.pageType;
    if (last !== 'unknown') return last;
    // On the first unknown, try to dismiss the cookie / CGU banner before
    // retrying. Stagehand's `act` is a no-op if no such element exists, so
    // this is safe to call unconditionally.
    if (i === 0) {
      try {
        await stagehand.act(
          'If a cookie consent or "Accepter" / "Tout accepter" / "Continuer" banner is visible, click it to dismiss. Otherwise do nothing.',
        );
      } catch {
        // Banner-dismiss best-effort; ignore.
      }
    }
    await sleep(settleMs(waitMs));
  }
  return last;
}

/**
 * Collect a small diagnostic payload to embed in the `unknown` error message.
 * Includes the live URL + the page title so the operator can tell from the
 * error alone whether we got redirected, blocked, or just couldn't classify.
 */
async function pageDiagnostic(stagehand: Stagehand): Promise<string> {
  try {
    const page = stagehand.context.activePage();
    if (!page) return 'no_active_page';
    const url = page.url();
    let title = '';
    try {
      title = await page.title();
    } catch {
      title = '<no_title>';
    }
    return `url=${url}|title=${title.slice(0, 120)}`;
  } catch {
    return 'diagnostic_unavailable';
  }
}

/**
 * Race a promise against a wall-clock timeout. Used to bound the 2FA wait.
 * Resolves with the resolver's value or rejects with `maxance_2fa_timeout`.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Maximum number of SMS-code attempts per login. If the human pastes a wrong
 * or expired code, we re-prompt (rather than tearing down the browser session
 * and burning a fresh SMS-send to Achraf on the next run).
 */
const MAX_SMS_ATTEMPTS = 3;

/**
 * Manual-MFA mode: the agent stops on the MFA screen and lets a human type the
 * code, tick "30 days", and click Continuer in the visible Chromium window.
 * We just poll until the page changes. Used during the first-of-the-month
 * bootstrap when relaying the code via env-var would race the SMS TTL.
 *
 * Returns the new pageType when the human has advanced. Throws on timeout.
 */
async function waitForManualSmsCompletion(
  stagehand: Stagehand,
  timeoutMs: number,
  pollIntervalMs: number,
  sessionId: string,
): Promise<MaxancePageType> {
  const start = Date.now();
  logger.info(
    { sessionId, timeoutMs },
    'maxance: manual-MFA mode — waiting for human to complete the SMS challenge in the open browser',
  );
  // First detection is implicit (caller already classified as sms_prompt).
  // Loop on a single (no-retry) extract so each poll is one cheap LLM call.
  while (Date.now() - start < timeoutMs) {
    await sleep(pollIntervalMs);
    let pageType: MaxancePageType;
    try {
      // Single-shot — no retries on 'unknown' here. The human is mid-typing,
      // brief 'unknown' states are normal and we just want to keep polling.
      const out = await stagehand.extract(PageDetectionInstruction, PageDetectionSchema);
      pageType = out.pageType;
    } catch (err) {
      logger.warn({ err, sessionId }, 'maxance: manual-MFA poll extract failed, retrying');
      continue;
    }
    if (pageType !== 'sms_prompt' && pageType !== 'unknown') {
      logger.info(
        { sessionId, pageType, elapsedMs: Date.now() - start },
        'maxance: manual-MFA — human advanced past SMS challenge',
      );
      return pageType;
    }
  }
  throw new Error('maxance_2fa_timeout');
}

/**
 * Handle the SMS-prompt branch: ask the human for the code, submit it, and on
 * rejection ("Le code que vous avez saisi n'est pas valide") re-prompt up to
 * MAX_SMS_ATTEMPTS times. Returns the new pageType after a successful submit.
 * Throws on timeout or after exhausting retries.
 */
async function handleSmsPrompt(
  stagehand: Stagehand,
  resolver: HumanActionResolver,
  timeoutMs: number,
  sessionId: string,
): Promise<MaxancePageType> {
  for (let attempt = 1; attempt <= MAX_SMS_ATTEMPTS; attempt++) {
    const correlationId = `maxance-2fa-${sessionId}-${attempt}`;
    const summarySuffix =
      attempt === 1
        ? ''
        : ` (attempt ${attempt}/${MAX_SMS_ATTEMPTS} — the previous code was rejected by Maxance)`;
    const code = await withTimeout(
      resolver({
        summary:
          'Maxance broker portal is asking for the monthly SMS verification code. Please paste the 6-digit code Achraf received.' +
          summarySuffix,
        options: [{ type: 'free_text', label: 'SMS code' }],
        correlationId,
      }),
      timeoutMs,
      'maxance_2fa_timeout',
    );
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new Error('maxance_2fa_empty_code');
    }
    await stagehand.act('Fill the "Code MFA" SMS verification code field with %code%', {
      variables: { code: code.trim() },
    });
    // Critical (first attempt only — Maxance keeps the checkbox state across
    // retries). Tick "Se souvenir de cet appareil pendant 30 jours" so the
    // next 30 days of logins don't re-prompt for SMS. Per Achraf, the session
    // window is ~1 month — that's this checkbox. Soft-fail if it's missing.
    if (attempt === 1) {
      try {
        await stagehand.act(
          'If a checkbox labelled "Se souvenir de cet appareil pendant 30 jours" is present and unchecked, tick it. Otherwise do nothing.',
        );
      } catch (err) {
        logger.warn({ err, sessionId }, 'maxance: remember-device checkbox tick failed');
      }
    }
    await stagehand.act(
      'Click the "Continuer" button to submit the MFA verification code (also labelled "Valider" or "Confirmer" on some variants)',
    );
    const next = await detectPage(stagehand);
    if (next !== 'sms_prompt') {
      // Either dashboard / proximeo_home (success) or error_page (give up).
      return next;
    }
    logger.warn(
      { sessionId, attempt },
      'maxance: SMS code rejected by Maxance — re-prompting human',
    );
  }
  throw new Error('maxance_2fa_exhausted');
}

/**
 * Main entry point. See module-level doc for the full step plan.
 */
export async function loginMaxance(
  stagehand: Stagehand,
  sessionId: string,
  opts: MaxanceLoginOptions,
): Promise<MaxanceLoginResult> {
  const t0 = Date.now();
  const { username, password, baseUrl } = readCredentialsOrThrow();
  const redact = makeRedactor([username, password]);
  const dataRoot = opts.dataRoot ?? process.env.STAGEHAND_DATA_DIR ?? './data';
  const twoFactorTimeoutMs = opts.twoFactorTimeoutMs ?? DEFAULT_2FA_TIMEOUT_MS;
  const screenshots: MaxanceLoginScreenshot[] = [];

  const pushShot = async (step: string): Promise<void> => {
    const s = await captureStep(stagehand, sessionId, step, dataRoot, opts.screenshotCallback);
    if (s) screenshots.push(s);
  };

  try {
    const page = stagehand.context.activePage();
    if (!page) throw new Error('maxance_no_active_page');

    // Step 1: navigate to the broker portal. We deliberately use
    // `domcontentloaded` (not `networkidle`) because Maxance keeps a few
    // tracking pixels open indefinitely; `networkidle` would time out.
    // Instead we follow up with a short sleep so the JSP's second-pass
    // form render finishes before we screenshot/detect.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await sleep(settleMs(1500));

    // Cloudflare IUAM ("Just a moment...") sometimes interstitials the very
    // first navigation. Auto-pass is usually 5-15s for clients with valid
    // cf_clearance — we wait up to ~30s before giving up. Pure title check;
    // no LLM call so this is cheap to poll tightly.
    await waitForCloudflareIuam(page, sessionId);
    await pushShot('initial_load');

    // Step 2: classify what's on screen (with retry + cookie-banner dismiss).
    let pageType = await detectPage(stagehand);
    let alreadyLoggedIn = false;
    let requiredHumanAction = false;

    // Branch on the initial detection.
    if (pageType === 'dashboard') {
      alreadyLoggedIn = true;
    } else if (pageType === 'sms_prompt') {
      // The previous run left us mid-prompt — surface to the human.
      requiredHumanAction = true;
      pageType = opts.manualSmsHandling
        ? await waitForManualSmsCompletion(
            stagehand,
            twoFactorTimeoutMs,
            opts.manualSmsPollIntervalMs ?? 2000,
            sessionId,
          )
        : await handleSmsPrompt(stagehand, opts.humanActionResolver, twoFactorTimeoutMs, sessionId);
      await pushShot('post_2fa');
    } else if (pageType === 'login_form' || pageType === 'password_form') {
      // Maxance auth is a two-step OAuth-style flow:
      //   step 1 ("login_form")   — Identifiant only, click Continuer
      //   step 2 ("password_form") — Mot de passe field, click Continuer
      // We may land on step 2 directly if the browser remembered the
      // identifiant from a previous session (rare on a fresh userDataDir,
      // common on subsequent runs).
      if (pageType === 'login_form') {
        await stagehand.act('Fill the "Identifiant" field with %username%', {
          variables: { username },
        });
        await pushShot('identifiant_filled');
        // Click prompt deliberately avoids the word "password" so callers that
        // grep `instruction.includes('password')` for the variable-bearing act
        // don't pick up this click instead.
        await stagehand.act(
          'Click the Continuer button to confirm the identifiant and move forward',
        );
        // Give the SPA a moment to swap to the password page.
        await sleep(settleMs(1500));
        await pushShot('post_identifiant_submit');
        pageType = await detectPage(stagehand);
      }

      if (pageType === 'password_form') {
        await stagehand.act('Fill the "Mot de passe" field with %password%', {
          variables: { password },
        });
        await pushShot('password_filled');
        await stagehand.act('Click the Continuer button to sign in after the Mot de passe field');
        // Auth roundtrip + redirect to dashboard / SSO can take a couple of seconds.
        await sleep(settleMs(2500));
        await pushShot('post_password_submit');
        pageType = await detectPage(stagehand);
      }

      if (pageType === 'sms_prompt') {
        requiredHumanAction = true;
        pageType = opts.manualSmsHandling
          ? await waitForManualSmsCompletion(
              stagehand,
              twoFactorTimeoutMs,
              opts.manualSmsPollIntervalMs ?? 2000,
              sessionId,
            )
          : await handleSmsPrompt(
              stagehand,
              opts.humanActionResolver,
              twoFactorTimeoutMs,
              sessionId,
            );
        await pushShot('post_2fa');
      }
      if (pageType === 'login_form' || pageType === 'password_form') {
        // Form re-rendered → either bad creds, locked account, or rate-limit.
        const diag = await pageDiagnostic(stagehand);
        throw new Error(`maxance_bad_credentials|${diag}`);
      }
      if (pageType === 'error_page') {
        throw new Error('maxance_error_page');
      }
    } else {
      // unknown / error_page / proximeo_home (unexpectedly already there).
      if (pageType === 'proximeo_home') {
        alreadyLoggedIn = true;
      } else {
        const diag = await pageDiagnostic(stagehand);
        throw new Error(`maxance_unexpected_initial_page:${pageType}|${diag}`);
      }
    }

    // At this point we expect to be on the dashboard (or already on Proximéo).
    if (pageType !== 'dashboard' && pageType !== 'proximeo_home') {
      throw new Error(`maxance_unexpected_post_login_page:${pageType}`);
    }

    // Step 9: bounce through Proximéo SSO if not already there. We prefer the
    // sidebar click over a direct GET so the session cookie is set the way
    // Maxance's SSO bounce expects (some flows blank-page on a cold GET).
    if (pageType === 'dashboard') {
      let proximeoClickFailed = false;
      try {
        await stagehand.act(
          'Click the "Accès Proximéo" link in the left sidebar of the broker dashboard',
        );
      } catch (err) {
        // Soft-fail to direct navigation. The exact label can drift; the SSO
        // URL is stable. Log redacted in case the trace includes anything sensitive.
        logger.warn(
          { err: redact(String(err)), sessionId },
          'maxance: Accès Proximéo click failed, falling back to direct SSO URL',
        );
        proximeoClickFailed = true;
      }
      if (proximeoClickFailed) {
        await page.goto(PROXIMEO_SSO_URL, { waitUntil: 'domcontentloaded' });
      }
      await pushShot('proximeo_post_sso');
    }

    // Step 10: confirm we actually landed on the Proximéo home.
    const confirm = await stagehand.extract(ProximeoConfirmInstruction, PageDetectionSchema);
    if (confirm.pageType !== 'proximeo_home') {
      throw new Error(`maxance_proximeo_not_loaded:${confirm.pageType}`);
    }
    await pushShot('proximeo_home_confirmed');

    return {
      sessionId,
      durationMs: Date.now() - t0,
      screenshots,
      alreadyLoggedIn,
      requiredHumanAction,
      finalUrl: page.url(),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const sanitised = redact(raw);
    logger.warn({ sessionId, err: sanitised }, 'maxance: login failed');
    // Re-throw with the redacted message so HTTP responses and upstream traces
    // can't accidentally surface creds — keep the original error type if possible.
    throw new Error(sanitised);
  }
}
