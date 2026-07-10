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
  /**
   * When true, the voice-operator originates via the OpenAI Realtime NATIVE SIP
   * bridge (`originateNativeSip`) instead of the Pipecat/AudioSocket cascade
   * (`originateCall`). Default false → cascade. Env: `F16_VOICE_NATIVE_SIP`.
   */
  nativeSip?: boolean;
  /** Dialplan context for the native-SIP bridge. Defaults to `f16-openai-bridge`. */
  openAiContext?: string;
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

/**
 * Transport-agnostic origination surface the voice-operator depends on. Two
 * implementations: ARI-over-HTTP (`AsteriskAriClient`) and a NETWORK-INDEPENDENT
 * CLI transport (`AsteriskCliClient`, via `wsl.exe asterisk -rx`). The CLI one
 * is preferred on this host because the backend ⇄ WSL-Asterisk link has no
 * reachable IP (the FSE bridged switch shares the host IP) and must survive
 * Wi-Fi / network / machine changes — process-exec depends on no network.
 */
export interface VoiceOriginator {
  readonly nativeSip: boolean;
  originateCall(input: OriginateCallInput): Promise<OriginateCallResult>;
  originateNativeSip(input: OriginateCallInput): Promise<OriginateCallResult>;
}

export class AsteriskAriClient implements VoiceOriginator {
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
      nativeSip: cfg.nativeSip ?? false,
      openAiContext: cfg.openAiContext ?? 'f16-openai-bridge',
    };
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.authHeader =
      'Basic ' + Buffer.from(`${cfg.ariUser}:${cfg.ariPassword}`).toString('base64');
  }

  /** True when this client originates via the OpenAI native-SIP bridge. */
  get nativeSip(): boolean {
    return this.cfg.nativeSip;
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
      endpoint: `PJSIP/${formatOvhDest(input.to)}@${this.cfg.trunk}`,
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

    return this.sendOriginate(url, body, input.sessionId);
  }

  /**
   * Originate via the OpenAI Realtime NATIVE SIP bridge. Asterisk dials `to`
   * over the OVH trunk and, on answer, the `f16-openai-bridge` dialplan bridges
   * the leg to OpenAI's SIP endpoint (OpenAI handles all media). The per-call
   * lead identity travels as the `X-F16-Session` SIP header, stamped by the
   * dialplan from the channel's `AS_UUID` (master-channel) with the Asterisk
   * global `F16SESSION` as fallback — so we set that global here first.
   *
   * Same failure contract as originateCall (tagged errors → VOICE.CALL_FAILED).
   */
  async originateNativeSip(input: OriginateCallInput): Promise<OriginateCallResult> {
    if (!input.to) throw new Error('asterisk_originate_missing_to');
    if (!input.sessionId) throw new Error('asterisk_originate_missing_session');

    // 1. Set the global the bridge dialplan stamps onto the OpenAI INVITE
    //    (fallback; the bridge prefers the per-call MASTER_CHANNEL(AS_UUID)).
    const gvUrl = `${this.cfg.ariUrl}/asterisk/variable?variable=F16SESSION&value=${encodeURIComponent(input.sessionId)}`;
    try {
      const gv = await this.fetchImpl(gvUrl, {
        method: 'POST',
        headers: { authorization: this.authHeader, 'content-type': 'application/json' },
        body: '',
      });
      if (!gv.ok || gv.status >= 300) {
        logger.error(
          { sessionId: input.sessionId, status: gv.status },
          'asterisk: set F16SESSION global non-2xx',
        );
        throw new Error(`asterisk_setglobal_failed_${gv.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('asterisk_setglobal_failed_')) throw err;
      logger.error(
        { sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
        'asterisk: set F16SESSION global transport error',
      );
      throw new Error('asterisk_setglobal_transport_error');
    }

    // 2. Originate into the OpenAI bridge context (no AudioSocket vars needed).
    const url = `${this.cfg.ariUrl}/channels`;
    const body = {
      endpoint: `PJSIP/${formatOvhDest(input.to)}@${this.cfg.trunk}`,
      extension: 's',
      context: this.cfg.openAiContext,
      priority: 1,
      callerId: this.cfg.callerId,
      timeout: this.cfg.timeout,
      variables: { AS_UUID: input.sessionId },
    };
    return this.sendOriginate(url, body, input.sessionId);
  }

  /** Shared POST /channels → parse channel id. Tagged errors, PII-safe logs. */
  private async sendOriginate(
    url: string,
    body: unknown,
    sessionId: string,
  ): Promise<OriginateCallResult> {
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
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'asterisk: ARI originate transport error',
      );
      throw new Error('asterisk_originate_transport_error');
    }

    const text = await res.text();
    if (!res.ok || res.status >= 300) {
      // Body may echo the endpoint (PII) — do NOT log it.
      logger.error({ sessionId, status: res.status }, 'asterisk: ARI originate non-2xx');
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

    logger.info({ sessionId, channelId: parsed.id }, 'asterisk: outbound call originated');
    return { channelId: parsed.id };
  }
}

/**
 * Runs an Asterisk CLI command and returns stdout. Default impl shells out to
 * `wsl.exe -d <distro> -u root asterisk -rx "<cmd>"` via execFile (NO shell, so
 * args can't be injection vectors). Injectable for tests.
 */
export type AsteriskRunner = (cmd: string) => Promise<string>;

const E164_RE = /^\+?[0-9]{6,15}$/;
const UUID_RE = /^[0-9a-fA-F-]{8,40}$/;

/**
 * Normalise a destination to the OVH trunk's expected dial string: international
 * `00<countrycode><number>`. The DB stores bare E.164 (`212650012403`) or `+`
 * form (`+212650012403`); OVH rejects both (no route → 0 calls) and needs the
 * `00` prefix (e.g. `00212650012403`). Idempotent: already-`00` stays as-is.
 */
export function formatOvhDest(e164: string): string {
  const digits = e164.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return `00${digits.slice(1)}`;
  if (digits.startsWith('00')) return digits;
  return `00${digits}`;
}

/**
 * Network-independent Asterisk transport (Option B, M16/M17 hardening). Drives
 * Asterisk through `wsl.exe asterisk -rx` instead of ARI-over-HTTP, so backend ⇄
 * Asterisk needs NO IP/network and survives Wi-Fi/hotspot/machine changes.
 * Implements only the native-SIP path (the V1 voice path); the legacy
 * Pipecat/AudioSocket cascade still requires ARI (it sets per-channel vars).
 */
export class AsteriskCliClient implements VoiceOriginator {
  private readonly trunk: string;
  private readonly openAiContext: string;
  private readonly run: AsteriskRunner;
  private readonly verifyDelaysMs: number[];
  readonly nativeSip = true;

  constructor(cfg: {
    trunk: string;
    openAiContext?: string;
    distro?: string;
    timeoutMs?: number;
    runner?: AsteriskRunner;
    /** Post-originate channel-verification poll delays (test seam). */
    verifyDelaysMs?: number[];
  }) {
    if (!cfg.trunk) throw new Error('AsteriskCliClient: trunk required');
    this.trunk = cfg.trunk;
    this.openAiContext = cfg.openAiContext ?? 'f16-openai-bridge';
    this.verifyDelaysMs = cfg.verifyDelaysMs ?? [800, 1200, 1600];
    const distro = cfg.distro ?? process.env.WSL_DISTRO ?? 'Ubuntu';
    const timeoutMs = cfg.timeoutMs ?? 15_000;
    this.run =
      cfg.runner ??
      (async (cmd: string): Promise<string> => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const pexec = promisify(execFile);
        const { stdout, stderr } = await pexec(
          'wsl.exe',
          ['-d', distro, '-u', 'root', 'asterisk', '-rx', cmd],
          { timeout: timeoutMs, windowsHide: true },
        );
        return `${stdout}\n${stderr}`;
      });
  }

  async originateNativeSip(input: OriginateCallInput): Promise<OriginateCallResult> {
    if (!input.to || !E164_RE.test(input.to)) throw new Error('asterisk_originate_missing_to');
    if (!input.sessionId || !UUID_RE.test(input.sessionId)) {
      throw new Error('asterisk_originate_missing_session');
    }

    // 1. Set the global the bridge dialplan stamps onto the OpenAI INVITE
    //    (fallback for MASTER_CHANNEL(AS_UUID)).
    try {
      await this.run(`dialplan set global F16SESSION ${input.sessionId}`);
    } catch (err) {
      logger.error(
        { sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
        'asterisk-cli: set F16SESSION global failed',
      );
      throw new Error('asterisk_setglobal_transport_error');
    }

    // 2. Originate into the OpenAI bridge context. `to`/endpoint embeds PII —
    //    never logged. CLI gives no channel id, so we synthesize a stable one.
    let out: string;
    try {
      out = await this.run(
        `channel originate PJSIP/${formatOvhDest(input.to)}@${this.trunk} extension s@${this.openAiContext}`,
      );
    } catch (err) {
      logger.error(
        { sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
        'asterisk-cli: originate transport error',
      );
      throw new Error('asterisk_originate_transport_error');
    }
    if (/unable|no such|invalid|error/i.test(out)) {
      logger.error({ sessionId: input.sessionId }, 'asterisk-cli: originate rejected');
      throw new Error('asterisk_originate_rejected');
    }

    // 3. VERIFY a channel actually exists (2026-07-10): `channel originate`
    //    prints NOTHING and exits 0 even when the dial fails outright (bad
    //    number, trunk rejects) — a sim lead's call died silently and the
    //    backend still logged "originated". The trunk leg appears in the
    //    channel list within ms of a real dial and stays there through the
    //    whole ring, so a few short polls separate "dialing" from "no-op".
    //    A concurrent call's channel can mask a failure — acceptable: calls
    //    are rare and serialized in practice, and false-success was the
    //    status quo for EVERY call before this check.
    let channelSeen = false;
    for (const delayMs of this.verifyDelaysMs) {
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const channels = await this.run('core show channels concise');
        if (channels.includes(`PJSIP/${this.trunk}-`)) {
          channelSeen = true;
          break;
        }
      } catch {
        // Transient CLI hiccup — keep polling; the last miss decides.
      }
    }
    if (!channelSeen) {
      // The channel list may embed dialed digits — log only the sessionId.
      logger.error(
        { sessionId: input.sessionId },
        'asterisk-cli: originate produced no channel — dial rejected (bad/unroutable number?)',
      );
      throw new Error('asterisk_originate_no_channel');
    }

    const channelId = `cli-${input.sessionId}`;
    logger.info(
      { sessionId: input.sessionId, channelId },
      'asterisk-cli: outbound call originated',
    );
    return { channelId };
  }

  /** Cascade (Pipecat/AudioSocket) needs per-channel vars → use ARI, not CLI. */
  async originateCall(): Promise<OriginateCallResult> {
    throw new Error('asterisk_cli_cascade_unsupported');
  }
}

/**
 * Build a VoiceOriginator from process.env. Returns null when the required
 * env is incomplete — the voice-operator treats that as "voice origination
 * disabled" (same env-gate discipline as the maxance-operator), so a dev box
 * without Asterisk config doesn't crash on a stray VOICE.CALL_SCHEDULED.
 *
 * Transport is chosen by `F16_ASTERISK_TRANSPORT` (cli | ari, default cli on
 * this host): `cli` = network-independent wsl.exe exec (preferred); `ari` =
 * legacy HTTP (needs a reachable ARI URL). The cascade path always needs `ari`.
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
 *   F16_VOICE_NATIVE_SIP    ('1'/'true' → OpenAI native-SIP bridge; default ON)
 *   ASTERISK_OPENAI_CONTEXT (default f16-openai-bridge)
 */
export function asteriskClientFromEnv(fetchImpl?: FetchLike): VoiceOriginator | null {
  const trunk = process.env.ASTERISK_OVH_TRUNK;
  const openAiContext = process.env.ASTERISK_OPENAI_CONTEXT ?? 'f16-openai-bridge';
  // Native SIP is the V1 voice path; default ON unless explicitly disabled.
  const nativeSipEnv = (process.env.F16_VOICE_NATIVE_SIP ?? '1').toLowerCase();
  const nativeSip = nativeSipEnv === '1' || nativeSipEnv === 'true';
  // Transport: CLI (network-independent) is the default; ARI is legacy/cascade.
  const transport = (process.env.F16_ASTERISK_TRANSPORT ?? 'cli').toLowerCase();

  // CLI transport (preferred): network-independent native-SIP origination. Only
  // needs the trunk; caller-ID + media are owned by the bridge dialplan/trunk.
  if (transport === 'cli' && nativeSip) {
    if (!trunk) return null;
    return new AsteriskCliClient({ trunk, openAiContext });
  }

  // ARI transport (legacy / cascade): needs the full HTTP config.
  const ariUrl = process.env.ASTERISK_ARI_URL ?? 'http://localhost:8088/ari';
  const ariUser = process.env.ASTERISK_ARI_USER ?? 'f16';
  const ariPassword = process.env.ASTERISK_ARI_PASSWORD;
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
    nativeSip,
    openAiContext,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
