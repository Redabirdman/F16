// Commitlint config for the F16 monorepo.
// Enforces Conventional Commits; allowed scopes track our workspace layout.
/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'backend',
        'admin',
        'stagehand',
        'pipecat',
        'infra',
        'docs',
        'deps',
        'ci',
        'tooling',
        'repo',
        'release',
      ],
    ],
    // Body / footer line length is noisy for paste-in CI logs; relax.
    'body-max-line-length': [0, 'always', 200],
    'footer-max-line-length': [0, 'always', 200],
  },
};
