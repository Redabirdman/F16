import { defineConfig } from 'vitest/config';

// Browser smoke tests launch a real Chromium process — cold start on a fresh
// container or CI runner can easily take 5–10s. The Vitest default of 5s is
// too tight, so bump the per-test timeout to 30s globally. Individual tests
// can still tighten this with `it('…', { timeout: N }, …)`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
