/**
 * Admin integrations health endpoint (M14.T7).
 *
 *   GET /v1/admin/integrations/health
 *     Probes every external integration F16 talks to and returns a
 *     stable status payload. The UI renders one tile per integration
 *     with a color matching `status`.
 *
 * Status taxonomy:
 *   - `ok`            — probe succeeded
 *   - `unconfigured`  — required env var(s) missing; treated as "not in use"
 *                       rather than a failure
 *   - `unreachable`   — probe was attempted and threw / non-2xx
 *   - `degraded`      — reached but the payload indicates a soft issue
 *                       (e.g. WAHA session not in WORKING state)
 *
 * Probe budget: every probe runs with a 2.5s timeout and they all run
 * concurrently — a slow integration shouldn't block the whole panel.
 *
 * What we probe:
 *   - WAHA           — GET /api/sessions/{name}; status must be 'WORKING'
 *   - HubSpot        — GET /crm/v3/owners?limit=1 with API token
 *   - Pipecat        — GET /health on the configured Pipecat URL
 *   - Maxance        — env-presence only (MAXANCE_DRIVER); the live
 *                      extension WS state is owned by the maxance-operator
 *                      agent and surfaced separately on /agents (M14 V2)
 *   - Anthropic      — env-presence only (ANTHROPIC_API_KEY). A live
 *                      probe burns tokens; not worth it.
 *   - OpenRouter     — env-presence only (OPENROUTER_API_KEY)
 *   - BillionMail    — env-presence only (BILLIONMAIL_API_KEY)
 *
 * PII discipline: probe error messages are passed through `String(err)`
 * — no secrets are echoed since we never include the key in the request
 * URL. We do truncate long errors to keep the payload bounded.
 */
import { Hono } from 'hono';
import { logger } from '../logger.js';

export interface AdminIntegrationsRouterOptions {
  /** Override the probe timeout (ms). Default 2500. */
  probeTimeoutMs?: number;
  /** Override fetch — tests pass a stub. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type IntegrationStatus = 'ok' | 'unconfigured' | 'unreachable' | 'degraded';

export interface IntegrationHealth {
  name: string;
  status: IntegrationStatus;
  detail?: string;
  durationMs?: number;
  /** True iff this integration is expected to be running for current flags. */
  required: boolean;
}

export interface IntegrationsHealthResponse {
  generatedAt: string;
  integrations: IntegrationHealth[];
}

export function buildAdminIntegrationsRouter(opts: AdminIntegrationsRouterOptions = {}): Hono {
  const app = new Hono();
  const timeoutMs = opts.probeTimeoutMs ?? 2500;
  const f = opts.fetchImpl ?? fetch;

  app.get('/v1/admin/integrations/health', async (c) => {
    const probes = await Promise.all([
      probeWaha(f, timeoutMs),
      probeHubspot(f, timeoutMs),
      probePipecat(f, timeoutMs),
      envPresenceProbe('maxance', 'MAXANCE_DRIVER'),
      envPresenceProbe('anthropic', 'ANTHROPIC_API_KEY'),
      envPresenceProbe('openrouter', 'OPENROUTER_API_KEY'),
      envPresenceProbe('billionmail', 'BILLIONMAIL_API_KEY'),
    ]);
    const body: IntegrationsHealthResponse = {
      generatedAt: new Date().toISOString(),
      integrations: probes,
    };
    return c.json(body, 200);
  });

  return app;
}

async function probeWaha(f: typeof fetch, timeoutMs: number): Promise<IntegrationHealth> {
  const base = process.env.WAHA_BASE_URL;
  if (!base) {
    return { name: 'waha', status: 'unconfigured', required: false };
  }
  const session = process.env.WAHA_SESSION ?? 'default';
  const headers: Record<string, string> = {};
  if (process.env.WAHA_API_KEY) headers['x-api-key'] = process.env.WAHA_API_KEY;
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(
      f,
      `${base.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(session)}`,
      { headers },
      timeoutMs,
    );
    const durationMs = Date.now() - t0;
    if (!res.ok) {
      return {
        name: 'waha',
        status: 'unreachable',
        detail: `HTTP ${res.status}`,
        durationMs,
        required: true,
      };
    }
    const payload = (await res.json().catch(() => ({}))) as { status?: string };
    if (payload.status && payload.status !== 'WORKING') {
      return {
        name: 'waha',
        status: 'degraded',
        detail: `session status: ${payload.status}`,
        durationMs,
        required: true,
      };
    }
    return { name: 'waha', status: 'ok', durationMs, required: true };
  } catch (err) {
    return {
      name: 'waha',
      status: 'unreachable',
      detail: truncate(err instanceof Error ? err.message : String(err)),
      durationMs: Date.now() - t0,
      required: true,
    };
  }
}

async function probeHubspot(f: typeof fetch, timeoutMs: number): Promise<IntegrationHealth> {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) {
    return { name: 'hubspot', status: 'unconfigured', required: false };
  }
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(
      f,
      'https://api.hubapi.com/crm/v3/owners?limit=1',
      { headers: { Authorization: `Bearer ${token}` } },
      timeoutMs,
    );
    const durationMs = Date.now() - t0;
    if (!res.ok) {
      return {
        name: 'hubspot',
        status: 'unreachable',
        detail: `HTTP ${res.status}`,
        durationMs,
        required: true,
      };
    }
    return { name: 'hubspot', status: 'ok', durationMs, required: true };
  } catch (err) {
    return {
      name: 'hubspot',
      status: 'unreachable',
      detail: truncate(err instanceof Error ? err.message : String(err)),
      durationMs: Date.now() - t0,
      required: true,
    };
  }
}

async function probePipecat(f: typeof fetch, timeoutMs: number): Promise<IntegrationHealth> {
  const base = process.env.PIPECAT_BASE_URL;
  if (!base) {
    return { name: 'pipecat', status: 'unconfigured', required: false };
  }
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(f, `${base.replace(/\/$/, '')}/health`, {}, timeoutMs);
    const durationMs = Date.now() - t0;
    if (!res.ok) {
      return {
        name: 'pipecat',
        status: 'unreachable',
        detail: `HTTP ${res.status}`,
        durationMs,
        required: true,
      };
    }
    return { name: 'pipecat', status: 'ok', durationMs, required: true };
  } catch (err) {
    return {
      name: 'pipecat',
      status: 'unreachable',
      detail: truncate(err instanceof Error ? err.message : String(err)),
      durationMs: Date.now() - t0,
      required: true,
    };
  }
}

/**
 * Cheap "is this integration configured?" check for back-ends we don't
 * actively probe (Anthropic, OpenRouter, BillionMail, Maxance). Returns
 * `ok` when the env var is set, `unconfigured` otherwise. The UI groups
 * these so the operator can tell at a glance "this is wired" vs "not in
 * use" without a live network call.
 */
function envPresenceProbe(name: string, envVar: string): IntegrationHealth {
  const v = process.env[envVar];
  if (v && v.length > 0) {
    return { name, status: 'ok', detail: 'env var set', required: false };
  }
  return { name, status: 'unconfigured', required: false };
}

/**
 * Helper: fetch with an AbortController-driven timeout. Hono's runtime
 * + node 22 ships AbortSignal.timeout, but we wrap in an explicit
 * AbortController for compatibility with the stub fetch in tests.
 */
async function fetchWithTimeout(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`probe_timeout_${timeoutMs}ms`)), timeoutMs);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function truncate(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Suppress unused-import lint warning — `logger` is reserved for future
// audit-log hookup when integrations flip from ok→degraded.
void logger;
