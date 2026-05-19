import { Hono } from 'hono';
import type { Context } from 'hono';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { HealthResponse } from './types.js';
import { logger } from './logger.js';
import { pool } from './browser-pool.js';
import { executeIntent, type IntentName } from './intents.js';

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

/**
 * Resolve the on-disk root for sessions + screenshots on every request rather
 * than caching at module-load. Lets the test suite swap STAGEHAND_DATA_DIR between
 * cases, and matches how STAGEHAND_HMAC_SECRET is consulted (also per-request).
 */
function dataRoot(): string {
  return process.env.STAGEHAND_DATA_DIR ?? './data';
}

/**
 * Hono's `c.body()` types Buffer-incompatibly because `Buffer<ArrayBufferLike>`
 * may be backed by `SharedArrayBuffer`. Node's `readFile` and Playwright's
 * `screenshot` both return that union. Copy into a fresh `Uint8Array<ArrayBuffer>`
 * — cheap (one memcpy) and gets us off the type cliff cleanly.
 */
function toBodyBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(buf.byteLength);
  const out = new Uint8Array(ab);
  out.set(buf);
  return out;
}

export const app = new Hono();

app.get('/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    service: 'f16-stagehand',
    version: pkg.version,
    uptime: Date.now() - startedAt,
    browsers: pool.size(),
  };
  return c.json(body, 200);
});

/**
 * HMAC verification — same SHA-256 + `timingSafeEqual` pattern as the backend
 * lead-intake endpoint. Skipped (returns true) when STAGEHAND_HMAC_SECRET is
 * unset, which is the dev-mode default; M16 will set the secret in prod env.
 * A single warning logs once per process so an accidental prod misconfig is
 * visible without spamming logs on every request.
 */
let warnedNoHmac = false;
function verifyHmac(c: Context, rawBody: string): boolean {
  const secret = process.env.STAGEHAND_HMAC_SECRET;
  if (!secret) {
    if (!warnedNoHmac) {
      logger.warn('STAGEHAND_HMAC_SECRET unset — HMAC verification skipped (dev mode)');
      warnedNoHmac = true;
    }
    return true;
  }
  const provided = c.req.header('x-stagehand-signature') ?? '';
  if (!provided) return false;
  const supplied = provided.startsWith('sha256=') ? provided.slice(7) : provided;
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (supplied.length !== computed.length) return false;
  try {
    return timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

/** POST /v1/sessions — launch a new Stagehand-backed browser session. */
app.post('/v1/sessions', async (c) => {
  const raw = await c.req.text();
  if (!verifyHmac(c, raw)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let body: { name?: string; headless?: boolean; viewport?: { width: number; height: number } } =
    {};
  if (raw) {
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
  }
  try {
    const info = await pool.create(body);
    return c.json(info, 200);
  } catch (err) {
    logger.error({ err }, 'session create failed');
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** GET /v1/sessions — list active sessions. No HMAC: read-only, no PII. */
app.get('/v1/sessions', (c) => c.json({ sessions: pool.list() }, 200));

/** DELETE /v1/sessions/:id — close + drop. */
app.delete('/v1/sessions/:id', async (c) => {
  // DELETE has no body to HMAC. In M16 we'll switch this to a signed URL header
  // (`x-stagehand-signature` over the path + a timestamp) so a leaked secret
  // can't replay closes. For V1, dev mode skips and prod relies on network ACLs.
  if (!verifyHmac(c, '')) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  await pool.close(c.req.param('id'));
  return c.json({ closed: true }, 200);
});

/** POST /v1/sessions/:id/intent — execute one intent against a session. */
app.post('/v1/sessions/:id/intent', async (c) => {
  const raw = await c.req.text();
  if (!verifyHmac(c, raw)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let body: { intent: string; payload?: Record<string, unknown> };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (!body.intent) {
    return c.json({ error: 'missing intent' }, 400);
  }

  const sessionId = c.req.param('id');
  let session;
  try {
    session = pool.borrow(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish 404 (unknown id) from 409 (busy) so callers can retry the latter.
    const status = msg.endsWith('not found') ? 404 : 409;
    return c.json({ error: msg }, status);
  }

  try {
    const result = await executeIntent(
      session.stagehand,
      sessionId,
      { intent: body.intent as IntentName, payload: body.payload ?? {} },
      { dataRoot: dataRoot() },
    );
    return c.json(result, result.ok ? 200 : 500);
  } finally {
    pool.release(sessionId);
  }
});

/**
 * GET /v1/sessions/:id/screenshot — capture the active page right now and
 * stream the PNG. Useful for quick admin previews; intent calls also return
 * a `screenshotUrl` for the just-finished frame.
 */
app.get('/v1/sessions/:id/screenshot', async (c) => {
  const sessionId = c.req.param('id');
  let session;
  try {
    session = pool.borrow(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.endsWith('not found') ? 404 : 409;
    return c.json({ error: msg }, status);
  }
  try {
    const page = session.stagehand.context.activePage();
    if (!page) return c.json({ error: 'no active page' }, 500);
    const png = await page.screenshot({ type: 'png', fullPage: false });
    return c.body(toBodyBytes(png), 200, { 'content-type': 'image/png' });
  } catch (err) {
    logger.warn({ err, sessionId }, 'live screenshot failed');
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    pool.release(sessionId);
  }
});

/**
 * GET /v1/static/screenshots/:f — serve archived screenshot bytes from the
 * data dir. Path-traversal defense: reject any name with separators or `..`.
 * M16 swaps this for an S3-signed URL handler.
 */
app.get('/v1/static/screenshots/:f', async (c) => {
  const f = c.req.param('f');
  if (f.includes('/') || f.includes('\\') || f.includes('..')) {
    return c.json({ error: 'bad_path' }, 400);
  }
  const path = join(dataRoot(), 'screenshots', f);
  try {
    await stat(path);
    const bytes = await readFile(path);
    return c.body(toBodyBytes(bytes), 200, { 'content-type': 'image/png' });
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
});

/**
 * Start the HTTP server. Lazily imports @hono/node-server and dotenv-safe only when
 * invoked, so importing this module from tests stays side-effect-free (no port bind,
 * no .env requirement).
 *
 * Default port 4001 (backend=3001, pipecat=8000, admin=5173).
 */
export async function start(port: number = Number(process.env.PORT ?? 4001)): Promise<Server> {
  // dotenv-safe throws if the runtime .env is missing keys declared in .env.template.
  // Loaded inside start() (not at module top) so tests don't require a .env file.
  // dotenv-safe ships no `exports` map, so we call .config() instead of importing
  // the side-effect subpath. Types come from src/types/dotenv-safe.d.ts.
  const dotenvSafe = await import('dotenv-safe');
  dotenvSafe.default.config();
  const { serve } = await import('@hono/node-server');

  const server = serve({ fetch: app.fetch, port }) as Server;
  logger.info({ port }, 'f16-stagehand listening');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // Drain browser pool BEFORE closing the HTTP server so in-flight intents
    // finish cleanly. Catch + log so a pool failure can't block the http close.
    try {
      await pool.closeAll();
    } catch (err) {
      logger.error({ err }, 'pool drain failed');
    }
    server.close(() => process.exit(0));
    // Hard-exit fallback if connections hang past the grace window.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', (sig) => {
    void shutdown(sig);
  });
  process.on('SIGTERM', (sig) => {
    void shutdown(sig);
  });

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
