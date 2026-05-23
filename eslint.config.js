// ESLint 9 flat config for the F16 monorepo.
// Shared base for every TS/TSX file across backend/, admin/, stagehand/.
// Python (pipecat/) is excluded; ruff/mypy handle it.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  // Global ignores — applied to every config block below.
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'pipecat/**',
      'infra/**',
      'docs/**',
      '**/.vite/**',
      '**/.cache/**',
    ],
  },

  // Base JS recommended rules.
  js.configs.recommended,

  // typescript-eslint recommended + strict, type-aware-light (no projectService —
  // keeps lint fast and avoids needing every tsconfig wired in here).
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,

  // Shared TS rules for every workspace.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'warn',
      'no-implicit-coercion': 'error',
      // Allow intentional underscore-prefixed unused args (matches our placeholder
      // pool API: `release(_instance: Stagehand)`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Backend + stagehand: Node environment.
  {
    files: ['backend/**/*.ts', 'stagehand/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Extension: Chrome MV3 (browser globals + webextensions). No React.
  // Service workers see `self` instead of `window`; both blocks of globals
  // cover SW + content-script + popup contexts. Console is allowed because
  // it's the only logging surface in an extension — there's no pino, no
  // process.stderr, no file handles.
  {
    files: ['extension/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Admin: React + browser environment.
  {
    files: ['admin/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // We use TS for prop validation, not prop-types.
      'react/prop-types': 'off',
    },
  },

  // Tests: relax a couple of strict rules that fight test ergonomics.
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // shadcn UI primitives intentionally co-export variants (cva()) alongside the
  // component (e.g. `Button` + `buttonVariants`). react-refresh flags that, but
  // it's the canonical shadcn shape — relax the rule for `components/ui/**`.
  {
    files: ['admin/src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // Config files (vite/vitest/tailwind/postcss configs at workspace roots).
  {
    files: [
      '**/vite.config.{ts,js}',
      '**/vitest.config.{ts,js}',
      '**/tailwind.config.{ts,js}',
      '**/postcss.config.{ts,js}',
      '**/*.config.{ts,js,mjs,cjs}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
