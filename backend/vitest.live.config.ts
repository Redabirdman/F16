import { defineConfig } from 'vitest/config';

/**
 * On-demand suite for the SLOW / occasionally-flaky end-to-end tests that are
 * EXCLUDED from the default `pnpm test` (which stays deterministic + 100% green).
 *
 * Run with `pnpm test:live`. It sets `RUN_LIVE_TESTS` via `test.env` so the
 * opt-in gates inside the test files activate — no shell env / cross-env needed
 * (works on Windows). Same Postgres+Redis env vars as the normal suite are
 * required (TEST_DATABASE_URL / TEST_REDIS_URL / PII_ENCRYPTION_KEY); the live
 * pipeline test also needs ANTHROPIC_API_KEY (loaded from backend/.env by
 * tests/setup.ts).
 *
 * ⚠️ `tests/e2e/sales-pipeline.live.test.ts` calls the REAL Anthropic API
 * (~$0.02-0.05 + ~1-3 min per run). Run on demand, don't loop.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/sales-pipeline.live.test.ts', 'tests/orchestration/sales-spawn.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Activates the `RUN_LIVE_TESTS` opt-in gates in the test files.
    env: { RUN_LIVE_TESTS: '1' },
    // They share one Postgres + Redis and TRUNCATE in beforeEach — serialize.
    fileParallelism: false,
    // The live pipeline waits up to ~3 min on real Claude; give headroom.
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
