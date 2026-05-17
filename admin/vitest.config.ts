import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Extend vite.config so the `@/*` alias (and any future resolver tweaks)
// are defined exactly once.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      css: true,
      // Explicit imports preferred — keeps test files self-documenting and tree-shake-friendly.
      globals: false,
    },
  }),
);
