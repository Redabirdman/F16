/**
 * android-sms-gateway HTTP client (M4.T5).
 *
 * Thin transport over the open-source android-sms-gateway server
 * (https://github.com/capcom6/android-sms-gateway), which runs on an Android
 * phone holding the SIM card and exposes a REST API over the LAN/VPN. F16
 * uses SMS as the V1 last-resort fallback when WhatsApp, voice, and email
 * have all failed (§8); this client carries no business logic — it just
 * POSTs/GETs to `/3rdparty/v1/messages`.
 *
 * Production: gateway runs on Ridaa's office phone, reachable through the VPS
 * over Tailscale. Tests use a local `http.createServer` mock (see
 * `tests/channels/sms/`).
 *
 * PII discipline (§9): errors NEVER echo the request body (which contains
 * phone numbers and message text). Response bodies are truncated to 200 chars.
 * The phone number is never logged — only HTTP status + short response prefix.
 */
import { logger } from '../../logger.js';

export interface SmsGatewayClientOptions {
  /** Base URL of the gateway, e.g. `http://192.168.1.10:8080`. */
  baseUrl: string;
  /** HTTP Basic Auth username configured on the gateway. */
  username: string;
  /** HTTP Basic Auth password configured on the gateway. */
  password: string;
  /** Optional SIM slot (0 or 1); defaults to 0 — the gateway picks slot 0 if omitted. */
  simNumber?: number;
  /** Fetch implementation (Node 22 built-in default; pass in for tests). */
  fetchImpl?: typeof fetch;
}

export interface SmsGatewaySendInput {
  /** E.164 phone, e.g. `+33612345678`. Formatting is stripped client-side. */
  phoneNumber: string;
  /** SMS text body. Sender is responsible for any length policy. */
  message: string;
}

/** Gateway message lifecycle states. */
export type SmsMessageState = 'Pending' | 'Processed' | 'Sent' | 'Delivered' | 'Failed';

export interface SmsGatewayRecipient {
  phoneNumber: string;
  state: SmsMessageState;
  error?: string;
}

export interface SmsGatewaySendResponse {
  id: string;
  state: SmsMessageState;
  recipients?: SmsGatewayRecipient[];
}

export interface SmsGatewayStatusResponse {
  id: string;
  state: SmsMessageState;
  recipients: SmsGatewayRecipient[];
}

export class SmsGatewayClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly simNumber: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SmsGatewayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Basic Auth header is precomputed once — credentials never appear in logs.
    const token = Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${token}`;
    this.simNumber = opts.simNumber ?? 0;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendMessage(input: SmsGatewaySendInput): Promise<SmsGatewaySendResponse> {
    const normalized = normalizePhone(input.phoneNumber);
    const payload = {
      message: input.message,
      phoneNumbers: [normalized],
      simNumber: this.simNumber,
    };

    const res = await this.fetchImpl(`${this.baseUrl}/3rdparty/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.authHeader,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // PII protection: NEVER include the phone or message text in the error.
      // Only HTTP status + response prefix (which the gateway controls).
      throw new Error(
        `sms-gateway POST /3rdparty/v1/messages failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      );
    }

    return (await res.json()) as SmsGatewaySendResponse;
  }

  async getMessageStatus(id: string): Promise<SmsGatewayStatusResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/3rdparty/v1/messages/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: { authorization: this.authHeader },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `sms-gateway GET /3rdparty/v1/messages/<id> failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      );
    }
    return (await res.json()) as SmsGatewayStatusResponse;
  }

  /**
   * Probes the gateway for readiness. The gateway's root endpoint and the
   * messages endpoint both respond to GET, so a 2xx/4xx (anything that
   * proves the TCP socket + HTTP stack is up) counts as healthy. Connection
   * refused / DNS / timeout → unhealthy with the underlying message.
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/3rdparty/v1/messages`, {
        method: 'GET',
        headers: { authorization: this.authHeader },
      });
      // Any HTTP response means the gateway is reachable; auth errors (401)
      // are still a sign of life. Only a 5xx indicates the gateway itself
      // is unhappy, and we don't want to flap on a transient list call —
      // treat <500 as healthy, >=500 as not.
      if (res.status >= 500) {
        return { healthy: false, detail: `HTTP ${res.status}` };
      }
      return { healthy: true, detail: `HTTP ${res.status}` };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ err: detail }, 'sms-gateway: healthCheck failed');
      return { healthy: false, detail };
    }
  }
}

/**
 * Normalize a phone string to `+digits` form (E.164 minus whitespace and
 * punctuation). Mirrors `phoneToChatId`'s normalization for consistency.
 *
 * Examples:
 *   '+33 6 12 34 56 78'   → '+33612345678'
 *   '+1 (555) 010-0000'   → '+15550100000'
 *   '33612345678'         → '+33612345678'  (assumes E.164; adds '+')
 *
 * Throws if the input has no digits.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) throw new Error(`Invalid phone for sms-gateway: ${raw}`);
  // android-sms-gateway expects E.164 with leading '+'. If the caller already
  // passed digits without '+', add it; if they passed '+', it's already stripped.
  return `+${digits}`;
}
