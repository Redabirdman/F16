/**
 * Jambonz call-control webhook (M10).
 *
 * Mounts `POST /v1/voice/jambonz/call-hook/:token` — jambonz fetches this when
 * an outbound (REST-originated) call is answered and needs call-control
 * instructions. We return a one-verb jambonz application that bridges the
 * call's audio bidirectionally to the Pipecat voice WebSocket (VOICE_WS_URL),
 * passing the per-call metadata {sessionId, leadId, customerId, callId} so
 * Pipecat can attach the call to the right F16 lead/session.
 *
 * The verb is `listen` with bidirectionalAudio — the canonical jambonz verb
 * for streaming PCM audio to (and receiving it back from) a websocket AI agent.
 * Doc: https://docs.jambonz.org/verbs/verbs/listen
 *   {
 *     verb: "listen",
 *     url: "<VOICE_WS_URL>",
 *     mixType: "mono",
 *     sampleRate: 16000,
 *     bidirectionalAudio: { enabled: true, streaming: true, sampleRate: 16000 },
 *     metadata: { sessionId, leadId, customerId, callId }
 *   }
 * jambonz delivers `metadata` (merged with the call attributes) in the first
 * text frame on the websocket, which is exactly what the Pipecat side expects.
 *
 * SECURITY — why not HMAC:
 *   Our other webhooks (lead intake, voice/turn) HMAC the raw body with a
 *   shared secret. jambonz does NOT sign its call-hook body, so HMAC isn't
 *   available here. We instead gate on a SHARED SECRET PATH TOKEN: the route
 *   is mounted at `/call-hook/:token` and the createCall client builds the
 *   call_hook URL with that exact token (VOICE_CALL_HOOK_TOKEN). A request
 *   whose `:token` doesn't match (constant-time compare) gets a 404 — we hide
 *   the route's existence rather than 401. This is a bearer-in-URL scheme;
 *   it's acceptable because (a) jambonz↔backend is server-to-server over TLS,
 *   (b) the URL is never exposed to the customer, and (c) the token is
 *   rotatable via env. A future hardening is an IP allowlist of the jambonz
 *   egress (documented as TODO(live) below — needs the prod jambonz IP).
 *
 * The metadata is read from the URL query string (set by the createCall
 * client) with the `tag`/`customerData` jambonz echoes in the POST body as a
 * fallback. Query is authoritative because it's part of the token-gated URL.
 */
import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../logger.js';

/** Audio sample rate for the Pipecat bridge (Hz). 16k = good STT quality. */
const SAMPLE_RATE = 16000;

const MetaSchema = z.object({
  sessionId: z.string().min(1),
  leadId: z.string().uuid(),
  customerId: z.string().uuid(),
  callId: z.string().uuid(),
});
type CallHookMeta = z.infer<typeof MetaSchema>;

export interface JambonzCallHookOptions {
  /** Pipecat voice WS URL the call audio is bridged to. */
  voiceWsUrl: string;
  /**
   * Shared path-token gate. When set, requests must hit
   * `/call-hook/<token>`; a mismatch 404s. When undefined the route still
   * mounts but the token check is skipped — dev only, mirrors the HMAC-optional
   * pattern of the voice/turn router.
   */
  callHookToken?: string;
}

/** Constant-time string compare that won't throw on length mismatch. */
function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Build the jambonz `listen` application array that bridges the call to
 * Pipecat. Exported for direct unit assertion in tests.
 */
export function buildListenApp(voiceWsUrl: string, meta: CallHookMeta): unknown[] {
  return [
    {
      verb: 'listen',
      url: voiceWsUrl,
      mixType: 'mono',
      sampleRate: SAMPLE_RATE,
      bidirectionalAudio: {
        enabled: true,
        streaming: true,
        sampleRate: SAMPLE_RATE,
      },
      metadata: {
        sessionId: meta.sessionId,
        leadId: meta.leadId,
        customerId: meta.customerId,
        callId: meta.callId,
      },
    },
  ];
}

export function buildJambonzCallHookRouter(opts: JambonzCallHookOptions): Hono {
  const app = new Hono();

  // jambonz POSTs (method we configured on the call_hook). We also accept GET
  // defensively because some jambonz deployments probe the hook with GET.
  const handler = async (c: Context): Promise<Response> => {
    // 1. Token gate (path segment). 404 on mismatch — never reveal the route.
    if (opts.callHookToken) {
      const provided = c.req.param('token') ?? '';
      if (!tokensMatch(provided, opts.callHookToken)) {
        logger.warn({}, 'jambonz call-hook: token mismatch → 404');
        return c.json({ error: 'not_found' }, 404);
      }
    }

    // 2. Resolve metadata: query string first (part of the token-gated URL),
    //    falling back to the `tag`/`customerData` jambonz echoes in the body.
    let raw: Record<string, unknown> = {
      sessionId: c.req.query('sessionId'),
      leadId: c.req.query('leadId'),
      customerId: c.req.query('customerId'),
      callId: c.req.query('callId'),
    };
    if (!raw.sessionId || !raw.leadId || !raw.customerId || !raw.callId) {
      try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const tag = (body.customerData ?? body.tag) as Record<string, unknown> | undefined;
        if (tag) {
          raw = {
            sessionId: raw.sessionId ?? tag.sessionId,
            leadId: raw.leadId ?? tag.leadId,
            customerId: raw.customerId ?? tag.customerId,
            callId: raw.callId ?? tag.callId,
          };
        }
      } catch {
        // No/invalid body — fall through to validation, which 400s cleanly.
      }
    }

    const parsed = MetaSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({}, 'jambonz call-hook: missing/invalid call metadata → 400');
      return c.json({ error: 'invalid_metadata' }, 400);
    }

    logger.info(
      {
        sessionId: parsed.data.sessionId,
        callId: parsed.data.callId,
        // leadId/customerId are UUIDs (not PII) — safe to log for correlation.
        leadId: parsed.data.leadId,
        customerId: parsed.data.customerId,
      },
      'jambonz call-hook: bridging answered call to Pipecat WS',
    );

    return c.json(buildListenApp(opts.voiceWsUrl, parsed.data), 200);
  };

  app.post('/v1/voice/jambonz/call-hook/:token', handler);
  app.get('/v1/voice/jambonz/call-hook/:token', handler);

  return app;
}
