/**
 * Jambonz REST client (M10) — outbound-call origination.
 *
 * Single responsibility: POST jambonz `createCall` so jambonz dials the
 * customer over the OVH SIP trunk and, on answer, fetches our call-control
 * webhook (`call_hook`). The webhook (src/http/jambonz-call-hook.ts) returns a
 * `listen` verb that bridges the call's audio bidirectionally to the Pipecat
 * voice WebSocket.
 *
 * Doc sources (fetched 2026-06-04):
 *   - createCall REST: https://docs.jambonz.org/reference/rest-call-control/calls/create-call
 *       POST https://{baseUrl}/v1/Accounts/{AccountSid}/Calls
 *       Authorization: Bearer <api key>
 *       body: { from, to:{type,number,trunk}, call_hook:{url,method},
 *               call_status_hook?, tag, ... } → 201 { sid }
 *   - call_hook is fetched by jambonz when it needs call-control instructions
 *     (on answer for an outbound call); the `tag` object set here is echoed
 *     back to the webhook as `customerData`, and any query-string on the
 *     call_hook URL is preserved. We pass the per-call metadata BOTH ways
 *     (tag + query) so the webhook can read it whichever path jambonz uses.
 *
 * PII discipline: `to` is a phone number (PII). We NEVER log it — call logs
 * carry only the callId + sessionId + the jambonz call sid.
 *
 * The HTTP client is injectable (`fetchImpl`) so tests assert the exact POST
 * shape + auth header without a live jambonz server.
 */
import { logger } from '../logger.js';

/** Minimal fetch surface we depend on — lets tests inject a stub. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  status: number;
  ok: boolean;
  text: () => Promise<string>;
}>;

export interface JambonzClientConfig {
  /** e.g. `https://jambonz.example.com` (no trailing slash, no /v1). */
  baseUrl: string;
  /** Jambonz API key — sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Jambonz account SID — path segment in the createCall URL. */
  accountSid: string;
  /** OVH carrier/trunk name as provisioned in jambonz (`to.trunk`). */
  sipTrunk: string;
  /** Pipecat voice WS URL the answered call is bridged to (ws://host:port/voice/ws). */
  voiceWsUrl: string;
  /** The outbound caller-ID / DID we present (E.164, e.g. +33184162750). */
  outboundFrom: string;
  /**
   * Public base URL jambonz uses to reach OUR call-hook webhook, e.g.
   * `https://api.f16.example.com`. The client appends the call-hook path +
   * per-call query string. Required so jambonz can fetch the webhook.
   */
  callHookBaseUrl: string;
  /**
   * Shared secret embedded in the call-hook URL path token (the webhook can't
   * HMAC like our other routes — jambonz won't sign the body). Must match the
   * token the webhook route is mounted under. See jambonz-call-hook.ts.
   */
  callHookToken: string;
  /** Injectable HTTP client (defaults to global fetch). */
  fetchImpl?: FetchLike;
}

/** Per-call metadata threaded through jambonz back to the webhook + Pipecat. */
export interface CallMetadata {
  sessionId: string;
  /** F16 lead id (UUID). Maps to Pipecat's `leadId`. */
  leadId: string;
  customerId: string;
  /** F16 voice call id (UUID) — correlates VOICE.* intents + audit. */
  callId: string;
}

export interface OriginateCallInput {
  /** Destination phone number, E.164 (PII — never logged). */
  to: string;
  /** Per-call metadata passed to the webhook (tag) + the WS (query). */
  metadata: CallMetadata;
  /** Override the caller-ID for this call (defaults to config.outboundFrom). */
  from?: string;
}

export interface OriginateCallResult {
  /** Jambonz call SID returned by createCall (201 body `sid`). */
  callSid: string;
}

/** Build the absolute call-hook URL with the path token + per-call query. */
export function buildCallHookUrl(cfg: JambonzClientConfig, meta: CallMetadata): string {
  const base = cfg.callHookBaseUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams({
    sessionId: meta.sessionId,
    leadId: meta.leadId,
    customerId: meta.customerId,
    callId: meta.callId,
  }).toString();
  // Token lives in the path so a bare GET/POST without it 404s — see route.
  return `${base}/v1/voice/jambonz/call-hook/${encodeURIComponent(cfg.callHookToken)}?${qs}`;
}

export class JambonzClient {
  private readonly cfg: JambonzClientConfig;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: JambonzClientConfig) {
    if (!cfg.baseUrl) throw new Error('JambonzClient: baseUrl required');
    if (!cfg.apiKey) throw new Error('JambonzClient: apiKey required');
    if (!cfg.accountSid) throw new Error('JambonzClient: accountSid required');
    if (!cfg.sipTrunk) throw new Error('JambonzClient: sipTrunk required');
    if (!cfg.voiceWsUrl) throw new Error('JambonzClient: voiceWsUrl required');
    if (!cfg.outboundFrom) throw new Error('JambonzClient: outboundFrom required');
    if (!cfg.callHookBaseUrl) throw new Error('JambonzClient: callHookBaseUrl required');
    if (!cfg.callHookToken) throw new Error('JambonzClient: callHookToken required');
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * Originate an outbound call. Jambonz dials `to` over the OVH trunk and,
   * on answer, fetches our `call_hook` (which returns the bridge-to-Pipecat
   * `listen` verb). Returns the jambonz call SID.
   *
   * Throws on a non-2xx response or a body without `sid` — the caller
   * (voice-operator) maps that to VOICE.CALL_FAILED.
   */
  async originateCall(input: OriginateCallInput): Promise<OriginateCallResult> {
    const from = input.from ?? this.cfg.outboundFrom;
    const callHookUrl = buildCallHookUrl(this.cfg, input.metadata);

    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/v1/Accounts/${this.cfg.accountSid}/Calls`;
    const body = {
      from,
      to: {
        type: 'phone' as const,
        number: input.to,
        trunk: this.cfg.sipTrunk,
      },
      call_hook: {
        url: callHookUrl,
        method: 'POST' as const,
      },
      // Echoed back to the webhook as `customerData` + handed to the WS in the
      // initial text frame. Belt-and-suspenders with the URL query string.
      tag: {
        sessionId: input.metadata.sessionId,
        leadId: input.metadata.leadId,
        customerId: input.metadata.customerId,
        callId: input.metadata.callId,
      },
    };

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure — never include `to` (PII) in the error.
      logger.error(
        {
          callId: input.metadata.callId,
          sessionId: input.metadata.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'jambonz: createCall transport error',
      );
      throw new Error('jambonz_create_call_transport_error');
    }

    const text = await res.text();
    if (!res.ok || res.status >= 300) {
      logger.error(
        {
          callId: input.metadata.callId,
          sessionId: input.metadata.sessionId,
          status: res.status,
          // Body may include the dialed number jambonz echoes — do NOT log it.
        },
        'jambonz: createCall non-2xx',
      );
      throw new Error(`jambonz_create_call_failed_${res.status}`);
    }

    let parsed: { sid?: string };
    try {
      parsed = JSON.parse(text) as { sid?: string };
    } catch {
      throw new Error('jambonz_create_call_bad_json');
    }
    if (!parsed.sid) {
      throw new Error('jambonz_create_call_no_sid');
    }

    logger.info(
      {
        callId: input.metadata.callId,
        sessionId: input.metadata.sessionId,
        jambonzCallSid: parsed.sid,
      },
      'jambonz: outbound call originated',
    );
    return { callSid: parsed.sid };
  }

  /** Expose config (read-only) so the call-hook route can build the listen verb. */
  get voiceWsUrl(): string {
    return this.cfg.voiceWsUrl;
  }
}

/**
 * Build a JambonzClient from process.env. Returns null when the required env
 * is incomplete — the voice-operator treats that as "voice origination
 * disabled" (same env-gate discipline as the maxance-operator), so a dev box
 * without jambonz config doesn't crash on a stray VOICE.CALL_SCHEDULED.
 */
export function jambonzClientFromEnv(fetchImpl?: FetchLike): JambonzClient | null {
  const baseUrl = process.env.JAMBONZ_BASE_URL;
  const apiKey = process.env.JAMBONZ_API_KEY;
  const accountSid = process.env.JAMBONZ_ACCOUNT_SID;
  const sipTrunk = process.env.JAMBONZ_SIP_TRUNK;
  const voiceWsUrl = process.env.VOICE_WS_URL;
  const outboundFrom = process.env.VOICE_OUTBOUND_FROM;
  const callHookBaseUrl = process.env.VOICE_CALL_HOOK_BASE_URL;
  const callHookToken = process.env.VOICE_CALL_HOOK_TOKEN;

  if (
    !baseUrl ||
    !apiKey ||
    !accountSid ||
    !sipTrunk ||
    !voiceWsUrl ||
    !outboundFrom ||
    !callHookBaseUrl ||
    !callHookToken
  ) {
    return null;
  }

  return new JambonzClient({
    baseUrl,
    apiKey,
    accountSid,
    sipTrunk,
    voiceWsUrl,
    outboundFrom,
    callHookBaseUrl,
    callHookToken,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
