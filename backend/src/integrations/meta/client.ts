/**
 * Meta Graph API client (M12).
 *
 * Thin server-to-server wrapper over the Facebook Graph API, authenticated
 * with a long-lived **System User token** (not the interactive Ads MCP — that
 * lives in a Claude session and can't run unattended). Speaks JSON, knows
 * nothing about BullMQ / drizzle / lead semantics — those live in the
 * leadgen webhook + the ads-manager agent.
 *
 * Auth:
 *   - `Authorization: Bearer <token>` on every call.
 *   - When `appSecret` is supplied we also send `appsecret_proof`
 *     (HMAC-SHA256 of the token keyed by the app secret) — Meta's
 *     recommended hardening for server-side calls. Computed per-token so
 *     page-token calls (webhook subscription) sign correctly.
 *
 * PII discipline:
 *   - `getLeadgenData` RETURNS PII by design (the prospect's name/phone/email
 *     live in `field_data`) — callers encrypt it via the customers repo. This
 *     client NEVER logs a response body. Only method + path + status surface.
 *   - On error we surface `status + a ≤200-char prefix of Graph's error JSON`,
 *     which carries codes/types, not user values.
 *
 * Retry:
 *   - HTTP 5xx + 429, and Graph throttling error codes (1, 2, 4, 17, 32, 341,
 *     613), are retried 3× with exponential backoff (1s, 2s, 4s).
 *   - Other 4xx (e.g. 190 invalid token, 100 bad field) surface immediately so
 *     the caller can react (re-auth, drop the field).
 */
import { createHmac } from 'node:crypto';
import { logger } from '../../logger.js';

const DEFAULT_BASE_URL = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v21.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1_000;
const ERROR_BODY_PREFIX_LEN = 200;

/** Graph throttling / transient error codes worth retrying. */
const RETRYABLE_ERROR_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

export interface MetaGraphClientOptions {
  /** Long-lived System User token (ads_management, ads_read, leads_retrieval, pages scopes). */
  accessToken: string;
  /** App secret — enables `appsecret_proof`. Strongly recommended in prod. */
  appSecret?: string;
  /** Graph API version, e.g. 'v21.0'. */
  apiVersion?: string;
  /** Default https://graph.facebook.com — overridden for the test stub. */
  baseUrl?: string;
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override retry sleep — tests pass () => Promise.resolve(). */
  sleepMs?: (ms: number) => Promise<void>;
}

/** One answer on a Meta instant form (`field_data[]`). */
export interface LeadgenFieldEntry {
  name: string;
  values: string[];
}

/** Normalized shape of a `GET /{leadgen_id}` response. */
export interface LeadgenData {
  id: string;
  createdTime: string | null;
  fieldData: LeadgenFieldEntry[];
  adId: string | null;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  formId: string | null;
  platform: string | null;
  /** Full untouched payload for audit (still PII — never log it). */
  raw: Record<string, unknown>;
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/**
 * Custom error — carries Graph's status + code/subcode + a PII-safe body
 * prefix so callers can branch (e.g. 190 = token expired → re-auth).
 */
export class MetaApiError extends Error {
  readonly status: number;
  readonly bodyPrefix: string;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;

  constructor(opts: {
    method: string;
    path: string;
    status: number;
    body: string;
    code?: number | null;
    subcode?: number | null;
    type?: string | null;
  }) {
    const prefix = opts.body.slice(0, ERROR_BODY_PREFIX_LEN);
    super(`Meta ${opts.method} ${opts.path} -> ${opts.status}: ${prefix}`);
    this.name = 'MetaApiError';
    this.status = opts.status;
    this.bodyPrefix = prefix;
    this.code = opts.code ?? null;
    this.subcode = opts.subcode ?? null;
    this.type = opts.type ?? null;
  }
}

export class MetaGraphClient {
  private readonly token: string;
  private readonly appSecret: string | null;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: MetaGraphClientOptions) {
    if (!opts.accessToken) {
      throw new Error('MetaGraphClient: accessToken is required');
    }
    this.token = opts.accessToken;
    this.appSecret = opts.appSecret ?? null;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep =
      opts.sleepMs ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Fetch + normalize a single lead submission by its `leadgen_id` (the value
   * the leadgen webhook delivers). Returns the field answers plus the full
   * attribution chain (campaign/adset/ad/form ids + names).
   */
  async getLeadgenData(leadgenId: string): Promise<LeadgenData> {
    if (!leadgenId) throw new Error('getLeadgenData: leadgenId is required');
    const json = await this.get<Record<string, unknown>>(`/${encodeURIComponent(leadgenId)}`, {
      fields:
        'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,field_data',
    });

    const rawFieldData = Array.isArray(json.field_data) ? json.field_data : [];
    const fieldData: LeadgenFieldEntry[] = rawFieldData.map((f) => {
      const entry = (f ?? {}) as { name?: unknown; values?: unknown };
      return {
        name: typeof entry.name === 'string' ? entry.name : '',
        values: Array.isArray(entry.values) ? entry.values.map((v) => String(v)) : [],
      };
    });

    return {
      id: String(json.id ?? leadgenId),
      createdTime: asStringOrNull(json.created_time),
      fieldData,
      adId: asStringOrNull(json.ad_id),
      adName: asStringOrNull(json.ad_name),
      adsetId: asStringOrNull(json.adset_id),
      adsetName: asStringOrNull(json.adset_name),
      campaignId: asStringOrNull(json.campaign_id),
      campaignName: asStringOrNull(json.campaign_name),
      formId: asStringOrNull(json.form_id),
      platform: asStringOrNull(json.platform),
      raw: json,
    };
  }

  /**
   * Resolve a Page access token from the System User token (the System User
   * must have the Page assigned + `pages_show_list`/`pages_read_engagement`).
   * Needed to subscribe the Page to the leadgen webhook.
   */
  async getPageAccessToken(pageId: string): Promise<string> {
    const json = await this.get<{ access_token?: string }>(`/${encodeURIComponent(pageId)}`, {
      fields: 'access_token',
    });
    if (!json.access_token) {
      throw new Error(`getPageAccessToken: no access_token returned for page ${pageId}`);
    }
    return json.access_token;
  }

  /**
   * Subscribe the F16 app to the Page's `leadgen` webhook field. Idempotent on
   * Meta's side — re-subscribing the same field is a no-op success. Uses the
   * Page token (signed with its own appsecret_proof).
   */
  async subscribePageToLeadgen(pageId: string): Promise<{ success: boolean }> {
    const pageToken = await this.getPageAccessToken(pageId);
    const json = await this.post<{ success?: boolean }>(
      `/${encodeURIComponent(pageId)}/subscribed_apps`,
      { subscribed_fields: 'leadgen' },
      pageToken,
    );
    return { success: Boolean(json.success) };
  }

  /**
   * Cheap token/health probe — `GET /me`. Returns `{healthy:true}` on any 2xx,
   * `{healthy:false, detail}` otherwise (expired token, network error, …).
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const me = await this.get<{ id?: string; name?: string }>('/me', { fields: 'id,name' });
      return me.id ? { healthy: true } : { healthy: false, detail: 'no id in /me response' };
    } catch (err) {
      const detail = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
      return { healthy: false, detail };
    }
  }

  // ---------------------------------------------------------------------------
  // Generic verbs
  // ---------------------------------------------------------------------------

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    return this.request<T>('GET', path, query, null, undefined);
  }

  /** POST with form-encoded params (Graph's native write format). */
  async post<T>(
    path: string,
    params: Record<string, string> = {},
    tokenOverride?: string,
  ): Promise<T> {
    return this.request<T>('POST', path, {}, params, tokenOverride);
  }

  /** DELETE an object by path (e.g. `/{campaign-id}`). Used for launch rollback. */
  async del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path, {}, null, undefined);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Record<string, string>,
    formParams: Record<string, string> | null,
    tokenOverride: string | undefined,
  ): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.rawRequest(method, path, query, formParams, tokenOverride);
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          const wait = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
          logger.warn(
            { method, path, attempt, err: err instanceof Error ? err.message : 'unknown' },
            'meta: network error, retrying',
          );
          await this.sleep(wait);
          continue;
        }
        throw err instanceof Error
          ? new Error(`Meta ${method} ${path} network error: ${err.message}`)
          : new Error(`Meta ${method} ${path} network error`);
      }

      if (res.status >= 200 && res.status < 300) {
        const text = await res.text();
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return {} as T;
        }
      }

      // Decide retryability from BOTH the HTTP status and Graph's error code.
      const errBodyText = await this.safeReadText(res);
      const parsed = this.tryParseErrorBody(errBodyText);
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        (parsed.code !== null && RETRYABLE_ERROR_CODES.has(parsed.code));

      if (retryable && attempt < MAX_ATTEMPTS) {
        const wait = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
        logger.warn(
          { method, path, status: res.status, code: parsed.code, attempt },
          'meta: retryable error, backing off',
        );
        await this.sleep(wait);
        continue;
      }

      throw new MetaApiError({
        method,
        path,
        status: res.status,
        body: errBodyText,
        code: parsed.code,
        subcode: parsed.subcode,
        type: parsed.type,
      });
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Meta ${method} ${path} failed after ${MAX_ATTEMPTS} attempts`);
  }

  private async rawRequest(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Record<string, string>,
    formParams: Record<string, string> | null,
    tokenOverride: string | undefined,
  ): Promise<Response> {
    const token = tokenOverride ?? this.token;
    const url = new URL(`${this.baseUrl}/${this.apiVersion}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (this.appSecret) {
      url.searchParams.set('appsecret_proof', this.appSecretProof(token));
    }

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };
    if (method === 'POST' && formParams) {
      const body = new URLSearchParams(formParams);
      init.body = body;
      init.headers = {
        ...init.headers,
        'content-type': 'application/x-www-form-urlencoded',
      };
    }
    return this.fetchImpl(url.toString(), init);
  }

  /** HMAC-SHA256(token) keyed by the app secret, hex — Meta's appsecret_proof. */
  private appSecretProof(token: string): string {
    // Guarded by the caller (only set the param when appSecret is present).
    return createHmac('sha256', this.appSecret as string)
      .update(token)
      .digest('hex');
  }

  private async safeReadText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }

  private tryParseErrorBody(text: string): {
    code: number | null;
    subcode: number | null;
    type: string | null;
  } {
    if (!text) return { code: null, subcode: null, type: null };
    let parsed: GraphErrorBody | null = null;
    try {
      parsed = JSON.parse(text) as GraphErrorBody;
    } catch {
      return { code: null, subcode: null, type: null };
    }
    const e = parsed.error ?? {};
    return {
      code: typeof e.code === 'number' ? e.code : null,
      subcode: typeof e.error_subcode === 'number' ? e.error_subcode : null,
      type: typeof e.type === 'string' ? e.type : null,
    };
  }
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
