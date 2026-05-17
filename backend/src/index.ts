import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthResponse } from './types.js';

/**
 * Read package.json once at module load to surface the running version on /health.
 * Resolved relative to this file so it works whether we run from `src/` (tsx) or `dist/` (compiled).
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

const startedAt = Date.now();

export const app = new Hono();

app.get('/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    service: 'f16-backend',
    version: pkg.version,
    uptime: Date.now() - startedAt,
  };
  return c.json(body, 200);
});

/**
 * Start the HTTP server. Lazily imports @hono/node-server only when invoked
 * so importing this module from tests does not bind a port or pull in extra deps.
 */
export async function start(port: number = Number(process.env.PORT ?? 3001)): Promise<void> {
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console
  console.log(`f16-backend listening on :${port}`);
}

// Only start the server when this file is run directly (node dist/index.js, tsx src/index.ts).
// Never on import (so the smoke test stays side-effect-free).
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  void start();
}
