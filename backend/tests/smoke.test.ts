import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    };

    expect(body.ok).toBe(true);
    expect(body.service).toBe('f16-backend');
    expect(body.version).toBe(pkg.version);
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    // Catches the "returned Date.now() instead of (Date.now() - startedAt)" footgun:
    // uptime is a delta from module load, so it must be tiny within a single test run.
    expect(body.uptime).toBeLessThan(60_000);
  });
});
