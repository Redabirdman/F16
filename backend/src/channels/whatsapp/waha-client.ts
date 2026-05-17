/**
 * WAHA (WhatsApp HTTP API) thin HTTP client (M4.T2).
 *
 * Pure transport layer over WAHA's REST endpoints — no business logic, no
 * `ConversationChannel` implementation. The adapter (`./adapter.ts`) sits on
 * top of this client and translates F16 `ContentBlock`s into individual WAHA
 * send calls.
 *
 * Production: WAHA runs on Ridaa's VPS (env `WAHA_BASE_URL`). Tests use a
 * local Node `http.createServer` mock (see `tests/channels/whatsapp/`).
 *
 * PII protection: errors NEVER echo the request body (which can contain
 * phone numbers + message text). Response bodies are truncated to 200 chars.
 */
import { logger } from '../../logger.js';

export interface WahaClientOptions {
  baseUrl: string;
  apiKey?: string;
  session?: string;
  /** Fetch implementation (Node 22 built-in default; pass in for tests). */
  fetchImpl?: typeof fetch;
}

export interface WahaSendTextInput {
  chatId: string; // e.g. "33612345678@c.us"
  text: string;
  replyTo?: string; // external message id to reply to
}

export interface WahaSendImageInput {
  chatId: string;
  url: string; // public URL or pre-signed; WAHA fetches
  caption?: string;
  filename?: string;
}

export interface WahaSendDocumentInput {
  chatId: string;
  url: string;
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

  constructor(opts: WahaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.session = opts.session ?? 'default';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // PII protection: do NOT include the request body in error text — it may
      // contain phone numbers and conversation content. Only HTTP status +
      // short prefix of response body (which should not contain PII either).
      throw new Error(
        `WAHA ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      );
    }
    return res.json() as Promise<T>;
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
    return this.request<WahaSendResponse>('/api/sendImage', {
      session: this.session,
      chatId: input.chatId,
      file: { url: input.url, filename: input.filename },
      ...(input.caption ? { caption: input.caption } : {}),
    });
  }

  async sendDocument(input: WahaSendDocumentInput): Promise<WahaSendResponse> {
    return this.request<WahaSendResponse>('/api/sendFile', {
      session: this.session,
      chatId: input.chatId,
      file: { url: input.url, filename: input.filename },
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
