/**
 * Stagehand session manager (M8.T1).
 *
 * One **session** = one Stagehand V3 instance backed by one local Chromium
 * via a per-session `userDataDir` so cookies, localStorage, and signed-in state
 * survive across `act`/`extract`/`observe` intents within the same logical run.
 *
 * Stagehand V3 surface used (from `@browserbasehq/stagehand@3.4.0`):
 *   - `new Stagehand({ env: 'LOCAL', model: ..., localBrowserLaunchOptions })`
 *   - `await stagehand.init()`
 *   - `stagehand.context.activePage()` returns a V3 `Page` exposing
 *     `goto`, `url()`, `title()`, `screenshot()`.
 *   - `stagehand.act|extract|observe(instruction, ...)` — these live on the
 *     Stagehand instance, NOT on `stagehand.page` (a common drift from V2 docs).
 *
 * Borrow/release is atomic so concurrent intents on the same session error
 * cleanly instead of racing on the underlying Chromium target.
 *
 * Multi-tenant note: each session's userDataDir lives under
 * `<dataRoot>/sessions/<sessionId>`. Close keeps the directory on disk by
 * default so a follow-up Maxance run with the same `name` could be wired to
 * reuse cookies (M8.T2). For now sessions die with the process — persistence
 * across restarts is a name-based opt-in we don't enable here.
 */
import { Stagehand } from '@browserbasehq/stagehand';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';

export interface SessionInfo {
  sessionId: string;
  name: string;
  createdAt: Date;
  busy: boolean;
}

export interface SessionCreateOptions {
  name?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /**
   * Pin Chromium's userDataDir to an absolute path the caller owns. When set,
   * cookies / localStorage / IndexedDB survive process restarts — critical
   * for the Maxance broker session where Maxance's "Se souvenir 30 jours"
   * MFA cookie must persist across runs. When omitted, falls back to the
   * per-session UUID directory (old behaviour, suitable for ephemeral test
   * sessions that don't need cookie continuity).
   */
  userDataDir?: string;
  /**
   * Apply browser-automation stealth treatments. Required for sites that gate
   * "remember-this-device" cookies behind bot detection (Auth0, Cloudflare
   * Turnstile, Akamai BMP, etc.). Maxance uses Auth0 (ciam.vilavi.fr) and
   * silently invalidates the 30-day MFA trust cookie when it detects
   * Playwright. Enabling this:
   *   - drops `--enable-automation` from Chromium's launch flags
   *   - adds `--disable-blink-features=AutomationControlled`
   *   - injects an initScript that masks navigator.webdriver + a few common
   *     fingerprint tells before any page script runs
   *   - keeps Playwright's default User-Agent (DO NOT override — Auth0 hashes
   *     the UA into the device-trust cookie, so a UA flip on re-launch makes
   *     trust fail on every run)
   * Off by default — only the Maxance bootstrap currently needs it.
   */
  stealth?: boolean;
}

/**
 * Internal record. Not exported because callers only need the public
 * `SessionInfo` view; the live Stagehand handle is borrowed via `borrow()`.
 */
export interface PooledSession {
  sessionId: string;
  name: string;
  createdAt: Date;
  stagehand: Stagehand;
  busy: boolean;
  dataDir: string;
}

// Stagehand v3 requires `provider/model` format. The bare model id raises
// UnsupportedModelError at Stagehand.init(). Anthropic Sonnet is our default
// per the design's LLM tiering (R2 routing — Anthropic direct, not OpenRouter).
// Stagehand v3 requires `provider/model` format. Use the dated Anthropic API
// model id (the bare alias `claude-sonnet-4-5` is Stagehand-internal and the
// AI SDK forwards it as-is to Anthropic, which 404s).
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

// Chromium launch flags that hide the most obvious Playwright tells.
// Sources: well-known stealth patterns from `playwright-extra`/`stealth`.
const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,InterestCohort',
  '--no-default-browser-check',
];

/**
 * One-shot script injected into every frame before any page script runs.
 * Removes the textbook automation tells so JS-side fingerprinting (Auth0,
 * Cloudflare Turnstile, etc.) treats us as a regular Chrome.
 *
 * Kept short on purpose — the goal isn't full stealth, just enough to make
 * Auth0's MFA-trust cookie survive across launches. If we ever need more
 * (canvas / WebGL / audio randomisation), revisit.
 */
const STEALTH_INIT_SCRIPT = `
  // Drop navigator.webdriver — the single most reliable automation tell.
  try { Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => undefined }); } catch (_) {}
  try { delete Navigator.prototype.webdriver; } catch (_) {}
  // Pretend the languages list looks like a real user.
  try { Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] }); } catch (_) {}
  // Pretend we have a normal plugins list (length 0 in headless is suspicious).
  try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (_) {}
  // Hide that we're running under CDP — window.chrome must exist on real Chrome.
  if (!window.chrome) { window.chrome = { runtime: {} }; }
  // Mask the permissions API quirk Playwright leaves behind.
  try {
    const orig = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, name: 'notifications', onchange: null })
        : orig.call(window.navigator.permissions, params);
  } catch (_) {}
`;

export class BrowserPool {
  private sessions = new Map<string, PooledSession>();
  private readonly dataRoot: string;

  constructor(opts: { dataRoot?: string } = {}) {
    this.dataRoot = opts.dataRoot ?? process.env.STAGEHAND_DATA_DIR ?? './data';
  }

  /** Currently-open session count. Drives /health's `browsers` field. */
  size(): number {
    return this.sessions.size;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      createdAt: s.createdAt,
      busy: s.busy,
    }));
  }

  /**
   * Launch a Stagehand instance + its Chromium and register it.
   * Throws if `ANTHROPIC_API_KEY` is missing — Stagehand's `act`/`extract`/`observe`
   * need an LLM to interpret natural-language instructions. We don't fall back to
   * OpenAI here; the F16 platform is Anthropic-first (per `project_llm_sdk_swap`).
   */
  async create(opts: SessionCreateOptions = {}): Promise<SessionInfo> {
    const sessionId = randomUUID();
    const name = opts.name ?? `session-${sessionId.slice(0, 8)}`;
    // If the caller supplies a stable userDataDir (e.g. the Maxance bootstrap
    // path), use it verbatim. Otherwise fall back to a per-session UUID dir.
    // Note we still mkdir it so first-run is idempotent.
    const dataDir = opts.userDataDir ?? join(this.dataRoot, 'sessions', sessionId);
    await mkdir(dataDir, { recursive: true });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY required to launch Stagehand');
    }

    // STAGEHAND_BROWSER_HEADLESS=false flips to headed. Default headless.
    const envHeadless = process.env.STAGEHAND_BROWSER_HEADLESS;
    const headless = opts.headless ?? envHeadless !== 'false';

    // Stealth knobs (off unless caller asks). When on:
    //   - swap in Chromium launch flags that drop the automation banner
    //   - pin a realistic Chrome User-Agent so Auth0's device-trust hash stays stable
    //   - we'll also inject an init-script post-`stagehand.init()` (see below)
    //
    // `ignoreDefaultArgs: ['--enable-automation']` is the canonical way to tell
    // Playwright "don't put the 'Chrome is being controlled by automated test
    // software' banner up". Without it, Auth0 spots us even with the init-script.
    const stealth = opts.stealth ?? false;
    const launchArgs = stealth ? STEALTH_LAUNCH_ARGS : undefined;

    const stagehand = new Stagehand({
      env: 'LOCAL',
      // V3 takes model as a single field carrying both modelName + clientOptions.
      // Drift from M8 design snippet: there is no `modelName` / `modelClientOptions`
      // at the top level. The string form selects defaults; the object form lets
      // us pass the Anthropic API key explicitly (which is what we want).
      model: {
        modelName: DEFAULT_MODEL,
        apiKey,
        // Pin the Anthropic API URL explicitly. The AI SDK's createAnthropic
        // honors process.env.ANTHROPIC_BASE_URL — and if any caller exports
        // that var as the host root ('https://api.anthropic.com', without
        // '/v1'), every request 404s. Hard-coding the canonical /v1 endpoint
        // keeps Stagehand's LLM calls robust against env pollution.
        baseURL: process.env.STAGEHAND_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
      },
      localBrowserLaunchOptions: {
        headless,
        userDataDir: dataDir,
        ...(opts.viewport ? { viewport: opts.viewport } : {}),
        ...(stealth
          ? {
              args: launchArgs,
              // Intentionally NOT overriding userAgent — Auth0 hashes the UA
              // into the device-trust cookie at issue time. Switching UAs
              // between bootstrap and re-use would invalidate trust on every
              // launch. Stick with Playwright's default UA (which matches the
              // bundled Chromium version) and let it stay stable.
              ignoreDefaultArgs: ['--enable-automation'],
            }
          : {}),
      },
      verbose: 0,
    });

    await stagehand.init();

    // Inject the JS-side stealth shim into every frame BEFORE any page loads.
    // `addInitScript` on the Playwright BrowserContext is the right hook —
    // it survives page navigations and runs in iframes too.
    if (stealth) {
      try {
        // Stagehand v3 exposes the Playwright BrowserContext as
        // `stagehand.context` (typed as `StagehandContext`). The underlying
        // raw context exposes `addInitScript`. We cast through `unknown` to
        // avoid leaking Playwright types into the public API.
        const ctx = stagehand.context as unknown as {
          addInitScript?: (script: { content: string }) => Promise<void>;
        };
        if (typeof ctx.addInitScript === 'function') {
          await ctx.addInitScript({ content: STEALTH_INIT_SCRIPT });
        } else {
          logger.warn(
            { sessionId },
            'stagehand: stealth requested but context.addInitScript is missing — JS-side stealth skipped',
          );
        }
      } catch (err) {
        logger.warn(
          { err, sessionId },
          'stagehand: failed to install stealth init-script; continuing without it',
        );
      }
    }

    logger.info({ sessionId, name, dataDir, headless, stealth }, 'stagehand: session created');

    const s: PooledSession = {
      sessionId,
      name,
      createdAt: new Date(),
      stagehand,
      busy: false,
      dataDir,
    };
    this.sessions.set(sessionId, s);
    return { sessionId, name, createdAt: s.createdAt, busy: false };
  }

  get(sessionId: string): PooledSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Atomic borrow — flips busy=true and returns the live session record.
   * Throws on unknown id or if another caller already holds it. Callers MUST
   * `release()` in a `finally` block to avoid leaks.
   */
  borrow(sessionId: string): PooledSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    if (s.busy) throw new Error(`session ${sessionId} is busy`);
    s.busy = true;
    return s;
  }

  release(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.busy = false;
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      await s.stagehand.close();
    } catch (err) {
      logger.warn({ err, sessionId }, 'stagehand close threw');
    }
    // Intentionally keep `dataDir` on disk — caller decides cleanup. M16 will add
    // a sweep job; for now a long-lived process can pile up directories under
    // STAGEHAND_DATA_DIR/sessions/ and that's acceptable.
    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'stagehand: session closed');
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.close(id);
    }
  }
}

/** Process-wide singleton consumed by the HTTP routes + the shutdown hook. */
export const pool = new BrowserPool();
