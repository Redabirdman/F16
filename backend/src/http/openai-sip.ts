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
 * Identity: when WE place the outbound call, Asterisk stamps a custom SIP
 * header `X-F16-Session: <sessionId>` on the INVITE (see the f16-openai-bridge
 * dialplan). OpenAI forwards SIP headers in the webhook payload, so we resolve
 * the lead/customer via the SAME Redis session-store the cascade uses
 * (`getSession`). When the header is absent/unresolved the call still runs;
 * persistence is simply skipped (best-effort, never blocks a live call).
 *
 * Brain stays server-side: the model is given ONE async tool,
 * `enregistrer_qualification`. When it fires, we run the logic IN this backend
 * (audit-log append now; lead/Maxance wiring later) and hand the result back
 * over the control WS so the model keeps talking — exactly the
 * "voice = ears+mouth, F16 backend = brain" split.
 *
 * Security: OpenAI signs webhooks with the Standard Webhooks spec
 * (headers `webhook-id`, `webhook-timestamp`, `webhook-signature`). We verify
 * the HMAC over `${id}.${timestamp}.${rawBody}` with the project webhook
 * signing secret (`whsec_…`) and reject stale timestamps. Skipped only when no
 * secret is configured (local dev).
 *
 * PII discipline: we never log SIP From/To (caller numbers) or transcripts at
 * info level — only the call_id + event types. Transcripts log at debug and are
 * persisted to conversation_turns (cleartext, same as every channel). The
 * qualification audit row carries only non-PII vehicle facts.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocket as WsClient } from 'ws';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { recordWsReconnect } from '../metrics/index.js';
import { getSession } from '../voice/session-store.js';
import { insertTurn } from '../db/repositories/conversation-turns.js';
import { appendAudit } from '../db/repositories/audit-log.js';
import { ASSURYAL_VOICE_INSTRUCTIONS, VOICE_PERSONA_KEY } from './voice-persona.js';
import { buildVoiceCallContext } from './voice-call-context.js';
import { resolvePrompt } from '../prompts/registry.js';
import { VOICE_TOOLS, VOICE_TRANSPORT_TOOLS, handleVoiceTool } from './voice-tools.js';
import { emitHubSpotActivity } from '../integrations/hubspot/activity-worker.js';

const OPENAI_API = 'https://api.openai.com/v1';
const OPENAI_WS = 'wss://api.openai.com/v1/realtime';

/** Reject stale webhooks older than this (Standard Webhooks replay guard). */
const MAX_WEBHOOK_AGE_S = 300;

/** Custom SIP header our outbound dialplan stamps with the F16 sessionId. */
const SESSION_SIP_HEADER = 'x-f16-session';

export interface OpenAiSipRouterOptions {
  /** Database handle — used for transcript persistence + the qualification audit row. */
  db: Database;
  /** OpenAI API key (Bearer for accept + control WS). Required to enable the route. */
  apiKey: string;
  /**
   * Standard-Webhooks signing secret (`whsec_…`). When undefined the signature
   * check is skipped (dev only).
   */
  webhookSecret?: string;
  /** Realtime model id. Defaults to `gpt-realtime`. */
  model?: string;
  /** Output voice. Defaults to `marin`. */
  voice?: string;
  /** Persona instructions override. Defaults to the Assuryal French persona. */
  instructions?: string;
}

/** Per-call state held while a call is live (keyed by the SIP call_id). */
interface CallContext {
  sipCallId: string;
  leadId?: string;
  customerId?: string;
  /** Epoch ms when we accepted the incoming call — used as call-start for duration. */
  connectedAt: number;
  /** Ordered transcript of the call, flushed to conversation_turns on close. */
  transcripts: Array<{ direction: 'inbound' | 'outbound'; content: string }>;
  /** Set before a deliberate hangup (terminer_appel) so close doesn't reconnect. */
  intentionalHangup?: boolean;
  /** Bounded control-WS reconnect attempts on unexpected drops (M16). */
  reconnectCount?: number;
  /** Guard so transcripts persist exactly once across reconnects. */
  persisted?: boolean;
}

/** Max control-WS reconnect attempts + base backoff before we give up + persist (M16). */
const MAX_WS_RECONNECTS = 3;
const WS_RECONNECT_BASE_MS = 500;

/**
 * Build the OpenAI Realtime SIP webhook router. Returns null when no API key is
 * configured so the caller can env-gate the mount.
 */
export function buildOpenAiSipRouter(opts: OpenAiSipRouterOptions): Hono | null {
  if (!opts.apiKey) return null;

  const model = opts.model ?? 'gpt-realtime';
  const voice = opts.voice ?? 'marin';
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

    // 2. Parse the event. Only realtime.call.incoming is actionable.
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

    // 3. Resolve the F16 lead/customer from our custom SIP header (best-effort).
    const ctx: CallContext = { sipCallId: callId, connectedAt: Date.now(), transcripts: [] };
    const sessionId = findSipHeader(event.data?.sip_headers, SESSION_SIP_HEADER);
    if (sessionId) {
      try {
        const session = await getSession(sessionId);
        if (session) {
          ctx.leadId = session.leadId;
          ctx.customerId = session.customerId;
        }
      } catch (err) {
        logger.warn(
          { callId, err: err instanceof Error ? err.message : String(err) },
          'openai-sip: session lookup failed (continuing without identity)',
        );
      }
    }
    logger.info(
      { callId, identified: Boolean(ctx.customerId) },
      'openai-sip: incoming call → accepting',
    );

    // 4. Accept with the session config (NO audio formats — SIP negotiates the
    //    codec). server_vad keeps barge-in/turn-taking server-side.
    //    M14.T6: resolve the (admin-editable) persona per-call.
    //    2026-07-10: identified calls get a per-call context block APPENDED
    //    (customer name, requested product, form facts, outbound framing) —
    //    the bot was greeting form-callback leads as cold inbound callers.
    let instructions =
      opts.instructions ??
      (await resolvePrompt(opts.db, VOICE_PERSONA_KEY, () => ASSURYAL_VOICE_INSTRUCTIONS));
    if (ctx.customerId) {
      instructions += await buildVoiceCallContext(opts.db, {
        customerId: ctx.customerId,
        leadId: ctx.leadId,
      });
    }
    const sessionConfig = {
      type: 'realtime',
      model,
      instructions,
      tools: VOICE_TOOLS,
      audio: {
        output: { voice },
        input: {
          // Wait ~1s of silence before responding so she doesn't talk over the
          // caller (default 500ms was cutting people off — Achraf feedback).
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 1000,
          },
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
        return c.json({ ok: false }, 200);
      }
    } catch (err) {
      logger.error(
        { callId, err: err instanceof Error ? err.message : String(err) },
        'openai-sip: accept transport error',
      );
      return c.json({ ok: false }, 200);
    }

    // 5. Open the control WS (fire-and-forget — the webhook must return promptly
    //    while the call audio flows directly through OpenAI).
    openControlSocket(ctx, opts.apiKey, opts.db);

    return c.json({ ok: true }, 200);
  });

  return app;
}

/** Minimal shape of the incoming webhook event. */
interface OpenAiWebhookEvent {
  type: string;
  data?: {
    call_id?: string;
    sip_headers?: Array<{ name?: string; value?: string }>;
  };
}

/** Case-insensitive lookup of a SIP header value from the webhook payload. */
function findSipHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === target && h.value) return h.value.trim();
  }
  return undefined;
}

/**
 * Open the per-call control WebSocket: greet first, capture transcripts,
 * dispatch the qualification tool into the backend, and persist transcripts on
 * close. Self-cleans. Intentionally not awaited by the webhook handler.
 */
function openControlSocket(ctx: CallContext, apiKey: string, db: Database, greet = true): void {
  const callId = ctx.sipCallId;
  const ws = new WsClient(`${OPENAI_WS}?call_id=${encodeURIComponent(callId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  ws.on('open', () => {
    if (!greet) {
      logger.info({ callId }, 'openai-sip: control WS reattached (no greeting)');
      return;
    }
    logger.info({ callId }, 'openai-sip: control WS open → greeting');
    // Trigger the model's FIRST turn with NO per-response instructions so the
    // opening comes solely from the session persona (avoids a duplicate /
    // conflicting greeting — the persona owns the exact opening line).
    ws.send(JSON.stringify({ type: 'response.create', response: { input: [] } }));
  });

  ws.on('message', (raw: Buffer) => {
    let evt: RealtimeEvent;
    try {
      evt = JSON.parse(raw.toString()) as RealtimeEvent;
    } catch {
      return;
    }
    switch (evt.type) {
      case 'response.output_audio_transcript.done':
        if (evt.transcript) {
          ctx.transcripts.push({ direction: 'outbound', content: evt.transcript });
          logger.debug({ callId, said: evt.transcript }, 'openai-sip: bot transcript');
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) {
          ctx.transcripts.push({ direction: 'inbound', content: evt.transcript });
          logger.debug({ callId, heard: evt.transcript }, 'openai-sip: caller transcript');
        }
        break;
      case 'response.function_call_arguments.done':
        // The model called our tool. Run it server-side, return the result,
        // then let the model continue. evt.call_id is the FUNCTION call id
        // (distinct from the SIP call_id) — it must echo back in the output.
        void handleFunctionCall(ws, db, ctx, evt, apiKey).catch((err: unknown) =>
          logger.warn(
            { callId, err: err instanceof Error ? err.message : String(err) },
            'openai-sip: function call handler threw',
          ),
        );
        break;
      case 'error':
        logger.warn({ callId, evt }, 'openai-sip: realtime error event');
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    // Unexpected drop (not a deliberate terminer_appel) → bounded reconnect with
    // exponential backoff so a transient blip doesn't kill a live call; OpenAI
    // holds the SIP leg meanwhile. If the call is actually over, each reconnect
    // WS just closes again → after MAX attempts we stop + persist.
    const attempts = ctx.reconnectCount ?? 0;
    if (!ctx.intentionalHangup && attempts < MAX_WS_RECONNECTS) {
      ctx.reconnectCount = attempts + 1;
      const delay = WS_RECONNECT_BASE_MS * 2 ** attempts;
      recordWsReconnect('openai_control');
      logger.warn(
        { callId, attempt: ctx.reconnectCount, max: MAX_WS_RECONNECTS, delay },
        'openai-sip: control WS dropped → reconnecting with backoff',
      );
      setTimeout(() => openControlSocket(ctx, apiKey, db, false), delay);
      return;
    }
    logger.info(
      { callId, turns: ctx.transcripts.length },
      'openai-sip: control WS closed → persisting transcripts',
    );
    void persistTranscripts(db, ctx).catch((err: unknown) =>
      logger.warn(
        { callId, err: err instanceof Error ? err.message : String(err) },
        'openai-sip: transcript persistence failed (non-blocking)',
      ),
    );
  });
  ws.on('error', (err: Error) =>
    logger.warn({ callId, err: err.message }, 'openai-sip: control WS error'),
  );
}

/** Events we read off the control WebSocket. */
interface RealtimeEvent {
  type: string;
  transcript?: string;
  /** Present on response.function_call_arguments.done. */
  call_id?: string;
  name?: string;
  arguments?: string;
}

/**
 * Run a model tool call inside our backend (brain stays server-side), then send
 * the result back over the WS and trigger the model to continue. Dispatch maps
 * each voice tool onto an existing builtin (knowledge.search / quote.request /
 * human.escalate / customer.read_profile); see voice-tools.ts. evt.call_id is
 * the FUNCTION call id (distinct from the SIP call_id) and must echo back.
 */
async function handleFunctionCall(
  ws: WsClient,
  db: Database,
  ctx: CallContext,
  evt: RealtimeEvent,
  apiKey: string,
): Promise<void> {
  const callId = ctx.sipCallId;
  if (!evt.name || !evt.call_id) {
    logger.warn({ callId, name: evt.name }, 'openai-sip: malformed function call — ignoring');
    return;
  }
  logger.info({ callId, tool: evt.name }, 'openai-sip: tool call');

  // Transport tools (hangup) are handled here — they need the call + API key,
  // not a backend builtin. terminer_appel: voicemail or graceful end-of-call.
  if (VOICE_TRANSPORT_TOOLS.has(evt.name)) {
    let reason = 'echange_termine';
    try {
      reason = (JSON.parse(evt.arguments ?? '{}') as { raison?: string }).raison ?? reason;
    } catch {
      /* keep default */
    }
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: evt.call_id,
          output: JSON.stringify({ statut: 'au_revoir' }),
        },
      }),
    );
    logger.info({ callId, reason }, 'openai-sip: terminer_appel → hanging up');
    ctx.intentionalHangup = true; // deliberate end → no reconnect on the close
    // Voicemail → hang up immediately; graceful end → let a one-line goodbye play.
    const delayMs = reason === 'messagerie_vocale' ? 250 : 3500;
    setTimeout(() => void hangupCall(callId, apiKey), delayMs);
    return;
  }

  const output = await handleVoiceTool(
    db,
    {
      sipCallId: callId,
      ...(ctx.leadId ? { leadId: ctx.leadId } : {}),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
    },
    evt.name,
    evt.arguments,
  );

  // Return the function result, then let the model keep talking.
  ws.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: evt.call_id, output },
    }),
  );
  ws.send(JSON.stringify({ type: 'response.create' }));
}

/** Hang up an OpenAI realtime SIP call (voicemail detected or call finished). */
async function hangupCall(callId: string, apiKey: string): Promise<void> {
  try {
    await fetch(`${OPENAI_API}/realtime/calls/${callId}/hangup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    logger.warn(
      { callId, err: err instanceof Error ? err.message : String(err) },
      'openai-sip: hangup failed',
    );
  }
}

/**
 * Persist the call transcript to conversation_turns so dump-thread.ts surfaces
 * the call in the lead thread. Requires a resolved customer (the FK); without
 * identity we keep an audit summary instead and skip the turns. occurredAt is
 * monotonically nudged so the ordering survives equal-millisecond inserts.
 */
async function persistTranscripts(db: Database, ctx: CallContext): Promise<void> {
  if (ctx.persisted) return; // run once across reconnects
  ctx.persisted = true;
  if (ctx.transcripts.length === 0) return;

  if (!ctx.customerId) {
    // No identity → can't FK conversation_turns. Keep a forensic summary.
    await appendAudit(db, {
      actorType: 'system',
      actorId: 'voice-openai-sip',
      action: 'voice.transcript.unlinked',
      targetType: 'call',
      targetId: ctx.sipCallId,
      meta: { callId: ctx.sipCallId, turns: ctx.transcripts.length },
    });
    logger.info(
      { callId: ctx.sipCallId },
      'openai-sip: transcript not linked to a lead (no session identity)',
    );
    return;
  }

  const base = Date.now();
  for (const [i, t] of ctx.transcripts.entries()) {
    await insertTurn(db, {
      customerId: ctx.customerId,
      leadId: ctx.leadId ?? null,
      channel: 'voice',
      direction: t.direction,
      content: t.content,
      occurredAt: new Date(base + i),
      ...(t.direction === 'outbound'
        ? { agentRole: 'sales-agent', agentInstance: `voice-${ctx.sipCallId}` }
        : {}),
    });
  }
  logger.info(
    { callId: ctx.sipCallId, turns: ctx.transcripts.length },
    'openai-sip: transcripts persisted',
  );

  // Phase 3: emit HubSpot call engagement (gated — no-op unless F16_HUBSPOT_ACTIVITIES=true).
  // Build a brief transcript summary from the outbound turns (no raw PII in logs).
  try {
    const summaryLines = ctx.transcripts
      .filter((t) => t.direction === 'outbound')
      .slice(0, 5)
      .map((t) => t.content)
      .join(' / ');
    const transcriptSummary = summaryLines.slice(0, 500) || 'Appel vocal Assuryal';
    // Real call duration = now − accept time (ctx.connectedAt), NOT `base` which
    // is set right before the insert loop and would measure insert time (~0ms).
    const durationMs = ctx.transcripts.length > 0 ? Date.now() - ctx.connectedAt : undefined;
    await emitHubSpotActivity(db, {
      customerId: ctx.customerId,
      ...(ctx.leadId !== undefined ? { leadId: ctx.leadId } : {}),
      activity: {
        kind: 'voice-call-ended',
        customerId: ctx.customerId,
        ...(ctx.leadId !== undefined ? { leadId: ctx.leadId } : {}),
        transcriptSummary,
        ...(durationMs !== undefined ? { durationMs } : {}),
        timestamp: new Date(base),
      },
    });
  } catch {
    // never block transcript persistence on HubSpot emit
  }

  // Admin costs: audit the call end with its duration so voice minutes are
  // queryable server-side (the HubSpot engagement is not). Best-effort.
  try {
    const durationMs = Date.now() - ctx.connectedAt;
    await appendAudit(db, {
      actorType: 'system',
      actorId: 'openai-sip',
      action: 'voice.call.ended',
      ...(ctx.leadId !== undefined
        ? { targetType: 'lead', targetId: ctx.leadId }
        : { targetType: 'customer', targetId: ctx.customerId }),
      meta: { durationMs, turns: ctx.transcripts.length },
    });
  } catch {
    // never block transcript persistence on an audit blip
  }
}

/**
 * Verify a Standard-Webhooks signature. Returns `'ok'` or a short failure
 * reason (never throws). Signed content is `${id}.${timestamp}.${body}`; the
 * secret is `whsec_<base64>` and the HMAC key is the base64-decoded tail. The
 * `webhook-signature` header is a space-separated list of `v1,<b64sig>` entries
 * — any match passes. Timestamps older than MAX_WEBHOOK_AGE_S are rejected.
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

  for (const part of signatureHeader.split(' ')) {
    const candidate = part.includes(',') ? part.slice(part.indexOf(',') + 1) : part;
    const candBuf = Buffer.from(candidate);
    if (candBuf.length === expectedBuf.length && timingSafeEqual(candBuf, expectedBuf)) {
      return 'ok';
    }
  }
  return 'no_match';
}
