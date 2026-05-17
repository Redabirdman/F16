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
  },
});
