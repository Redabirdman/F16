/**
 * OpenAI Realtime NATIVE SIP webhook (M10 V2).
 *
 * The voice pivot: instead of bridging telephony audio ourselves (the old
 * Pipecat + AudioSocket cascade), OpenAI is the SIP endpoint and handles ALL
 * media. A call routed to `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`
 * makes OpenAI fire a `realtime.call.incoming` webhook here; we accept it with
 * the French Assuryal session config, then drive the conversation over a
 * control WebSocket (greet first, function-calling back into our backend brain,
 * transcript capture). No codecs, no resampling, no audio bridge.
 *
 * Mounts `POST /v1/voice/openai-webhook`.
 *
 * Security: OpenAI signs webhooks with the Standard Webhooks spec
 * (https://www.standardwebhooks.com) — headers `webhook-id`,
 * `webhook-timestamp`, `webhook-signature`. We verify the HMAC over
 * `${id}.${timestamp}.${rawBody}` with the project webhook signing secret
 * (`whsec_…`) and reject stale timestamps (replay guard). Verification is
 * skipped only when no secret is configured (local dev).
 *
 * PII discipline: we never log the raw SIP `From`/`To` (caller numbers) or
 * transcripts at info level — only the call_id and event types. Transcript
 * deltas are logged at debug for live tuning and (phase 5) persisted server-side.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocket as WsClient } from 'ws';
import { logger } from '../logger.js';

const OPENAI_API = 'https://api.openai.com/v1';
const OPENAI_WS = 'wss://api.openai.com/v1/realtime';

/** Reject stale webhooks older than this (Standard Webhooks replay guard). */
const MAX_WEBHOOK_AGE_S = 300;

/**
 * French Assuryal sales persona for the voice channel. Kept concise and
 * spoken-style: short sentences, one question at a time, natural phone French.
 * Assuryal is the consumer brand the agent speaks as (see brand memory).
 */
const ASSURYAL_VOICE_INSTRUCTIONS = `Tu es l'assistante téléphonique d'Assuryal, un courtier en assurances en France.
Tu parles UNIQUEMENT en français, d'une voix chaleureuse, naturelle et professionnelle, au téléphone.
Ton rôle: accueillir l'appelant, comprendre son besoin d'assurance (par exemple assurance trottinette, scooter, moto), et le qualifier.
Style de parole OBLIGATOIRE: des phrases COURTES, parlées, comme une vraie conseillère. UNE seule question à la fois. Jamais de listes, jamais de longs paragraphes. Reste concise.
Commence par te présenter brièvement et demander en quoi tu peux aider.
Ne donne jamais de prix ferme ni de conseil réglementaire toi-même: si on te le demande, dis que tu fais établir un devis précis par un conseiller. Reste rassurante et efficace.`;

export interface OpenAiSipRouterOptions {
  /** OpenAI API key (Bearer for accept + control WS). Required to enable the route. */
  apiKey: string;
  /**
   * Standard-Webhooks signing secret (`whsec_…`) from the project's Webhooks
   * settings. When undefined the signature check is skipped (dev only).
   */
  webhookSecret?: string;
  /** Realtime model id. Defaults to `gpt-realtime`. */
  model?: string;
  /** Output voice. Defaults to `marin` (OpenAI recommends marin/cedar). */
  voice?: string;
  /** Persona instructions override. Defaults to the Assuryal French persona. */
  instructions?: string;
}

/**
 * Build the OpenAI Realtime SIP webhook router. Returns null when no API key is
 * configured so the caller can env-gate the mount (same discipline as the
 * Asterisk client) — a dev box without OpenAI creds simply doesn't expose it.
 */
export function buildOpenAiSipRouter(opts: OpenAiSipRouterOptions): Hono | null {
  if (!opts.apiKey) return null;

  const model = opts.model ?? 'gpt-realtime';
  const voice = opts.voice ?? 'marin';
  const instructions = opts.instructions ?? ASSURYAL_VOICE_INSTRUCTIONS;
  const app = new Hono();

  app.post('/v1/voice/openai-webhook', async (c) => {
    const rawBody = await c.req.text();

    // 1. Verify the Standard-Webhooks signature (unless no secret configured).
    if (opts.webhookSecret) {
      const id = c.req.header('webhook-id') ?? '';
      const ts = c.req.header('webhook-timestamp') ?? '';
      const sig = c.req.header('webhook-signature') ?? '';
      const verdict = verifyStandardWebhook(rawBody, id, ts, sig, opts.webhookSecret);
      if (verdict !== 'ok') {
        logger.warn({ verdict }, 'openai-sip: webhook signature rejected');
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }

    // 2. Parse the event. We only act on realtime.call.incoming; everything
    //    else is acknowledged 200 so OpenAI doesn't retry.
    let event: OpenAiWebhookEvent;
    try {
      event = JSON.parse(rawBody) as OpenAiWebhookEvent;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (event.type !== 'realtime.call.incoming') {
      logger.debug({ type: event.type }, 'openai-sip: ignoring non-call event');
      return c.json({ ok: true }, 200);
    }

    const callId = event.data?.call_id;
    if (!callId) {
      logger.warn({}, 'openai-sip: call.incoming without call_id');
      return c.json({ error: 'missing_call_id' }, 400);
    }
    logger.info({ callId }, 'openai-sip: incoming call → accepting');

    // 3. Accept the call with the session config. The body IS the realtime
    //    session object; for native SIP OpenAI negotiates the telephony codec
    //    itself, so we set NO audio formats — only voice, turn detection, and
    //    input transcription. server_vad keeps barge-in/turn-taking server-side
    //    (the exact thing our custom bridge struggled with).
    const sessionConfig = {
      type: 'realtime',
      model,
      instructions,
      audio: {
        output: { voice },
        input: {
          turn_detection: { type: 'server_vad' },
          transcription: { model: 'whisper-1', language: 'fr' },
        },
      },
    };

    try {
      const acceptRes = await fetch(`${OPENAI_API}/realtime/calls/${callId}/accept`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(sessionConfig),
      });
      if (!acceptRes.ok) {
        const body = await acceptRes.text();
        logger.error(
          { callId, status: acceptRes.status, body: body.slice(0, 400) },
          'openai-sip: accept failed',
        );
        // Tell OpenAI we handled the webhook; the call leg will drop on its own.
        return c.json({ ok: false }, 200);
      }
    } catch (err) {
      logger.error(
        { callId, err: err instanceof Error ? err.message : String(err) },
        'openai-sip: accept transport error',
      );
      return c.json({ ok: false }, 200);
    }

    // 4. Open the control WebSocket (fire-and-forget — the webhook response must
    //    return promptly while the call audio flows directly through OpenAI).
    openControlSocket(callId, opts.apiKey);

    return c.json({ ok: true }, 200);
  });

  return app;
}

/** Minimal shape of the events we read off the control WebSocket / webhook. */
interface OpenAiWebhookEvent {
  type: string;
  data?: { call_id?: string };
}

/**
 * Open the per-call control WebSocket: greet first, capture transcripts, and
 * (phase 5) dispatch function calls into the backend brain. Self-cleans on
 * close/error. Intentionally not awaited by the webhook handler.
 */
function openControlSocket(callId: string, apiKey: string): void {
  const ws = new WsClient(`${OPENAI_WS}?call_id=${encodeURIComponent(callId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  ws.on('open', () => {
    logger.info({ callId }, 'openai-sip: control WS open → greeting');
    // Make the assistant speak first: response.create with empty input and a
    // greeting instruction (the caller hears Assuryal before saying anything).
    ws.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          input: [],
          instructions:
            "Présente-toi brièvement comme l'assistante d'Assuryal et demande chaleureusement en quoi tu peux aider, en une phrase.",
        },
      }),
    );
  });

  ws.on('message', (raw: Buffer) => {
    let evt: { type?: string; transcript?: string };
    try {
      evt = JSON.parse(raw.toString()) as { type?: string; transcript?: string };
    } catch {
      return;
    }
    switch (evt.type) {
      case 'response.output_audio_transcript.done':
        // What Assuryal said (debug-only; PII-light but kept off info).
        logger.debug({ callId, said: evt.transcript }, 'openai-sip: bot transcript');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        logger.debug({ callId, heard: evt.transcript }, 'openai-sip: caller transcript');
        break;
      case 'error':
        logger.warn({ callId, evt }, 'openai-sip: realtime error event');
        break;
      default:
        break;
    }
  });

  ws.on('close', () => logger.info({ callId }, 'openai-sip: control WS closed'));
  ws.on('error', (err: Error) =>
    logger.warn({ callId, err: err.message }, 'openai-sip: control WS error'),
  );
}

/**
 * Verify a Standard-Webhooks signature. Returns `'ok'` or a short failure
 * reason (never throws). The signed content is `${id}.${timestamp}.${body}`;
 * the secret is `whsec_<base64>` and the HMAC key is the base64-decoded tail.
 * The `webhook-signature` header is a space-separated list of `v1,<b64sig>`
 * entries — any match passes. Timestamps older than MAX_WEBHOOK_AGE_S are
 * rejected to blunt replay.
 */
type WebhookVerdict = 'ok' | 'missing_headers' | 'stale' | 'no_match';
function verifyStandardWebhook(
  rawBody: string,
  id: string,
  timestamp: string,
  signatureHeader: string,
  secret: string,
): WebhookVerdict {
  if (!id || !timestamp || !signatureHeader) return 'missing_headers';

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return 'missing_headers';
  const ageS = Math.abs(Date.now() / 1000 - tsNum);
  if (ageS > MAX_WEBHOOK_AGE_S) return 'stale';

  const keyB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, 'base64');
  } catch {
    return 'no_match';
  }
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected);

  // Header: "v1,<sig> v1,<sig2>" — compare each candidate constant-time.
  for (const part of signatureHeader.split(' ')) {
    const candidate = part.includes(',') ? part.slice(part.indexOf(',') + 1) : part;
    const candBuf = Buffer.from(candidate);
    if (candBuf.length === expectedBuf.length && timingSafeEqual(candBuf, expectedBuf)) {
      return 'ok';
    }
  }
  return 'no_match';
}
