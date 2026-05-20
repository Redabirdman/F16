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

const PAGE_TYPE_VALUES = [
  'login_form',
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
  'Identify which Maxance page is currently displayed. Use exactly one of these labels:' +
  ' "login_form" (the broker login form with username and password fields is visible),' +
  ' "dashboard" (the Maxance broker dashboard is shown — "MaXance" header and a sidebar with' +
  ' "Accès Proximéo" or "Mon tableau de bord" is visible),' +
  ' "sms_prompt" (a one-time SMS / code verification is being requested),' +
  ' "proximeo_home" (the Proximéo home is shown — top menu includes "Tarif - Nouveau Client" or' +
  ' a heading "Faire un devis pour un nouveau client" is visible),' +
  ' "error_page" (an explicit error / locked-account / rate-limit page),' +
  ' "unknown" (anything else, including a blank page or a cookie-consent banner).';

const ProximeoConfirmInstruction =
  'Has the Proximéo home page loaded? Look for the top menu item "Tarif - Nouveau Client",' +
  ' or a heading like "Faire un devis pour un nouveau client". Answer only the pageType.';

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
 * Run one page-type detection. Wraps `stagehand.extract` with our narrow
 * schema and returns the label.
 */
async function detectPage(stagehand: Stagehand): Promise<MaxancePageType> {
  const out = await stagehand.extract(PageDetectionInstruction, PageDetectionSchema);
  return out.pageType;
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
 * Handle the SMS-prompt branch: ask the human for the code, then submit it.
 * Returns the new pageType after submitting. Throws on timeout.
 */
async function handleSmsPrompt(
  stagehand: Stagehand,
  resolver: HumanActionResolver,
  timeoutMs: number,
  sessionId: string,
): Promise<MaxancePageType> {
  const correlationId = `maxance-2fa-${sessionId}`;
  const code = await withTimeout(
    resolver({
      summary:
        'Maxance broker portal is asking for the monthly SMS verification code. Please paste the 6-digit code Achraf received.',
      options: [{ type: 'free_text', label: 'SMS code' }],
      correlationId,
    }),
    timeoutMs,
    'maxance_2fa_timeout',
  );
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error('maxance_2fa_empty_code');
  }
  await stagehand.act('Fill the SMS verification code field with %code%', {
    variables: { code: code.trim() },
  });
  await stagehand.act(
    'Click the button that submits the SMS verification code (typically labelled "Valider", "Confirmer", or "Suivant")',
  );
  return detectPage(stagehand);
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

    // Step 1: navigate to the broker portal.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await pushShot('initial_load');

    // Step 2: classify what's on screen.
    let pageType = await detectPage(stagehand);
    let alreadyLoggedIn = false;
    let requiredHumanAction = false;

    // Branch on the initial detection.
    if (pageType === 'dashboard') {
      alreadyLoggedIn = true;
    } else if (pageType === 'sms_prompt') {
      // The previous run left us mid-prompt — surface to the human.
      requiredHumanAction = true;
      pageType = await handleSmsPrompt(
        stagehand,
        opts.humanActionResolver,
        twoFactorTimeoutMs,
        sessionId,
      );
      await pushShot('post_2fa');
    } else if (pageType === 'login_form') {
      // Fill creds via Stagehand variable substitution — the LLM only sees
      // the placeholder names. v3 substitutes the real values into the DOM
      // at action time without exposing them in its reasoning trace.
      await stagehand.act('Fill the username / identifiant field with %username%', {
        variables: { username },
      });
      await stagehand.act('Fill the password / mot de passe field with %password%', {
        variables: { password },
      });
      await pushShot('credentials_filled');
      await stagehand.act(
        'Click the login submit button (typically labelled "Connexion", "Se connecter", or "Valider")',
      );
      await pushShot('post_submit');
      pageType = await detectPage(stagehand);

      if (pageType === 'sms_prompt') {
        requiredHumanAction = true;
        pageType = await handleSmsPrompt(
          stagehand,
          opts.humanActionResolver,
          twoFactorTimeoutMs,
          sessionId,
        );
        await pushShot('post_2fa');
      }
      if (pageType === 'login_form') {
        // Form re-rendered → either bad creds, locked account, or rate-limit.
        throw new Error('maxance_bad_credentials');
      }
      if (pageType === 'error_page') {
        throw new Error('maxance_error_page');
      }
    } else {
      // unknown / error_page / proximeo_home (unexpectedly already there).
      if (pageType === 'proximeo_home') {
        alreadyLoggedIn = true;
      } else {
        throw new Error(`maxance_unexpected_initial_page:${pageType}`);
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
