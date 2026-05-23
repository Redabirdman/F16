/**
 * Typed HTTP client for the Stagehand service (M8.T4).
 *
 * Wraps the four endpoints the Maxance Operator agent calls:
 *   - POST /v1/maxance/login   — ensure a logged-in session exists
 *   - POST /v1/maxance/quote   — drive the trottinette quote flow
 *   - POST /v1/maxance/2fa-code — resolve an SMS prompt (used only when the
 *                                 30-day Auth0 cookie expires)
 *   - GET  /health             — used by the agent's onStart liveness check
 *
 * HMAC: every POST body is signed with `STAGEHAND_HMAC_SECRET`. The secret
 * MUST be the same on the backend and stagehand processes; the Stagehand
 * service rejects unsigned/wrong-signed requests with 401.
 *
 * Network failures bubble up as `StagehandClientError` with a short tag —
 * the agent maps these to the QUOTE.FAILED intent. Sensitive details from
 * the response body (which Stagehand already sanitises) propagate verbatim.
 */
import { createHmac } from 'node:crypto';
import { logger } from '../../logger.js';

/** Discriminated subset of the Stagehand /v1/maxance/quote response. */
export interface QuotePreviewResult {
  sessionId: string;
  durationMs: number;
  screenshots: { step: string; url: string }[];
  dryRun: boolean;
  pricePreviewEur: { monthly?: number; annual?: number };
  finalUrl: string;
}

/** Subset of the Stagehand /v1/maxance/login response. */
export interface LoginResult {
  sessionId: string;
  durationMs: number;
  screenshots: { step: string; url: string }[];
  alreadyLoggedIn: boolean;
  requiredHumanAction: boolean;
  finalUrl: string;
}

/** Params for /v1/maxance/quote — mirrors stagehand's MaxanceQuoteParams. */
export interface StagehandQuoteParams {
  vehicleKind: 'trottinette';
  purchasePriceEur: number;
  /** Pass an ISO string OR a Date — both work; the service normalises. */
  purchaseDate: string | Date;
  postalCode: string;
  city?: string;
  stationnement: 'garage_box' | 'parking_prive_clos' | 'parking_prive_non_clos' | 'rue';
  /** Pass an ISO string OR a Date. */
  clientDateOfBirth: string | Date;
  formule?: 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';
  commissionPct?: number;
  fractionnement?: 'mensuel' | 'annuel';
}

export class StagehandClientError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'StagehandClientError';
  }
}

export interface StagehandClientConfig {
  baseUrl: string;
  /** HMAC secret; if absent on dev runs, requests go unsigned (Stagehand allows that with a warning). */
  hmacSecret?: string;
  /** Per-call default timeout in ms. Default 6 minutes (covers the cold quote-flow path). */
  timeoutMs?: number;
}

export class StagehandClient {
  private readonly baseUrl: string;
  private readonly hmacSecret?: string;
  private readonly timeoutMs: number;

  constructor(cfg: StagehandClientConfig) {
    // Trim trailing slash so route concatenation is predictable.
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    if (cfg.hmacSecret) this.hmacSecret = cfg.hmacSecret;
    this.timeoutMs = cfg.timeoutMs ?? 6 * 60_000;
  }

  /** Build the signed request headers. */
  private headers(body: string): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.hmacSecret) {
      const sig = createHmac('sha256', this.hmacSecret).update(body).digest('hex');
      h['x-stagehand-signature'] = `sha256=${sig}`;
    }
    return h;
  }

  /**
   * Generic POST wrapper. Wall-clock-bounded via AbortController; any non-2xx
   * response is converted to a StagehandClientError carrying the error code
   * Stagehand returned (e.g. `maxance_quote_unexpected_entry_page:unknown`).
   */
  private async post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const raw = JSON.stringify(body ?? {});
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(raw),
        body: raw,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed: { error?: string } = {};
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          // non-JSON body — keep error tag from status code
        }
        throw new StagehandClientError(
          parsed.error ?? `stagehand_http_${res.status}`,
          parsed.error ?? `http_${res.status}`,
          res.status,
        );
      }
      // 2xx — JSON-parse the body. If it's not JSON the caller deals with the cast.
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof StagehandClientError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new StagehandClientError(`stagehand_timeout:${path}`, 'stagehand_timeout');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new StagehandClientError(`stagehand_network:${msg}`, 'stagehand_network');
    } finally {
      clearTimeout(t);
    }
  }

  /** Ensure a Maxance-logged-in session exists. Returns the cached + warmed login state. */
  async ensureLoggedIn(sessionName = 'maxance-default'): Promise<LoginResult> {
    return this.post<LoginResult>('/v1/maxance/login', { sessionName });
  }

  /** Drive a single trottinette quote. Dry-run by default — stops at price preview. */
  async runQuote(
    sessionName: string,
    params: StagehandQuoteParams,
    opts: { dryRun?: boolean; timeoutMs?: number } = {},
  ): Promise<QuotePreviewResult> {
    return this.post<QuotePreviewResult>(
      '/v1/maxance/quote',
      {
        sessionName,
        params,
        dryRun: opts.dryRun ?? true,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      },
      opts.timeoutMs,
    );
  }

  /** Resolve an outstanding SMS prompt. M8.T2 covers the manual flow this fronts. */
  async resolve2fa(sessionId: string, code: string): Promise<{ accepted: boolean }> {
    return this.post<{ accepted: boolean }>('/v1/maxance/2fa-code', { sessionId, code });
  }

  /** Liveness probe. Throws on non-200; used by the agent's onStart sanity check. */
  async health(): Promise<{ status: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new StagehandClientError(`stagehand_health_${res.status}`, `health_${res.status}`);
      }
      return (await res.json()) as { status: string };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ baseUrl: this.baseUrl, err: msg }, 'maxance-operator: stagehand health failed');
      throw new StagehandClientError(`stagehand_health_unreachable:${msg}`, 'health_unreachable');
    }
  }
}

/** Build the singleton client from env. Lazy so tests can override. */
let _default: StagehandClient | undefined;
export function getDefaultStagehandClient(): StagehandClient {
  if (_default) return _default;
  const baseUrl = process.env.STAGEHAND_BASE_URL ?? 'http://127.0.0.1:4001';
  const config: StagehandClientConfig = { baseUrl };
  if (process.env.STAGEHAND_HMAC_SECRET) {
    config.hmacSecret = process.env.STAGEHAND_HMAC_SECRET;
  }
  _default = new StagehandClient(config);
  return _default;
}

/** Test hook — wipe the singleton + inject a mock. */
export function __setStagehandClientForTests(c: StagehandClient | undefined): void {
  _default = c;
}
