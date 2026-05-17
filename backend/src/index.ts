import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { HealthResponse } from './types.js';
import { logger } from './logger.js';

/**
 * Read package.json once at module load to surface the running version on /health.
 * Resolved relative to this file so it works whether we run from `src/` (tsx) or `dist/` (compiled).
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};

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
 * Start the HTTP server. Lazily imports @hono/node-server and dotenv-safe only when
 * invoked, so importing this module from tests stays side-effect-free (no port bind,
 * no .env requirement).
 */
export async function start(port: number = Number(process.env.PORT ?? 3001)): Promise<Server> {
  // dotenv-safe throws if the runtime .env is missing keys declared in .env.template.
  // Loaded inside start() (not at module top) so tests don't require a .env file.
  // dotenv-safe ships no `exports` map, so we call .config() instead of importing
  // the side-effect subpath. Types come from src/types/dotenv-safe.d.ts.
  const dotenvSafe = await import('dotenv-safe');
  dotenvSafe.default.config();
  const { serve } = await import('@hono/node-server');

  const server = serve({ fetch: app.fetch, port }) as Server;
  logger.info({ port }, 'f16-backend listening');

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    // Hard-exit fallback if connections hang past the grace window.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

// Only start the server when this file is run directly (node dist/index.js, tsx src/index.ts).
// pathToFileURL handles drive letters, spaces, and unicode on Windows/macOS/Linux uniformly —
// hand-rolled string munging breaks on paths like "C:\Platforms Factory\…".
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void start();
}
