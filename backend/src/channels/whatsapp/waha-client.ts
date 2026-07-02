/**
 * WAHA (WhatsApp HTTP API) thin HTTP client (M4.T2).
 *
 * Pure transport layer over WAHA's REST endpoints — no business logic, no
 * `ConversationChannel` implementation. The adapter (`./adapter.ts`) sits on
 * top of this client and translates F16 `ContentBlock`s into individual WAHA
 * send calls.
 *
 * Production: WAHA runs as a CLOUD instance with a connected number (env
 * `WAHA_BASE_URL` + `WAHA_API_KEY`, session `WAHA_SESSION` = 'default'). Tests
 * use a local Node `http.createServer` mock (see `tests/channels/whatsapp/`).
 *
 * PII protection: errors NEVER echo the request body (which can contain
 * phone numbers + message text). Response bodies are truncated to 200 chars.
 */
import { logger } from '../../logger.js';

/** Retry policy (M16) — match the Meta/HubSpot clients: 3 attempts, 1s/2s/4s. */
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1_000;

export interface WahaClientOptions {
  baseUrl: string;
  apiKey?: string;
  session?: string;
  /** Fetch implementation (Node 22 built-in default; pass in for tests). */
  fetchImpl?: typeof fetch;
  /** Override retry sleep — tests pass `() => Promise.resolve()` to skip waiting. */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface WahaSendTextInput {
  chatId: string; // e.g. "33612345678@c.us"
  text: string;
  replyTo?: string; // external message id to reply to
}

export interface WahaSendImageInput {
  chatId: string;
  /** Public URL WAHA fetches. Provide this OR `data` (base64). */
  url?: string;
  /** Base64-encoded image bytes (for local files WAHA can't fetch). */
  data?: string;
  /** MIME type when sending `data`. Default 'image/png'. */
  mimetype?: string;
  caption?: string;
  filename?: string;
}

export interface WahaSendDocumentInput {
  chatId: string;
  /** Public URL WAHA fetches. Provide this OR `data` (base64). */
  url?: string;
  /** Base64-encoded document bytes (for local files cloud WAHA can't fetch). */
  data?: string;
  /** MIME type when sending `data`. Default 'application/pdf'. */
  mimetype?: string;
  filename: string;
  caption?: string;
}

export interface WahaSendInteractiveInput {
  chatId: string;
  spec: Record<string, unknown>; // opaque WAHA payload (buttons, list, etc.)
}

export interface WahaSendResponse {
  id: { _serialized: string };
  ack?: number;
  timestamp?: number;
  // WAHA returns a full Message object; we only need id._serialized.
}

export interface WahaHealthResponse {
  status: 'STOPPED' | 'STARTING' | 'WORKING' | 'FAILED' | 'SCAN_QR_CODE';
}

export class WahaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly session: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: WahaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.session = opts.session ?? 'default';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep =
      opts.sleepMs ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * POST with retry (M16). A transient WAHA blip (network error, 429, or 5xx)
   * would otherwise silently drop a WhatsApp send — a human-action alert, a
   * customer reply, or a creative image. Retries 3× with exponential backoff;
   * 4xx other than 429 surface immediately (a bad request won't fix itself).
   * PII protection unchanged: the request body is NEVER echoed in errors.
   */
  private async request<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const payload = JSON.stringify(body);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: payload,
        });
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          const wait = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
          logger.warn(
            { path, attempt, err: err instanceof Error ? err.message : 'unknown' },
            'waha: network error, retrying',
          );
          await this.sleep(wait);
          continue;
        }
        throw err instanceof Error ? new Error(`WAHA ${path} network error: ${err.message}`) : err;
      }

      if (res.ok) return res.json() as Promise<T>;

      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const wait = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
        logger.warn({ path, status: res.status, attempt }, 'waha: retryable status, backing off');
        await this.sleep(wait);
        continue;
      }
      // PII protection: do NOT include the request body in error text — it may
      // contain phone numbers and conversation content. Only HTTP status +
      // short prefix of response body (which should not contain PII either).
      throw new Error(
        `WAHA ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      );
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`WAHA ${path} failed after ${MAX_ATTEMPTS} attempts`);
  }

  async sendText(input: WahaSendTextInput): Promise<WahaSendResponse> {
    return this.request<WahaSendResponse>('/api/sendText', {
      session: this.session,
      chatId: input.chatId,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    });
  }

  async sendImage(input: WahaSendImageInput): Promise<WahaSendResponse> {
    const file = input.data
      ? {
          mimetype: input.mimetype ?? 'image/png',
          filename: input.filename ?? 'image.png',
          data: input.data,
        }
      : { url: input.url, filename: input.filename };
    return this.request<WahaSendResponse>('/api/sendImage', {
      session: this.session,
      chatId: input.chatId,
      file,
      ...(input.caption ? { caption: input.caption } : {}),
    });
  }

  async sendDocument(input: WahaSendDocumentInput): Promise<WahaSendResponse> {
    // Same url-or-base64 duality as sendImage: cloud WAHA can't fetch local
    // paths, so callers with on-disk files (e.g. the devis-inbox relay) pass
    // base64 `data` + `mimetype` instead of a URL.
    const file = input.data
      ? {
          mimetype: input.mimetype ?? 'application/pdf',
          filename: input.filename,
          data: input.data,
        }
      : { url: input.url, filename: input.filename };
    return this.request<WahaSendResponse>('/api/sendFile', {
      session: this.session,
      chatId: input.chatId,
      file,
      ...(input.caption ? { caption: input.caption } : {}),
    });
  }

  /**
   * Generic interactive endpoint — WAHA exposes `/api/sendButtons`,
   * `/api/sendList`, etc. The caller chooses the path; we pass the rest of
   * the payload through unchanged.
   */
  async sendInteractive(
    input: WahaSendInteractiveInput,
    path = '/api/sendButtons',
  ): Promise<WahaSendResponse> {
    return this.request<WahaSendResponse>(path, {
      session: this.session,
      chatId: input.chatId,
      ...input.spec,
    });
  }

  /** Toggle WAHA's "typing" indicator on/off. Best-effort — failures logged, not thrown. */
  async setTyping(chatId: string, on: boolean): Promise<void> {
    try {
      await this.request<unknown>(on ? '/api/startTyping' : '/api/stopTyping', {
        session: this.session,
        chatId,
      });
    } catch (err) {
      logger.warn({ err, on }, 'waha: setTyping failed (non-fatal)');
    }
  }

  /** Session health probe. */
  async getSessionStatus(): Promise<WahaHealthResponse> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(this.session)}`,
      { method: 'GET', headers },
    );
    if (!res.ok) throw new Error(`WAHA session check failed: ${res.status}`);
    return res.json() as Promise<WahaHealthResponse>;
  }
}

/**
 * Helper: convert a F16 `ContactRef.address` (E.164 phone) to WAHA chatId.
 * WAHA uses `<digits>@c.us` for personal chats; `<groupId>@g.us` for groups.
 */
export function phoneToChatId(e164: string): string {
  const digits = e164.replace(/[^\d]/g, '');
  if (!digits) throw new Error(`Invalid phone for WAHA: ${e164}`);
  return `${digits}@c.us`;
}
