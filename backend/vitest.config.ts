import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Loads backend/.env so live-API tests (M3.T5 ANTHROPIC_API_KEY) see secrets.
    // setupFiles run inside the test worker BEFORE each test file is imported,
    // so `describe.skipIf(!process.env.X)` at module top sees the loaded vars.
    setupFiles: ['./tests/setup.ts'],
    // Integration test files (tests/db/*.test.ts) share a single Postgres
    // schema and use TRUNCATE in beforeEach. Running test files in parallel
    // deadlocks the AccessExclusiveLock on `customers` between workers, so
    // we serialize at the file level. Within a file, tests still run
    // sequentially (vitest default). Suite still finishes in seconds.
    fileParallelism: false,
    // Generous per-test + per-hook ceilings (option 2). THIS PC runs the F16
    // backend as prod 24/7, so a local `pnpm test` competes with it for
    // Redis/CPU; the default 5s would let vitest kill a slow-but-correct
    // integration test before its waitFor resolves. A healthy run still
    // finishes in well under a second — this is only an upper bound. Tunable
    // via TEST_TIMEOUT_MS (test bodies) / TEST_HOOK_TIMEOUT_MS (before/after
    // hooks, e.g. the TRUNCATE in beforeEach). Pairs with the integration tests'
    // own `waitFor` ceilings, which default to `TEST_WAITFOR_MS` (>=15s).
    testTimeout: Number(process.env.TEST_TIMEOUT_MS) || 30_000,
    hookTimeout: Number(process.env.TEST_HOOK_TIMEOUT_MS) || 30_000,
  },
});
