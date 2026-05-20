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
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../src/browser-pool.js';
import { loginMaxance } from '../../src/maxance/login.js';

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
    { timeout: 180_000 },
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'f16-maxance-live-'));
      process.env.STAGEHAND_DATA_DIR = dataDir;

      const session = await pool.create({ name: 'maxance-live-test', headless: false });

      try {
        const borrowed = pool.borrow(session.sessionId);
        try {
          const result = await loginMaxance(borrowed.stagehand, session.sessionId, {
            dataRoot: dataDir,
            humanActionResolver: async (req) => {
              const preset = process.env.MAXANCE_TEST_2FA_CODE;
              if (preset && preset.trim().length > 0) {
                return preset.trim();
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
          expect(result.screenshots.length).toBeGreaterThanOrEqual(3);

          // Verify screenshots actually landed on disk.
          const files = await readdir(join(dataDir, 'screenshots'));
          expect(files.length).toBeGreaterThanOrEqual(result.screenshots.length);
        } finally {
          pool.release(session.sessionId);
        }
      } finally {
        await pool.close(session.sessionId).catch(() => undefined);
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
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
