/**
 * Stagehand HTTP service entrypoint.
 *
 * 🚨 The /v1/maxance/* endpoints in this file DO NOT drive production
 * Maxance — Cloudflare Turnstile blocks every Playwright-launched Chrome
 * (proven by 3 live attempts in M8.T2/T3). They survive as the reference
 * HTTP contract that the M8.T8 phase 2 Chrome-extension WS bridge will
 * mirror, and as a callable surface for any non-Cloudflare Maxance staging
 * mirror Achraf might surface later. The Operator agent gates them off via
 * MAXANCE_DRIVER=stagehand_legacy_DO_NOT_USE_IN_PROD — the prod default
 * (MAXANCE_DRIVER=chrome_extension or unset) never reaches these handlers.
 *
 * Non-Maxance endpoints (/v1/static/*, /v1/intent, /health) are unaffected
 * and continue to serve real traffic.
 */
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
import { loginMaxance } from './maxance/login.js';
import { startQuote } from './maxance/quote.js';
import { confirmQuote } from './maxance/quote-confirm.js';
import type {
  HumanActionRequest,
  MaxanceCivilite,
  MaxanceConfirmQuoteParams,
  MaxanceConfirmQuoteResult,
  MaxanceLoginResult,
  MaxanceQuoteParams,
  MaxanceQuoteResult,
  MaxanceStationnement,
  MaxanceSubscriberInfo,
} from './maxance/types.js';

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
 * Pending 2FA prompts, keyed by sessionId. When `loginMaxance` hits the SMS
 * branch it pushes a `{ resolve, reject, request }` entry here, then awaits.
 * The `/v1/maxance/2fa-code` handler pops the entry and resolves with the code.
 *
 * In-memory by design: the M8.T2 service is the only writer/reader, and a
 * pending login that gets restarted across a process bounce is unrecoverable
 * anyway (the Stagehand browser session lives in the same process).
 */
interface Pending2fa {
  request: HumanActionRequest;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
}
const pending2fa = new Map<string, Pending2fa>();

/**
 * POST /v1/maxance/login — drive the Maxance login + Proximéo SSO bootstrap.
 *
 * Body: `{ sessionName?: string }`. If a session with that name already
 * exists in the pool we reuse it (cookies persist via the pool's userDataDir);
 * otherwise we create a fresh session.
 *
 * Returns: MaxanceLoginResult. On a 2FA prompt the handler PARKS the login
 * function and registers a pending entry — the caller must POST the code to
 * /v1/maxance/2fa-code. The login function's 15min default timeout bounds
 * the wait; an exceeded timeout fails the request with a sanitised error.
 */
app.post('/v1/maxance/login', async (c) => {
  const raw = await c.req.text();
  if (!verifyHmac(c, raw)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let body: { sessionName?: string } = {};
  if (raw) {
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
  }
  const sessionName = body.sessionName ?? 'maxance-default';

  // Look up by name (reuse) or create. The pool's userDataDir is per-sessionId
  // so cookies actually survive only within a single Stagehand instance for
  // V1 — M8.T5 will fold name-keyed reuse across restarts.
  const existing = pool.list().find((s) => s.name === sessionName);
  let sessionId: string;
  if (existing) {
    sessionId = existing.sessionId;
  } else {
    try {
      const info = await pool.create({ name: sessionName });
      sessionId = info.sessionId;
    } catch (err) {
      logger.error({ err }, 'maxance: session create failed');
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  }

  let session;
  try {
    session = pool.borrow(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.endsWith('not found') ? 404 : 409;
    return c.json({ error: msg }, status);
  }

  try {
    const result: MaxanceLoginResult = await loginMaxance(session.stagehand, sessionId, {
      dataRoot: dataRoot(),
      humanActionResolver: (request) =>
        new Promise<string>((resolve, reject) => {
          // Drop any prior pending entry for this session (caller restarted).
          const prior = pending2fa.get(sessionId);
          if (prior) {
            prior.reject(new Error('superseded_by_new_2fa_request'));
          }
          pending2fa.set(sessionId, { request, resolve, reject });
          logger.info({ sessionId, summary: request.summary }, 'maxance: 2FA prompt parked');
        }).finally(() => {
          pending2fa.delete(sessionId);
        }),
    });
    return c.json(result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId, err: msg }, 'maxance: login failed');
    return c.json({ error: msg }, 500);
  } finally {
    pool.release(sessionId);
  }
});

/**
 * POST /v1/maxance/2fa-code — resolve a pending SMS prompt.
 *
 * Body: `{ sessionId: string; code: string }`. Returns 200 on success, 404
 * if no prompt is pending for that session. Authenticated with the same HMAC.
 */
app.post('/v1/maxance/2fa-code', async (c) => {
  const raw = await c.req.text();
  if (!verifyHmac(c, raw)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let body: { sessionId?: string; code?: string };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (!body.sessionId || typeof body.code !== 'string' || body.code.trim().length === 0) {
    return c.json({ error: 'missing_fields' }, 400);
  }
  const pending = pending2fa.get(body.sessionId);
  if (!pending) {
    return c.json({ error: 'no_pending_2fa' }, 404);
  }
  pending.resolve(body.code.trim());
  return c.json({ accepted: true }, 200);
});

/**
 * POST /v1/maxance/quote — drive the trottinette quote flow on a session
 * that is ALREADY logged in to Maxance.
 *
 * Body (JSON):
 *   {
 *     sessionName: string,         // BrowserPool name; default 'maxance-default'
 *     params: MaxanceQuoteParams,  // see stagehand/src/maxance/types.ts
 *     dryRun?: boolean,            // default TRUE — stops at price preview
 *     timeoutMs?: number,          // override the 5-min wall-clock budget
 *   }
 *
 * Returns MaxanceQuoteResult (200) on success. The backend Maxance Operator
 * agent (M8.T4) is the canonical caller; the dryRun guardrail in quote.ts
 * makes accidental full-Valider submissions impossible from this endpoint.
 *
 * HMAC: same shared secret as /v1/maxance/login. Body MUST be the exact
 * raw bytes the signature was computed over.
 */
app.post('/v1/maxance/quote', async (c) => {
  const raw = await c.req.text();
  if (!verifyHmac(c, raw)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let body: {
    sessionName?: string;
    params?: Partial<MaxanceQuoteParams>;
    dryRun?: boolean;
    timeoutMs?: number;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  // Param surface validation — the agent should be sending a complete payload
  // but we double-check the must-haves so a malformed envelope dies with a
  // descriptive 400 instead of a 500 from deep inside startQuote.
  const p = body.params;
  if (!p || typeof p !== 'object') {
    return c.json({ error: 'missing_params' }, 400);
  }
  if (p.vehicleKind !== 'trottinette') {
    return c.json({ error: 'unsupported_vehicle_kind' }, 400);
  }
  if (typeof p.purchasePriceEur !== 'number' || !Number.isFinite(p.purchasePriceEur)) {
    return c.json({ error: 'invalid_purchase_price' }, 400);
  }
  if (!p.purchaseDate) {
    return c.json({ error: 'missing_purchase_date' }, 400);
  }
  if (!p.postalCode || typeof p.postalCode !== 'string') {
    return c.json({ error: 'missing_postal_code' }, 400);
  }
  if (!p.clientDateOfBirth) {
    return c.json({ error: 'missing_client_dob' }, 400);
  }
  const stationnement = p.stationnement as MaxanceStationnement | undefined;
  const validStationnements: MaxanceStationnement[] = [
    'garage_box',
    'parking_prive_clos',
    'parking_prive_non_clos',
    'rue',
  ];
  if (!stationnement || !validStationnements.includes(stationnement)) {
    return c.json({ error: 'invalid_stationnement' }, 400);
  }
  // Date strings may arrive as ISO — convert at the boundary.
  const purchaseDate =
    p.purchaseDate instanceof Date ? p.purchaseDate : new Date(p.purchaseDate as string);
  const clientDob =
    p.clientDateOfBirth instanceof Date
      ? p.clientDateOfBirth
      : new Date(p.clientDateOfBirth as string);
  if (!Number.isFinite(purchaseDate.getTime()) || !Number.isFinite(clientDob.getTime())) {
    return c.json({ error: 'invalid_date_format' }, 400);
  }

  const fullParams: MaxanceQuoteParams = {
    vehicleKind: 'trottinette',
    purchasePriceEur: p.purchasePriceEur,
    purchaseDate,
    postalCode: p.postalCode,
    stationnement,
    clientDateOfBirth: clientDob,
    ...(p.city ? { city: p.city } : {}),
    ...(p.formule ? { formule: p.formule } : {}),
    ...(p.commissionPct !== undefined ? { commissionPct: p.commissionPct } : {}),
    ...(p.fractionnement ? { fractionnement: p.fractionnement } : {}),
  };

  const sessionName = body.sessionName ?? 'maxance-default';
  const existing = pool.list().find((s) => s.name === sessionName);
  if (!existing) {
    return c.json({ error: 'session_not_found', sessionName }, 404);
  }

  let session;
  try {
    session = pool.borrow(existing.sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 409);
  }

  try {
    const result: MaxanceQuoteResult = await startQuote(
      session.stagehand,
      existing.sessionId,
      fullParams,
      {
        dataRoot: dataRoot(),
        dryRun: body.dryRun ?? true,
        ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      },
    );
    return c.json(result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId: existing.sessionId, err: msg }, 'maxance-quote: HTTP flow failed');
    return c.json({ error: msg }, 500);
  } finally {
    pool.release(existing.sessionId);
  }
});

/**
 * POST /v1/maxance/quote/confirm — drive Valider devis + email send (M8.T6).
 *
 * Pre-condition: a previous successful call to /v1/maxance/quote on the
 * SAME session has left the browser on the Garanties tab with a price
 * preview. This endpoint continues from there.
 *
 * Body (JSON):
 *   {
 *     sessionName: string,                       // BrowserPool name
 *     subscriber: MaxanceSubscriberInfo,         // Devis tab fields
 *     dryRun?: boolean,                          // default TRUE (stops before Envoyer)
 *     timeoutMs?: number,
 *   }
 *
 * Returns MaxanceConfirmQuoteResult on success (200). Devis number is the
 * primary key for the M8.T7 souscription path ("Reprendre devis via search").
 */
app.post('/v1/maxance/quote/confirm', async (c) => {
  const raw = await c.req.text();
  if (!verifyHmac(c, raw)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let body: {
    sessionName?: string;
    subscriber?: Partial<MaxanceSubscriberInfo>;
    dryRun?: boolean;
    timeoutMs?: number;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const s = body.subscriber;
  if (!s || typeof s !== 'object') {
    return c.json({ error: 'missing_subscriber' }, 400);
  }
  // Validate the must-haves at the boundary so a malformed envelope dies
  // with a descriptive 400 instead of a Stagehand-side 500.
  const civilite = s.civilite as MaxanceCivilite | undefined;
  if (civilite !== 'monsieur' && civilite !== 'madame') {
    return c.json({ error: 'invalid_civilite' }, 400);
  }
  // Validate must-haves at the boundary AND capture them as strict locals
  // so the type narrows for the literal we hand to confirmQuote below.
  const requiredString = (key: keyof MaxanceSubscriberInfo, value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) {
      logger.debug({ key }, 'maxance-confirm: missing required subscriber field');
      return undefined;
    }
    return value;
  };
  const lastName = requiredString('lastName', s.lastName);
  if (lastName === undefined) return c.json({ error: 'missing_lastName' }, 400);
  const firstName = requiredString('firstName', s.firstName);
  if (firstName === undefined) return c.json({ error: 'missing_firstName' }, 400);
  const addressLine = requiredString('addressLine', s.addressLine);
  if (addressLine === undefined) return c.json({ error: 'missing_addressLine' }, 400);
  const postalCode = requiredString('postalCode', s.postalCode);
  if (postalCode === undefined) return c.json({ error: 'missing_postalCode' }, 400);
  const city = requiredString('city', s.city);
  if (city === undefined) return c.json({ error: 'missing_city' }, 400);
  const phoneMobile = requiredString('phoneMobile', s.phoneMobile);
  if (phoneMobile === undefined) return c.json({ error: 'missing_phoneMobile' }, 400);
  const email = requiredString('email', s.email);
  if (email === undefined) return c.json({ error: 'missing_email' }, 400);
  // Cheap email sanity — not a full RFC check, just enough to refuse the
  // obvious garbage. Maxance does its own server-side validation downstream.
  if (!email.includes('@') || !email.includes('.')) {
    return c.json({ error: 'invalid_email' }, 400);
  }

  const subscriber: MaxanceSubscriberInfo = {
    civilite,
    lastName,
    firstName,
    addressLine,
    postalCode,
    city,
    phoneMobile,
    email,
    ...(s.addressComplement ? { addressComplement: s.addressComplement } : {}),
    ...(s.profession ? { profession: s.profession } : {}),
  };
  const params: MaxanceConfirmQuoteParams = { subscriber };

  const sessionName = body.sessionName ?? 'maxance-default';
  const existing = pool.list().find((sn) => sn.name === sessionName);
  if (!existing) {
    return c.json({ error: 'session_not_found', sessionName }, 404);
  }
  let session;
  try {
    session = pool.borrow(existing.sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 409);
  }

  try {
    const result: MaxanceConfirmQuoteResult = await confirmQuote(
      session.stagehand,
      existing.sessionId,
      params,
      {
        dataRoot: dataRoot(),
        dryRun: body.dryRun ?? true,
        ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      },
    );
    return c.json(result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId: existing.sessionId, err: msg }, 'maxance-confirm: flow failed');
    return c.json({ error: msg }, 500);
  } finally {
    pool.release(existing.sessionId);
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
