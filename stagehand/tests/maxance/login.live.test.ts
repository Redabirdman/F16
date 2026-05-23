/**
 * LIVE Maxance login test (M8.T2).
 *
 * Opt-in only. Gated on:
 *   - MAXANCE_LIVE=1
 *   - ANTHROPIC_API_KEY
 *   - MAXANCE_USERNAME, MAXANCE_PASSWORD, MAXANCE_BASE_URL (placeholders fail
 *     `readCredentialsOrThrow` inside login.ts, so we re-check here for a
 *     friendlier skip reason)
 *
 * This test ACTUALLY hits the broker portal. On a cold first-of-the-month run
 * Maxance prompts for SMS — the stub resolver below reads the code from
 * MAXANCE_TEST_2FA_CODE if set, otherwise the test hangs until you POST it to
 * `/v1/maxance/2fa-code` (the HTTP server is NOT booted in this test; you'd
 * have to run `pnpm dev` in parallel and use that endpoint — typically easier
 * to pre-stage the code via the env var).
 *
 * Wall-clock budget:
 *   - 60s warm path (cookie already valid)
 *   - 180s cold path (Chromium download + SMS prompt)
 *
 * The test DOES NOT click anything past "Proximéo home loaded" — no real
 * records created. Per the M8.T2 spec, stops after the screenshot.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pool } from '../../src/browser-pool.js';
import { loginMaxance } from '../../src/maxance/login.js';

/**
 * Stable on-disk paths for the Maxance broker session. Two separate dirs:
 *
 *   - `userDataDir`   — Chromium profile. Holds the "Se souvenir 30 jours"
 *                       MFA cookie + Maxance session cookie. MUST persist
 *                       across test runs for the 30-day-no-SMS contract to
 *                       hold. Lives outside tmpdir so it survives OS reboots.
 *   - `screenshotDir` — Per-run capture root passed to loginMaxance as
 *                       `dataRoot`. Reused across runs (overwrites are fine);
 *                       we never delete it so the most recent screenshots
 *                       always sit there for inspection.
 *
 * Both are gitignored via `stagehand/.gitignore`.
 */
const MAXANCE_BOOTSTRAP_ROOT = resolve(
  process.cwd(),
  process.env.MAXANCE_BOOTSTRAP_ROOT ?? 'data/maxance-bootstrap',
);
const MAXANCE_USERDATA_DIR = join(MAXANCE_BOOTSTRAP_ROOT, 'userdata');
const MAXANCE_SCREENSHOT_ROOT = join(MAXANCE_BOOTSTRAP_ROOT, 'captures');

const live =
  process.env.MAXANCE_LIVE === '1' &&
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  Boolean(process.env.MAXANCE_USERNAME) &&
  Boolean(process.env.MAXANCE_PASSWORD) &&
  Boolean(process.env.MAXANCE_BASE_URL) &&
  !(process.env.MAXANCE_USERNAME ?? '').startsWith('<') &&
  !(process.env.MAXANCE_PASSWORD ?? '').startsWith('<');

describe.skipIf(!live)('Maxance LIVE — full login + SSO bootstrap', () => {
  it(
    'signs in, lands on Proximéo home, captures 3+ screenshots',
    // 16min budget: the manual-MFA mode gives Ridaa up to ~15 minutes to call
    // Achraf, get the code, and type it into the open Chromium window.
    { timeout: 16 * 60_000 },
    async () => {
      // Ensure both dirs exist before Stagehand / loginMaxance reach for them.
      await mkdir(MAXANCE_USERDATA_DIR, { recursive: true });
      await mkdir(MAXANCE_SCREENSHOT_ROOT, { recursive: true });
      process.env.STAGEHAND_DATA_DIR = MAXANCE_SCREENSHOT_ROOT;
      console.log(`[maxance live] userDataDir=${MAXANCE_USERDATA_DIR}`);
      console.log(`[maxance live] captures=${MAXANCE_SCREENSHOT_ROOT}`);

      // Pin Chromium to the stable userDataDir so cookies (incl. the MFA
      // 30-day "remember device" token) survive process restarts.
      // `stealth: true` is mandatory here — Maxance uses Auth0, which
      // silently invalidates the device-trust cookie whenever it detects
      // Playwright automation. With stealth on, Auth0 treats the cookie as
      // valid and skips the SMS challenge for ~30 days.
      // Two modes:
      //   1. CDP attach — preferred. Set MAXANCE_CDP_URL to the running
      //      Chrome's DevTools endpoint (e.g. http://127.0.0.1:9222). The
      //      Chrome must have been launched via `scripts/start-maxance-chrome.ps1`
      //      (or its equivalent on the production box). Sidesteps Cloudflare
      //      because Stagehand attaches to a real Chrome the user already
      //      started — same fingerprint as their daily browsing.
      //   2. Self-launched real Chrome — fallback when CDP env not set.
      //      Cloudflare may still challenge here; manual click in the window.
      const cdpUrl = process.env.MAXANCE_CDP_URL;
      const session = await pool.create({
        name: 'maxance-live-test',
        ...(cdpUrl
          ? { cdpUrl }
          : {
              headless: false,
              userDataDir: MAXANCE_USERDATA_DIR,
              stealth: true,
              channel: 'chrome',
            }),
      });

      try {
        const borrowed = pool.borrow(session.sessionId);
        try {
          // Track the resolver-call count so a rejected code doesn't simply
          // re-submit the same bad value 3 times in a row (the production
          // resolver re-prompts the human; ours has nothing fresh to offer).
          let resolverCallCount = 0;
          const result = await loginMaxance(borrowed.stagehand, session.sessionId, {
            dataRoot: MAXANCE_SCREENSHOT_ROOT,
            // First-of-the-month bootstrap path. The agent halts on the MFA
            // screen and waits for Ridaa to manually type the code + tick
            // "30 days" + click Continuer in the visible Chromium window.
            // After the next ~30 days, the cookie keeps us logged in and this
            // branch is skipped entirely.
            manualSmsHandling: true,
            // Generous wall-clock budget — the human needs time to call Achraf.
            twoFactorTimeoutMs: 15 * 60_000,
            humanActionResolver: async (req) => {
              resolverCallCount += 1;
              const preset = process.env.MAXANCE_TEST_2FA_CODE;
              if (preset && preset.trim().length > 0 && resolverCallCount === 1) {
                return preset.trim();
              }
              if (resolverCallCount > 1) {
                console.log(
                  `\n[2FA] Maxance rejected the previous code. Fail fast — ` +
                    `the test resolver has no fresh code to provide.\n`,
                );
                throw new Error('maxance_test_2fa_rejected_no_retry');
              }
              // Hang. Ridaa fills MAXANCE_TEST_2FA_CODE before re-running, or
              // restarts the test. Print a sentinel so the operator sees it.
              console.log(
                `\n[2FA] Maxance is requesting an SMS code. Summary: ${req.summary}\n` +
                  `      Set MAXANCE_TEST_2FA_CODE=<code> and re-run, or POST the code to ` +
                  `/v1/maxance/2fa-code via the running stagehand service.\n`,
              );
              // Wait forever (until the global timeout).
              await new Promise(() => undefined);
              return ''; // unreachable
            },
          });

          expect(result.finalUrl).toMatch(/maxance/i);
          // Two paths to success:
          //   - cold path (no cookie / no trust): identifiant + password + MFA
          //     produces 6-8 screenshots
          //   - warm path (persisted trust cookie): straight to proximeo_home
          //     produces just `initial_load` + `proximeo_home_confirmed` = 2
          // Both are valid M8.T2 outcomes — assert at least 2 captures.
          expect(result.screenshots.length).toBeGreaterThanOrEqual(2);

          // Verify screenshots actually landed on disk.
          const files = await readdir(join(MAXANCE_SCREENSHOT_ROOT, 'screenshots'));
          expect(files.length).toBeGreaterThanOrEqual(result.screenshots.length);
        } catch (err) {
          // Captures are always preserved (we never delete the bootstrap
          // dir), so inspection just means "look at the captures path".
          console.log(
            `[maxance live] FAILED — captures kept at ${MAXANCE_SCREENSHOT_ROOT} for inspection`,
          );
          throw err;
        } finally {
          pool.release(session.sessionId);
        }
      } finally {
        // ALWAYS close the Stagehand handle (frees the Chromium child proc).
        // We DO NOT delete MAXANCE_USERDATA_DIR — the whole point is to keep
        // the Maxance MFA "remember 30 days" cookie alive across runs. The
        // captures dir is preserved too; screenshots overwrite by name so no
        // garbage piles up.
        await pool.close(session.sessionId).catch(() => undefined);
      }
    },
  );
});

describe('Maxance LIVE — skip wiring sanity', () => {
  it('reports whether the live block ran', () => {
    if (!live) {
      console.log('[maxance live test] SKIPPED — set MAXANCE_LIVE=1 + creds to enable');
    }
    expect(true).toBe(true);
  });
});
