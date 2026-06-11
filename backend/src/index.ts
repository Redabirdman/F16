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
import { buildVoiceRouter } from './http/voice.js';
import { buildOpenAiSipRouter } from './http/openai-sip.js';
import { buildVoiceCallRequestRouter } from './http/voice-call-request.js';
import { buildMetaLeadgenRouter } from './http/meta-leadgen-webhook.js';
import { MetaGraphClient } from './integrations/meta/client.js';
import { buildSessionLookupRouter } from './http/session-lookup.js';
import { buildAdminLeadsRouter } from './admin/leads-list.js';
import { buildAdminLeadDetailRouter } from './admin/lead-detail.js';
import { buildAdminHumanActionsRouter } from './admin/human-actions.js';
import { buildAdminAuditRouter } from './admin/audit-export.js';
import { buildAdminDashboardRouter } from './admin/dashboard.js';
import { buildAdminIntegrationsRouter } from './admin/integrations-health.js';
import { buildAdminRealtimeRouter } from './admin/realtime-sse.js';
import { buildAdminAgentsRouter } from './admin/agents.js';
import { buildAdminAdsRouter } from './admin/ads.js';
import { buildAdminKnowledgeRouter } from './admin/knowledge-search.js';
import { buildAdminPromptsRouter } from './admin/prompts.js';
import { buildAdminTeamChatRouter } from './admin/team-chat.js';
import { WahaClient } from './channels/whatsapp/waha-client.js';
import { requireAdminAuth } from './admin/auth.js';
import type { RealtimeListener } from './realtime/notify.js';
import { metrics, registerDefaultMetrics } from './metrics/index.js';
import { registerQueueDepthCollector } from './queue/index.js';
import { INTENT_TO_QUEUE } from './messaging/dispatcher.js';

// Register the default process gauges once at module load (idempotent).
registerDefaultMetrics();

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
  /**
   * Shared Postgres LISTEN/NOTIFY listener. When provided, the admin
   * SSE endpoint (`/v1/admin/events`) is mounted and subscribes to it.
   * Owned + started by `start()`; left undefined in test/smoke contexts.
   */
  realtime?: RealtimeListener;
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

  // M16 — Prometheus scrape endpoint. Open by default (exposes only counters /
  // gauges, no secrets); set METRICS_BEARER_TOKEN to require `Authorization:
  // Bearer <token>` when the tunnel exposes it publicly.
  app.get('/metrics', async (c) => {
    const token = process.env.METRICS_BEARER_TOKEN;
    if (token) {
      const auth = c.req.header('authorization') ?? '';
      if (auth !== `Bearer ${token}`) return c.text('unauthorized', 401);
    }
    const body = await metrics.render();
    return c.text(body, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
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
      ...(process.env.WAHA_HMAC_ALGO ? { hmacAlgo: process.env.WAHA_HMAC_ALGO } : {}),
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

    // M10 — synchronous voice turn webhook (`POST /v1/voice/turn`). Pipecat
    // POSTs a transcript and gets the Sales Agent's reply text back to speak.
    // Protected service-to-service with the SAME shared webhook secret as
    // `/v1/leads` (NOT the admin bearer) — it's a machine-to-machine call.
    const voiceApp = buildVoiceRouter({
      db: opts.db,
      ...(opts.leadIntakeHmacSecret ? { hmacSecret: opts.leadIntakeHmacSecret } : {}),
    });
    app.route('/', voiceApp);

    // M10 V2 — website "call me" intake (`POST /v1/voice/call-request`).
    // Resolves/creates the lead by phone and emits VOICE.CALL_SCHEDULED → the
    // voice-operator dials via native SIP. Same shared HMAC secret as /v1/leads.
    const voiceCallRequestApp = buildVoiceCallRequestRouter({
      db: opts.db,
      ...(opts.leadIntakeHmacSecret ? { hmacSecret: opts.leadIntakeHmacSecret } : {}),
    });
    app.route('/', voiceCallRequestApp);

    // Voice — session-lookup route (`GET /v1/voice/session/:sessionId`). After
    // Asterisk bridges an answered call to AudioSocket, Pipecat knows only the
    // AudioSocket UUID (= our F16 sessionId) and calls this to resolve the
    // lead/customer it belongs to. Secured by a shared-secret header
    // (`x-f16-internal-secret` === F16_SESSION_LOOKUP_SECRET); when the secret
    // is unset (dev) the check is skipped. No call-control webhook is needed —
    // Asterisk's f16-dial dialplan owns call control entirely.
    const sessionLookupApp = buildSessionLookupRouter({
      ...(process.env.F16_SESSION_LOOKUP_SECRET
        ? { lookupSecret: process.env.F16_SESSION_LOOKUP_SECRET }
        : {}),
    });
    app.route('/', sessionLookupApp);

    // M10 V2 — OpenAI Realtime NATIVE SIP webhook (`POST /v1/voice/openai-webhook`).
    // OpenAI is the SIP endpoint and handles ALL call audio; this route accepts
    // the incoming-call webhook with the French Assuryal session config and
    // drives the conversation over a control WebSocket. Env-gated on
    // OPENAI_API_KEY (returns null → not mounted when absent). The signing
    // secret (OPENAI_WEBHOOK_SECRET, whsec_…) enables signature verification.
    const openAiSipApp = buildOpenAiSipRouter({
      db: opts.db,
      apiKey: process.env.OPENAI_API_KEY ?? '',
      ...(process.env.OPENAI_WEBHOOK_SECRET
        ? { webhookSecret: process.env.OPENAI_WEBHOOK_SECRET }
        : {}),
      ...(process.env.OPENAI_REALTIME_MODEL ? { model: process.env.OPENAI_REALTIME_MODEL } : {}),
      ...(process.env.OPENAI_REALTIME_VOICE ? { voice: process.env.OPENAI_REALTIME_VOICE } : {}),
    });
    if (openAiSipApp) {
      app.route('/', openAiSipApp);
      logger.info({}, 'OpenAI Realtime SIP webhook mounted at /v1/voice/openai-webhook');
    }

    // M12 — Meta Lead Ads webhook (`/v1/meta/leadgen-webhook`). Mounted only
    // when a System User token + verify token are configured (env). The GET
    // handshake verifies the subscription; the POST leadgen path fetches each
    // lead via Graph and runs it through `ingestLead` (dual-write + LEAD.NEW),
    // scheduling a voice callback for `call`-preference leads.
    const metaToken = process.env.META_SYSTEM_USER_TOKEN;
    const metaVerifyToken = process.env.META_LEADGEN_VERIFY_TOKEN;
    if (metaToken && metaVerifyToken) {
      const metaClient = new MetaGraphClient({
        accessToken: metaToken,
        ...(process.env.META_APP_SECRET ? { appSecret: process.env.META_APP_SECRET } : {}),
        ...(process.env.META_GRAPH_API_VERSION
          ? { apiVersion: process.env.META_GRAPH_API_VERSION }
          : {}),
      });
      const metaLeadgenApp = buildMetaLeadgenRouter({
        db: opts.db,
        client: metaClient,
        verifyToken: metaVerifyToken,
        ...(process.env.META_APP_SECRET ? { appSecret: process.env.META_APP_SECRET } : {}),
      });
      app.route('/', metaLeadgenApp);
      logger.info({}, 'Meta leadgen webhook mounted at /v1/meta/leadgen-webhook');
    }

    // M14 V1 + V2 — admin surface. Auth middleware reads
    // ADMIN_BEARER_TOKEN; when unset (dev), it's a no-op. Mount BEFORE the
    // routers so every /v1/admin/* request is gated.
    app.use('/v1/admin/*', requireAdminAuth());

    // Option D + M14 V1 — admin read-only API surface. Backs the admin
    // UI's lead board, lead detail, human-action queue, and audit page.
    const adminLeadsApp = buildAdminLeadsRouter({ db: opts.db });
    app.route('/', adminLeadsApp);
    const adminLeadDetailApp = buildAdminLeadDetailRouter({ db: opts.db });
    app.route('/', adminLeadDetailApp);
    const adminHumanActionsApp = buildAdminHumanActionsRouter({ db: opts.db });
    app.route('/', adminHumanActionsApp);
    // M13 — audit log read + ACPR forensic NDJSON export.
    const adminAuditApp = buildAdminAuditRouter({ db: opts.db });
    app.route('/', adminAuditApp);
    // M14.T3 — dashboard KPIs (single aggregated endpoint).
    const adminDashboardApp = buildAdminDashboardRouter({ db: opts.db });
    app.route('/', adminDashboardApp);
    // M14.T7 — integrations health (live probes + env-presence checks).
    const adminIntegrationsApp = buildAdminIntegrationsRouter();
    app.route('/', adminIntegrationsApp);
    // M15.T2 — agents registry view + kill / setPriority.
    const adminAgentsApp = buildAdminAgentsRouter({ db: opts.db });
    app.route('/', adminAgentsApp);
    // M14 V2.5 — ads surface (campaigns / creatives / creative_learnings).
    const adminAdsApp = buildAdminAdsRouter({ db: opts.db });
    app.route('/', adminAdsApp);
    // M14.T8 — knowledge semantic search (verify what the agents know).
    const adminKnowledgeApp = buildAdminKnowledgeRouter({ db: opts.db });
    app.route('/', adminKnowledgeApp);
    // M14.T6 — agent prompt editor (registry-backed overrides).
    const adminPromptsApp = buildAdminPromptsRouter({ db: opts.db });
    app.route('/', adminPromptsApp);
    // M14.T10 — team-chat: operator timeline + send-to-WA-group.
    const teamChatWaha = process.env.WAHA_BASE_URL
      ? new WahaClient({
          baseUrl: process.env.WAHA_BASE_URL,
          ...(process.env.WAHA_API_KEY ? { apiKey: process.env.WAHA_API_KEY } : {}),
          ...(process.env.WAHA_SESSION ? { session: process.env.WAHA_SESSION } : {}),
        })
      : undefined;
    const adminTeamChatApp = buildAdminTeamChatRouter({
      db: opts.db,
      ...(teamChatWaha ? { waha: teamChatWaha } : {}),
      ...(process.env.HUMAN_ACTION_GROUP_CHAT_ID
        ? { groupChatId: process.env.HUMAN_ACTION_GROUP_CHAT_ID }
        : {}),
    });
    app.route('/', adminTeamChatApp);
    // M14.T2 — SSE realtime stream, only when a listener was provided.
    if (opts.realtime) {
      const adminRealtimeApp = buildAdminRealtimeRouter({ realtime: opts.realtime });
      app.route('/', adminRealtimeApp);
    }
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

  // M14.T2 — start the Postgres LISTEN/NOTIFY listener so the admin SSE
  // endpoint has events to fan out. Wrapped in try/catch so a missing
  // realtime trigger (e.g. older schema) doesn't refuse to boot the
  // server entirely; the admin UI falls back to polling.
  const { RealtimeListener } = await import('./realtime/notify.js');
  const dbUrl = process.env['DATABASE_URL'];
  let realtime: RealtimeListener | undefined;
  if (dbUrl) {
    try {
      const rt = new RealtimeListener({ databaseUrl: dbUrl });
      await rt.start();
      realtime = rt;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'realtime: failed to start — admin SSE endpoint will be disabled',
      );
    }
  }

  const liveApp = buildApp({
    db: db(),
    ...(wahaSecret ? { wahaHmacSecret: wahaSecret } : {}),
    ...(leadIntakeSecret ? { leadIntakeHmacSecret: leadIntakeSecret } : {}),
    ...(realtime ? { realtime } : {}),
  });

  const server = serve({ fetch: liveApp.fetch, port }) as Server;
  logger.info({ port }, 'f16-backend listening');

  // Wire channel adapters into the runtime registry. Without this, every
  // `sendViaChannel()` → `getChannel('whatsapp'|'email')` throws
  // "No channel registered", so the sales-agent + engagement-agent
  // customer-reply path is dead. Env-gated inside the helper (no-op when
  // WAHA_BASE_URL / BILLIONMAIL_SMTP_HOST are unset), so dev/test boots are
  // unaffected; a bad SMTP config is logged and never blocks boot.
  const { registerConfiguredChannels } = await import('./channels/bootstrap.js');
  await registerConfiguredChannels();

  // Boot every backend worker / agent (env-gated). Closes the deployment
  // loop for hubspot-sync, reporter-agent, maxance-operator, the sales
  // spawn orchestrator, and lead-scorer. Without this call, the routes
  // accept requests but nothing downstream actually processes them.
  const { startWorkers } = await import('./supervisor/index.js');
  const workerSet = await startWorkers({ db: db() });

  // M16 — snapshot live BullMQ depth per queue on every /metrics scrape.
  // Distinct queue names come from the intent→queue routing table.
  registerQueueDepthCollector([...new Set(Object.values(INTENT_TO_QUEUE))]);

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    // Stop workers first (drains in-flight jobs), close the realtime
    // listener (frees its dedicated pg connection), then the HTTP server.
    void workerSet
      .stop()
      .catch((err: unknown) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'supervisor: stop threw',
        ),
      )
      .then(() => (realtime ? realtime.stop() : undefined))
      .catch((err: unknown) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'realtime: stop threw',
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
