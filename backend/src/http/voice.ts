/**
 * Voice turn HTTP transport (M10).
 *
 * Mounts `POST /v1/voice/turn` — the synchronous request→reply seam the voice
 * stack (Pipecat) calls once per caller utterance. Unlike WhatsApp/email/SMS
 * (event-driven via BullMQ), the caller is waiting on the phone line, so this
 * route runs the SAME Sales Agent brain synchronously via `generateSalesReply`
 * and returns the reply TEXT for Pipecat to speak.
 *
 * Security: protected service-to-service with the SAME shared webhook secret
 * (HMAC-SHA256 over the raw body) as `POST /v1/leads`. Pipecat signs its POST;
 * this route is NOT behind the admin bearer.
 *
 * Layered defenses (cheapest first):
 *   1. HMAC verification — same SHA-256 + `timingSafeEqual` pattern as the
 *      lead intake webhook. Skipped only when `hmacSecret` is undefined (dev).
 *   2. Zod schema validation — parses the body BEFORE invoking the agent.
 *
 * PII discipline: error responses are static French strings; we never echo the
 * transcript or raw body into a 4xx/5xx response, and logs carry only the
 * sessionId + an error stub (never the transcript).
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { generateSalesReply } from '../agents/sales-agent/reply-core.js';
import { insertTurn } from '../db/repositories/conversation-turns.js';

/** Reply spoken when compliance blocks the draft — caller is being escalated. */
const ESCALATED_REPLY =
  'Je préfère vérifier ce point avec un conseiller, je vous fais rappeler très vite.';
/** Reply spoken on a soft skip / internal error — ask the caller to repeat. */
const REPEAT_REPLY = 'Pardon, pouvez-vous répéter ?';

export const VoiceTurnPayloadSchema = z.object({
  sessionId: z.string().min(1),
  leadId: z.string().uuid(),
  customerId: z.string().uuid(),
  transcript: z.string().min(1).max(2000),
});

export type VoiceTurnPayload = z.infer<typeof VoiceTurnPayloadSchema>;

export interface VoiceRouterOptions {
  db: Database;
  /**
   * Required in production. When undefined the route still mounts but the
   * HMAC check is skipped — convenient for local testing without the shared
   * secret. Same semantics as the lead intake router.
   */
  hmacSecret?: string;
}

export function buildVoiceRouter(opts: VoiceRouterOptions): Hono {
  const app = new Hono();

  app.post('/v1/voice/turn', async (c) => {
    // Read the raw body ONCE — the HMAC is computed over the exact bytes the
    // sender signed, which JSON.parse + JSON.stringify cannot reconstruct.
    const rawBody = await c.req.text();

    // 1. HMAC verification (skipped when no secret is configured).
    if (opts.hmacSecret) {
      const sig = c.req.header('x-f16-signature') ?? '';
      if (!verifyHmac(rawBody, sig, opts.hmacSecret)) {
        logger.warn({}, 'voice turn: HMAC verification failed');
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }

    // 2. JSON parse + zod validation. A bad JSON body or shape mismatch is a
    //    hard 400 — we log just the error type, not the body (PII).
    let parsed: VoiceTurnPayload;
    try {
      parsed = VoiceTurnPayloadSchema.parse(JSON.parse(rawBody));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'parse error' },
        'voice turn: invalid payload',
      );
      return c.json({ error: 'invalid_payload' }, 400);
    }

    // 3. Run the shared Sales reply core synchronously. The voice channel reuses
    //    the EXACT brain WhatsApp uses — same prompt, tools, compliance.
    try {
      const reply = await generateSalesReply({
        db: opts.db,
        leadId: parsed.leadId,
        channel: 'voice',
        content: parsed.transcript,
        agentRole: 'sales-agent',
        agentInstance: `voice-${parsed.sessionId}`,
      });

      let replyText: string;
      let sessionState: 'live' | 'escalated';
      switch (reply.outcome) {
        case 'reply':
          replyText = reply.replyText;
          sessionState = 'live';
          break;
        case 'blocked':
          // Compliance already created the human action + emitted
          // COMPLIANCE.BLOCKED inside generateSalesReply. We tell the caller a
          // conseiller will follow up and mark the session escalated.
          logger.warn(
            { sessionId: parsed.sessionId, humanActionId: reply.humanActionId },
            'voice turn: compliance blocked → escalating session',
          );
          replyText = ESCALATED_REPLY;
          sessionState = 'escalated';
          break;
        case 'skip':
        case 'error':
          // Soft no-op or guard tripped — ask the caller to repeat rather than
          // dropping the line. The session stays live.
          logger.warn(
            {
              sessionId: parsed.sessionId,
              outcome: reply.outcome,
              detail: reply.outcome === 'skip' ? reply.reason : reply.error,
            },
            'voice turn: no usable reply → asking caller to repeat',
          );
          replyText = REPEAT_REPLY;
          sessionState = 'live';
          break;
      }

      // Persist the exchange so the NEXT turn has conversation history. Without
      // this, `generateSalesReply` loads zero prior turns every time and the
      // brain re-greets each utterance (no memory of the call). We persist AFTER
      // generating the reply so the current message is NOT double-counted in
      // this turn's own history. `generateSalesReply` already resolved the
      // customer here, so the conversation_turns FK is safe. Failures are
      // non-blocking — a logging blip must not drop a live call.
      try {
        const inboundAt = new Date();
        await insertTurn(opts.db, {
          customerId: parsed.customerId,
          leadId: parsed.leadId,
          channel: 'voice',
          direction: 'inbound',
          content: parsed.transcript,
          occurredAt: inboundAt,
        });
        await insertTurn(opts.db, {
          customerId: parsed.customerId,
          leadId: parsed.leadId,
          channel: 'voice',
          direction: 'outbound',
          agentRole: 'sales-agent',
          agentInstance: `voice-${parsed.sessionId}`,
          content: replyText,
          occurredAt: new Date(inboundAt.getTime() + 1),
        });
      } catch (persistErr) {
        logger.warn(
          {
            sessionId: parsed.sessionId,
            err: persistErr instanceof Error ? persistErr.message : 'persist error',
          },
          'voice turn: failed to persist conversation turns (non-blocking)',
        );
      }

      return c.json({ replyText, sessionState }, 200);
    } catch (err) {
      // generateSalesReply throws only on hard resolution failures (lead /
      // customer not found). Keep the line alive with the repeat prompt; log a
      // short error stub (never the transcript).
      logger.error(
        {
          sessionId: parsed.sessionId,
          err: err instanceof Error ? err.message : 'voice turn error',
        },
        'voice turn: reply generation threw',
      );
      return c.json({ replyText: REPEAT_REPLY, sessionState: 'live' as const }, 200);
    }
  });

  return app;
}

/**
 * Constant-time HMAC-SHA256 verification. Tolerates the `sha256=` prefix some
 * senders use (GitHub-style) and treats malformed hex as invalid rather than
 * 5xx. Identical to the lead intake router's helper.
 */
function verifyHmac(rawBody: string, providedSig: string, secret: string): boolean {
  if (!providedSig) return false;
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = providedSig.startsWith('sha256=') ? providedSig.slice(7) : providedSig;
  if (provided.length !== computed.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}
