/**
 * esbuild config for the F16 Maxance Chrome MV3 extension.
 *
 * Bundles three independent entrypoints to `dist/`:
 *   - background.js — MV3 service worker (WS client → backend)
 *   - content.js    — content script injected on *.maxance.com
 *   - popup.js      — popup UI logic
 *
 * Also copies manifest.json + popup.html into `dist/` so the user can load
 * the unpacked extension from `extension/dist` in Chrome's
 * chrome://extensions developer mode.
 *
 * Run `pnpm build` (one-shot) or `pnpm dev` (watch mode). The latter rebuilds
 * on save; you still have to click "reload" on chrome://extensions to pick up
 * the new bundle (Chrome doesn't hot-reload extensions reliably).
 */
import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const distDir = join(here, 'dist');

const watch = process.argv.includes('--watch');

/** Entrypoint → output bundle map. Keys must match manifest.json references. */
const ENTRIES = {
  background: join(srcDir, 'background.ts'),
  content: join(srcDir, 'content.ts'),
  popup: join(srcDir, 'popup', 'popup.ts'),
};

/** Static files copied verbatim into dist/. */
const STATIC = [
  ['manifest.json', 'manifest.json'],
  ['popup/popup.html', 'popup.html'],
];

const sharedOptions = {
  bundle: true,
  format: 'esm',
  target: 'chrome120', // MV3 ships on Chrome ≥ 88; 120 is comfortably modern
  sourcemap: 'inline',
  logLevel: 'info',
  // Tree-shake dead code from zod.
  treeShaking: true,
  // Keep names stable so debugger stacks are readable.
  keepNames: true,
};

async function copyStatic() {
  await mkdir(distDir, { recursive: true });
  for (const [from, to] of STATIC) {
    await cp(join(srcDir, from), join(distDir, to));
  }
}

async function buildOnce() {
  await copyStatic();
  await Promise.all(
    Object.entries(ENTRIES).map(([name, entry]) =>
      build({
        ...sharedOptions,
        entryPoints: [entry],
        outfile: join(distDir, `${name}.js`),
      }),
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`[esbuild] ${Object.keys(ENTRIES).length} bundles → ${distDir}`);
}

async function watchAll() {
  await copyStatic();
  const contexts = await Promise.all(
    Object.entries(ENTRIES).map(async ([name, entry]) =>
      context({
        ...sharedOptions,
        entryPoints: [entry],
        outfile: join(distDir, `${name}.js`),
      }),
    ),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  // eslint-disable-next-line no-console
  console.log('[esbuild] watching extension/src/**');
}

await (watch ? watchAll() : buildOnce());
