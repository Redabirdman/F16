import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { HealthResponse } from './types.js';
import { logger } from './logger.js';
import type { Database } from './db/index.js';
import { buildWhatsAppWebhook, parseAuthorisedResolvers } from './channels/whatsapp/webhook.js';
import { buildLeadIntakeRouter } from './leads/intake-http.js';

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

export interface BuildAppOptions {
  /**
   * Database handle for routes that need persistence. Optional so the simple
   * `/health` server can be booted without a DB connection (helpful for
   * smoke tests + early-boot health probes before the schema is ready).
   */
  db?: Database;
  /** Shared HMAC secret used to verify the WAHA inbound webhook. */
  wahaHmacSecret?: string;
  /**
   * Shared HMAC secret used to verify the public lead intake webhook
   * (`POST /v1/leads`). Falls back to `HMAC_WEBHOOK_SECRET` from env in
   * `start()`. When unset, signature verification is skipped — dev only.
   */
  leadIntakeHmacSecret?: string;
}

/**
 * Build a Hono app wired with the routes available given the provided
 * dependencies. Keeping this as a factory (instead of mutating a module-level
 * `app`) lets tests construct a fresh app per case with a mocked DB and a
 * known HMAC secret without leaking state between files.
 */
export function buildApp(opts: BuildAppOptions = {}): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      service: 'f16-backend',
      version: pkg.version,
      uptime: Date.now() - startedAt,
    };
    return c.json(body, 200);
  });

  if (opts.db) {
    // Mount channel webhooks only when we have a DB to write to. Without
    // one, the `/webhooks/waha` route would just 500 on every request — a
    // missing route is a clearer failure mode.
    // option G follow-up: human-action group + resolver allowlist from env.
    // When unset, the webhook ignores all group messages (legacy); when set,
    // group messages from the configured chat route to the human-action
    // resolution parser.
    const humanActionGroupChatId = process.env.HUMAN_ACTION_GROUP_CHAT_ID;
    const humanActionAuthorisedResolvers = parseAuthorisedResolvers(
      process.env.HUMAN_ACTION_AUTHORISED_RESOLVERS,
    );
    const wahaApp = buildWhatsAppWebhook({
      db: opts.db,
      // exactOptionalPropertyTypes: only set the key when defined.
      ...(opts.wahaHmacSecret ? { hmacSecret: opts.wahaHmacSecret } : {}),
      ...(humanActionGroupChatId ? { humanActionGroupChatId } : {}),
      ...(humanActionAuthorisedResolvers.size > 0 ? { humanActionAuthorisedResolvers } : {}),
    });
    app.route('/', wahaApp);

    // M5.T1 — public lead intake webhook (`POST /v1/leads`). Same
    // exactOptionalPropertyTypes discipline as the WAHA route.
    const leadIntakeApp = buildLeadIntakeRouter({
      db: opts.db,
      ...(opts.leadIntakeHmacSecret ? { hmacSecret: opts.leadIntakeHmacSecret } : {}),
    });
    app.route('/', leadIntakeApp);
  }

  return app;
}

// Default app instance — bare /health only. Tests and `start()` build their
// own via `buildApp({ db, ... })` once the DB is available.
export const app = buildApp();

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

  // Wire the DB-backed app once env is loaded. `db()` is the lazy singleton
  // from `./db/index.ts` — first call validates DATABASE_URL.
  const { db } = await import('./db/index.js');
  const wahaSecret = process.env['WAHA_HMAC_SECRET'];
  // Shared webhook secret consumed by the M5.T1 `/v1/leads` route. The same
  // value is used by the website + Meta forwarders to sign their POSTs.
  const leadIntakeSecret = process.env['HMAC_WEBHOOK_SECRET'];
  const liveApp = buildApp({
    db: db(),
    ...(wahaSecret ? { wahaHmacSecret: wahaSecret } : {}),
    ...(leadIntakeSecret ? { leadIntakeHmacSecret: leadIntakeSecret } : {}),
  });

  const server = serve({ fetch: liveApp.fetch, port }) as Server;
  logger.info({ port }, 'f16-backend listening');

  // Boot every backend worker / agent (env-gated). Closes the deployment
  // loop for hubspot-sync, reporter-agent, maxance-operator, the sales
  // spawn orchestrator, and lead-scorer. Without this call, the routes
  // accept requests but nothing downstream actually processes them.
  const { startWorkers } = await import('./supervisor/index.js');
  const workerSet = await startWorkers({ db: db() });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    // Stop workers first (drains in-flight jobs), then close the HTTP server.
    void workerSet
      .stop()
      .catch((err: unknown) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'supervisor: stop threw',
        ),
      )
      .finally(() => server.close(() => process.exit(0)));
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
