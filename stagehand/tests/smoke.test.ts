import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Stagehand } from '@browserbasehq/stagehand';
import { app } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

describe('GET /health', () => {
  it('returns 200 with service health payload', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      version: string;
      uptime: number;
      browsers: number;
    };

    expect(body.ok).toBe(true);
    expect(body.service).toBe('f16-stagehand');
    expect(body.version).toBe(pkg.version);
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    // Catches the "returned Date.now() instead of (Date.now() - startedAt)" footgun:
    // uptime is a delta from module load, so it must be tiny within a single test run.
    expect(body.uptime).toBeLessThan(60_000);
    // Pool starts empty (real pool lands in M8).
    expect(body.browsers).toBe(0);
  });
});

describe('Stagehand package import', () => {
  it('Stagehand class is constructable from @browserbasehq/stagehand', () => {
    // Cheap smoke check that the package resolves and exports the expected
    // class symbol. Doesn't actually instantiate (would need an API key + browser);
    // catches the "wrong package shape after upgrade" footgun.
    expect(typeof Stagehand).toBe('function');
  });
});

describe('browser smoke', () => {
  it(
    'launches headless Chromium, navigates to about:blank, and closes cleanly',
    { timeout: 30_000 },
    async () => {
      // Sanity check that Playwright's Chromium is actually installed and bootable
      // in this environment. If this fails on a fresh machine, run:
      //   pnpm --filter @f16/stagehand exec playwright install chromium
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto('about:blank');
        // about:blank renders an empty document with no title.
        expect(await page.title()).toBe('');
      } finally {
        await browser.close();
      }
    },
  );
});
