/**
 * @f16/stagehand — Maxance broker-portal automation (M8.T2).
 *
 * Public surface:
 *   - `loginMaxance(stagehand, sessionId, opts)` — open the portal, sign in
 *     (re-using a 30-day cookie when possible), follow the SSO bounce, and
 *     stop on the Proximéo home. Escalates 2FA via `humanActionResolver`.
 *   - `startMaxanceHeartbeat({ sessionId, pool, ... })` — opt-in keep-alive
 *     ping. Read-only `extract`; calls `onSessionLost` on session loss.
 *
 * --- HOW TO RUN THE LIVE TEST ---
 *
 * The live login test (`tests/maxance/login.live.test.ts`) is gated on
 * `MAXANCE_LIVE=1` AND `ANTHROPIC_API_KEY` AND real `MAXANCE_USERNAME` /
 * `MAXANCE_PASSWORD`. It is intentionally NEVER run in CI.
 *
 * Ridaa's one-shot workflow:
 *   1. Ensure stagehand/.env has MAXANCE_USERNAME, MAXANCE_PASSWORD,
 *      MAXANCE_BASE_URL, ANTHROPIC_API_KEY filled.
 *   2. Set MAXANCE_LIVE=1 just for this run.
 *   3. From `stagehand/`: `MAXANCE_LIVE=1 pnpm exec vitest run tests/maxance/login.live.test.ts`
 *      (Windows PowerShell: `$env:MAXANCE_LIVE=1; pnpm exec vitest run tests/maxance/login.live.test.ts`)
 *   4. If the test prints `[2FA] Maxance is requesting an SMS code...`, find
 *      the code on Achraf's phone and POST it to
 *      `http://127.0.0.1:<test-port>/v1/maxance/2fa-code` with `{ sessionId, code }`
 *      OR (when running just the vitest file) wait — the test's stub resolver
 *      reads from `MAXANCE_TEST_2FA_CODE` env var if set ahead of time.
 *   5. Expect a `proximeoLoaded=true` assertion and 3+ screenshots dropped
 *      under `.data/screenshots/`.
 *
 * The test STOPS at the Proximéo home — no real records are created.
 * Subsequent runs reuse the cookie and skip the SMS prompt.
 */
export { loginMaxance } from './login.js';
export {
  startMaxanceHeartbeat,
  type HeartbeatOptions,
  type HeartbeatHandle,
  type HeartbeatPingResult,
} from './heartbeat.js';
export type {
  MaxanceLoginResult,
  MaxanceLoginScreenshot,
  MaxanceLoginOptions,
  MaxancePageType,
  HumanActionResolver,
  HumanActionRequest,
} from './types.js';
