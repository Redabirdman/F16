/**
 * Vitest setup — load `.env` so the live-gated tests can see
 * MAXANCE_LIVE / MAXANCE_USERNAME / ANTHROPIC_API_KEY without requiring the
 * operator to `export` them in every shell.
 *
 * Wired via `vitest.config.ts`'s `setupFiles`. Uses plain `dotenv` (not
 * `dotenv-safe`) so a test machine missing the .env.example template still
 * runs the unit tests cleanly — the live block self-gates on the resulting
 * env values, so an absent .env just keeps that block skipped.
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Capture an explicit `MAXANCE_LIVE=` (empty) the shell may have set to
// disable the live block for this run. Without this, override:true below
// would replace it with the .env value (typically '1') and force live.
const liveShellOverride = process.env.MAXANCE_LIVE === '' ? '' : undefined;

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  // override=true so an empty/stale shell value (e.g. `ANTHROPIC_API_KEY=`
  // inherited from a parent process) doesn't beat the real value in .env.
  // We're in test setup, not production — the .env file is the source of truth.
  config({ path: envPath, override: true });
}

if (liveShellOverride === '') {
  process.env.MAXANCE_LIVE = '';
}

// Stub-based unit tests can't tolerate the real 1.5s/2.5s settle pauses the
// login flow uses in production (the HTTP 2FA integration test polls inside a
// 3s window). The live block keeps the real delays — `MAXANCE_LIVE=1` opts
// back into the production timings.
if (process.env.MAXANCE_LIVE !== '1') {
  process.env.MAXANCE_LOGIN_STEP_DELAY_MS = '0';
}

// One-line trace so the live-gate state is obvious when vitest verbose=true.

console.log(
  `[setup-env] MAXANCE_LIVE=${process.env.MAXANCE_LIVE ?? ''} ANT_KEY=${
    process.env.ANTHROPIC_API_KEY ? 'set' : 'unset'
  } USER=${process.env.MAXANCE_USERNAME ? 'set' : 'unset'} URL=${process.env.MAXANCE_BASE_URL ?? ''}`,
);
