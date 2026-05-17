// Prettier 3 config for the F16 monorepo.
// `prettier-plugin-tailwindcss` sorts Tailwind classes in admin/ JSX.
/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
  plugins: ['prettier-plugin-tailwindcss'],
};
