/**
 * Asterisk ARI client (voice origination) — replaces the old jambonz REST
 * client. Single responsibility: POST the ARI `/channels` endpoint so Asterisk
 * dials the customer over the OVH SIP (PJSIP) trunk. On answer, Asterisk's
 * `f16-dial` dialplan bridges the call's audio to `AudioSocket(<AS_UUID>, host:port)`
 * — our Pipecat side. AS_UUID = our F16 sessionId, so Pipecat can look the
 * session up (see src/http/session-lookup.ts) once it has the AudioSocket UUID.
 *
 * Why no call-control webhook (unlike jambonz): with Asterisk the dialplan
 * (context `f16-dial`) owns call control entirely. We only originate; there is
 * nothing to fetch back. The session metadata Pipecat needs is resolved via the
 * session-lookup HTTP route keyed by the AudioSocket UUID.
 *
 * ARI contract (build to this exactly):
 *   POST {ASTERISK_ARI_URL}/channels
 *   Authorization: Basic base64(user:password)
 *   body: {
 *     endpoint: "PJSIP/<E164>@<trunk>",
 *     extension: "<E164>",
 *     context: "<dialplanContext>",   // f16-dial
 *     priority: 1,
 *     callerId: "<callerId>",         // +33184162750
 *     timeout: 30,
 *     variables: { AS_UUID:<sessionId>, PIPECAT_HOST:<host>, PIPECAT_PORT:<port> }
 *   }
 *   → 200/2xx channel object { id, ... }
 *
 * PII discipline: `to` is a phone number (PII). We NEVER log it in full — logs
 * carry only the sessionId + the returned channelId; the endpoint string (which
 * embeds the number) is never logged.
 *
 * The HTTP client is injectable (`fetchImpl`) so tests assert the exact POST
 * shape + Basic auth header without a live Asterisk.
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

export interface AsteriskAriConfig {
  /** ARI base URL incl. the /ari path, e.g. `http://localhost:8088/ari` (no trailing slash). */
  ariUrl: string;
  /** ARI username for HTTP Basic auth (e.g. `f16`). */
  ariUser: string;
  /** ARI password for HTTP Basic auth. */
  ariPassword: string;
  /** PJSIP trunk name as provisioned in Asterisk (e.g. `ovh-trunk`). */
  trunk: string;
  /** Dialplan context the originated channel enters (e.g. `f16-dial`). */
  dialplanContext: string;
  /** Outbound caller-ID / DID presented to the callee (E.164, e.g. +33184162750). */
  callerId: string;
  /** AudioSocket host Asterisk streams the answered call's audio to (Pipecat). */
  audioSocketHost: string;
  /** AudioSocket port (numeric string in env; sent as a string ARI variable). */
  audioSocketPort: string;
  /** Dial timeout in seconds before Asterisk gives up. Defaults to 30. */
  timeout?: number;
  /** Injectable HTTP client (defaults to global fetch). */
  fetchImpl?: FetchLike;
}

export interface OriginateCallInput {
  /** Destination phone number, E.164 (PII — never logged in full). */
  to: string;
  /**
   * F16 sessionId — passed to Asterisk as the `AS_UUID` channel variable, which
   * the dialplan hands to AudioSocket. This is what Pipecat reads back as the
   * AudioSocket UUID and uses to call the session-lookup route.
   */
  sessionId: string;
}

export interface OriginateCallResult {
  /** ARI channel id returned by POST /channels (the channel object's `id`). */
  channelId: string;
}

export class AsteriskAriClient {
  private readonly cfg: Required<Omit<AsteriskAriConfig, 'fetchImpl'>>;
  private readonly fetchImpl: FetchLike;
  private readonly authHeader: string;

  constructor(cfg: AsteriskAriConfig) {
    if (!cfg.ariUrl) throw new Error('AsteriskAriClient: ariUrl required');
    if (!cfg.ariUser) throw new Error('AsteriskAriClient: ariUser required');
    if (!cfg.ariPassword) throw new Error('AsteriskAriClient: ariPassword required');
    if (!cfg.trunk) throw new Error('AsteriskAriClient: trunk required');
    if (!cfg.dialplanContext) throw new Error('AsteriskAriClient: dialplanContext required');
    if (!cfg.callerId) throw new Error('AsteriskAriClient: callerId required');
    if (!cfg.audioSocketHost) throw new Error('AsteriskAriClient: audioSocketHost required');
    if (!cfg.audioSocketPort) throw new Error('AsteriskAriClient: audioSocketPort required');

    this.cfg = {
      ariUrl: cfg.ariUrl.replace(/\/+$/, ''),
      ariUser: cfg.ariUser,
      ariPassword: cfg.ariPassword,
      trunk: cfg.trunk,
      dialplanContext: cfg.dialplanContext,
      callerId: cfg.callerId,
      audioSocketHost: cfg.audioSocketHost,
      audioSocketPort: cfg.audioSocketPort,
      timeout: cfg.timeout ?? 30,
    };
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.authHeader =
      'Basic ' + Buffer.from(`${cfg.ariUser}:${cfg.ariPassword}`).toString('base64');
  }

  /**
   * Originate an outbound call. Asterisk dials `to` over the PJSIP trunk and,
   * on answer, runs the `f16-dial` dialplan which bridges audio to AudioSocket
   * (keyed by AS_UUID = sessionId) → Pipecat. Returns the ARI channel id.
   *
   * Throws a tagged error on a non-2xx response or a body without an `id` — the
   * caller (voice-operator) maps that to VOICE.CALL_FAILED.
   */
  async originateCall(input: OriginateCallInput): Promise<OriginateCallResult> {
    if (!input.to) throw new Error('asterisk_originate_missing_to');
    if (!input.sessionId) throw new Error('asterisk_originate_missing_session');

    const url = `${this.cfg.ariUrl}/channels`;
    const body = {
      endpoint: `PJSIP/${input.to}@${this.cfg.trunk}`,
      extension: input.to,
      context: this.cfg.dialplanContext,
      priority: 1,
      callerId: this.cfg.callerId,
      timeout: this.cfg.timeout,
      variables: {
        AS_UUID: input.sessionId,
        PIPECAT_HOST: this.cfg.audioSocketHost,
        PIPECAT_PORT: this.cfg.audioSocketPort,
      },
    };

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: this.authHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure — never include `to`/endpoint (PII) in the error.
      logger.error(
        {
          sessionId: input.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'asterisk: ARI originate transport error',
      );
      throw new Error('asterisk_originate_transport_error');
    }

    const text = await res.text();
    if (!res.ok || res.status >= 300) {
      // Body may echo the endpoint (PII) — do NOT log it.
      logger.error(
        { sessionId: input.sessionId, status: res.status },
        'asterisk: ARI originate non-2xx',
      );
      throw new Error(`asterisk_originate_failed_${res.status}`);
    }

    let parsed: { id?: string };
    try {
      parsed = JSON.parse(text) as { id?: string };
    } catch {
      throw new Error('asterisk_originate_bad_json');
    }
    if (!parsed.id) {
      throw new Error('asterisk_originate_no_channel_id');
    }

    logger.info(
      { sessionId: input.sessionId, channelId: parsed.id },
      'asterisk: outbound call originated',
    );
    return { channelId: parsed.id };
  }
}

/**
 * Build an AsteriskAriClient from process.env. Returns null when the required
 * env is incomplete — the voice-operator treats that as "voice origination
 * disabled" (same env-gate discipline as the maxance-operator), so a dev box
 * without Asterisk config doesn't crash on a stray VOICE.CALL_SCHEDULED.
 *
 * Env:
 *   ASTERISK_ARI_URL        (default http://localhost:8088/ari)
 *   ASTERISK_ARI_USER       (default f16)
 *   ASTERISK_ARI_PASSWORD   (required)
 *   ASTERISK_OVH_TRUNK      (e.g. ovh-trunk)
 *   ASTERISK_DIALPLAN_CONTEXT (e.g. f16-dial)
 *   VOICE_CALLER_ID         (e.g. +33184162750)
 *   AUDIOSOCKET_HOST        (default 127.0.0.1)
 *   AUDIOSOCKET_PORT        (default 9092)
 */
export function asteriskClientFromEnv(fetchImpl?: FetchLike): AsteriskAriClient | null {
  const ariUrl = process.env.ASTERISK_ARI_URL ?? 'http://localhost:8088/ari';
  const ariUser = process.env.ASTERISK_ARI_USER ?? 'f16';
  const ariPassword = process.env.ASTERISK_ARI_PASSWORD;
  const trunk = process.env.ASTERISK_OVH_TRUNK;
  const dialplanContext = process.env.ASTERISK_DIALPLAN_CONTEXT;
  const callerId = process.env.VOICE_CALLER_ID;
  const audioSocketHost = process.env.AUDIOSOCKET_HOST ?? '127.0.0.1';
  const audioSocketPort = process.env.AUDIOSOCKET_PORT ?? '9092';

  // ariUrl/ariUser/host/port all have safe defaults. The truly required,
  // no-default values are the password + trunk + context + callerId.
  if (!ariPassword || !trunk || !dialplanContext || !callerId) {
    return null;
  }

  return new AsteriskAriClient({
    ariUrl,
    ariUser,
    ariPassword,
    trunk,
    dialplanContext,
    callerId,
    audioSocketHost,
    audioSocketPort,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
