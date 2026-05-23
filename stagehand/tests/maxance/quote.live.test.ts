/**
 * ⚠️ DEPRECATED 2026-05-23 — DO NOT enable MAXANCE_QUOTE_LIVE against the
 * real Maxance portal. Cloudflare Turnstile blocks every Playwright-launched
 * Chrome regardless of stealth treatment. Use the Claude Chrome extension
 * (mcp__Claude_in_Chrome__* MCP toolkit) on Ridaa's daily Chrome instead.
 * See project_hosting_pivot.md memory note for the decision log. Kept only
 * because the underlying step planner (quote.ts) remains the canonical
 * reference for Maxance UI selectors + defaults.
 *
 * LIVE Maxance quote-flow test (M8.T3).
 *
 * Opt-in only. Gated on:
 *   - MAXANCE_QUOTE_LIVE=1
 *   - ANTHROPIC_API_KEY
 *   - MAXANCE_USERNAME, MAXANCE_PASSWORD, MAXANCE_BASE_URL (the login function
 *     re-checks these; gating here too gives a friendlier skip message)
 *
 * Pre-conditions on disk:
 *   - The persisted userDataDir at `data/maxance-bootstrap/userdata/` must
 *     already hold a valid Auth0 device-trust cookie. That cookie is set
 *     by the M8.T2 live test on its first successful run. Without it, this
 *     test will park on the SMS challenge with no resolver and time out.
 *
 * The test ACTUALLY drives the real Proximéo quote flow against Maxance:
 *   1. loginMaxance() with stealth + persisted profile (should be warm — no
 *      identifiant/password/SMS).
 *   2. startQuote() with `dryRun: true` — fills Véhicule + Conducteur +
 *      Garanties tabs, extracts the price, STOPS.
 *
 * No "Valider souscription" is ever clicked. No record is created in
 * Maxance. The flow is read-and-fill only until the price preview.
 *
 * Wall-clock budget:
 *   - 60s warm login + 90-120s for the 12-ish act calls + final extract.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pool } from '../../src/browser-pool.js';
import { loginMaxance } from '../../src/maxance/login.js';
import { startQuote } from '../../src/maxance/quote.js';
import type { HumanActionResolver, MaxanceQuoteParams } from '../../src/maxance/types.js';

// Same bootstrap-root convention as the M8.T2 live test — share the
// persisted Auth0 cookie and the captures dir.
const MAXANCE_BOOTSTRAP_ROOT = resolve(
  process.cwd(),
  process.env.MAXANCE_BOOTSTRAP_ROOT ?? 'data/maxance-bootstrap',
);
const MAXANCE_USERDATA_DIR = join(MAXANCE_BOOTSTRAP_ROOT, 'userdata');
const MAXANCE_SCREENSHOT_ROOT = join(MAXANCE_BOOTSTRAP_ROOT, 'captures');

const live =
  process.env.MAXANCE_QUOTE_LIVE === '1' &&
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  Boolean(process.env.MAXANCE_USERNAME) &&
  Boolean(process.env.MAXANCE_PASSWORD) &&
  Boolean(process.env.MAXANCE_BASE_URL) &&
  !(process.env.MAXANCE_USERNAME ?? '').startsWith('<') &&
  !(process.env.MAXANCE_PASSWORD ?? '').startsWith('<');

/**
 * Resolver that refuses to feed an SMS code. The persisted Auth0 cookie
 * should skip MFA entirely; if the cookie is stale or missing this test
 * must FAIL FAST so the operator can re-run the M8.T2 bootstrap. We
 * deliberately don't want to burn SMS retries on a stale env.
 */
const failOnSmsResolver: HumanActionResolver = async () => {
  throw new Error('maxance_quote_live_unexpected_sms_prompt — re-run M8.T2 bootstrap first');
};

const quoteParams: MaxanceQuoteParams = {
  vehicleKind: 'trottinette',
  purchasePriceEur: 350, // mid-range — picks the 200-400 € version band
  purchaseDate: new Date(new Date().getFullYear(), 0, 15), // Jan 15 of this year
  postalCode: '75001',
  city: 'Paris',
  stationnement: 'garage_box',
  clientDateOfBirth: new Date(1990, 5, 12), // 12 June 1990, ~36 yo
  formule: 'tiers_illimite',
  commissionPct: 9,
  fractionnement: 'mensuel',
};

describe.skipIf(!live)('Maxance LIVE — quote flow (dryRun)', () => {
  it(
    'logs in warm, drives Véhicule + Conducteur + Garanties, extracts a price',
    // 15min ceiling — covers the Cloudflare Turnstile manual-click wait (up to
    // 10min) plus the actual login + quote-flow time (~3min on a warm cookie).
    { timeout: 15 * 60_000 },
    async () => {
      await mkdir(MAXANCE_USERDATA_DIR, { recursive: true });
      await mkdir(MAXANCE_SCREENSHOT_ROOT, { recursive: true });
      process.env.STAGEHAND_DATA_DIR = MAXANCE_SCREENSHOT_ROOT;

      // Two modes (see comment in login.live.test.ts for the full rationale):
      //   1. CDP attach via MAXANCE_CDP_URL — preferred, the user pre-launches
      //      Chrome with scripts/start-maxance-chrome.ps1 and we attach.
      //   2. Self-launched real Chrome — fallback, may hit Cloudflare loops.
      const cdpUrl = process.env.MAXANCE_CDP_URL;
      const session = await pool.create({
        name: 'maxance-quote-live-test',
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
          // Phase 1 — login (warm path expected).
          const loginResult = await loginMaxance(borrowed.stagehand, session.sessionId, {
            dataRoot: MAXANCE_SCREENSHOT_ROOT,
            humanActionResolver: failOnSmsResolver,
          });
          expect(loginResult.requiredHumanAction).toBe(false);
          // The login function returns when proximeo_home is confirmed —
          // exactly the entry state startQuote expects.

          // Phase 2 — quote flow.
          const quoteResult = await startQuote(borrowed.stagehand, session.sessionId, quoteParams, {
            dataRoot: MAXANCE_SCREENSHOT_ROOT,
            dryRun: true,
          });

          expect(quoteResult.dryRun).toBe(true);
          expect(quoteResult.screenshots.length).toBeGreaterThanOrEqual(3);
          // At least one price cadence must come back populated.
          const { monthly, annual } = quoteResult.pricePreviewEur;
          expect(monthly ?? annual).toBeDefined();
          if (monthly !== undefined) {
            expect(monthly).toBeGreaterThan(0);
            expect(monthly).toBeLessThan(500); // sanity — trottinette monthlies sit in EUR 5-100 range
          }
          if (annual !== undefined) {
            expect(annual).toBeGreaterThan(0);
            expect(annual).toBeLessThan(2000);
          }

          // Captures landed on disk under the bootstrap captures dir.
          const files = await readdir(join(MAXANCE_SCREENSHOT_ROOT, 'screenshots'));
          // Captures from earlier login + quote runs may pile up here; just
          // assert we have at least the quote ones from this run.
          expect(files.some((f) => f.includes('maxance-quote-'))).toBe(true);
        } catch (err) {
          console.log(
            `[maxance-quote live] FAILED — captures kept at ${MAXANCE_SCREENSHOT_ROOT} for inspection`,
          );
          throw err;
        } finally {
          pool.release(session.sessionId);
        }
      } finally {
        await pool.close(session.sessionId).catch(() => undefined);
      }
    },
  );
});

describe('Maxance LIVE quote — skip wiring sanity', () => {
  it('reports whether the live block ran', () => {
    if (!live) {
      console.log('[maxance-quote live test] SKIPPED — set MAXANCE_QUOTE_LIVE=1 + creds to enable');
    }
    expect(true).toBe(true);
  });
});
