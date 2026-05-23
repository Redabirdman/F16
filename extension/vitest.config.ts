import { defineConfig } from 'vitest/config';

// Extension unit tests are pure logic — no real Chrome, no DOM (we stub
// `document` per-test when content-script logic gets covered). Default the
// environment to `node` so we don't pay the jsdom cost for wire-schema tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 5_000,
  },
});
