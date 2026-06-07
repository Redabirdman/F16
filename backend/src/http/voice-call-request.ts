/**
 * Website "call me" intake (M10 V2).
 *
 * Mounts `POST /v1/voice/call-request` — the endpoint the assuryalconseil.fr
 * "rappelez-moi" / call-me CTA hits. It resolves (or creates) the customer +
 * lead by phone, then emits VOICE.CALL_SCHEDULED → the voice-operator
 * originates the call via the OpenAI native-SIP bridge. This is the inbound
 * "call me" half of autonomous voice (the WhatsApp half is the
 * `voice.schedule_call` tool).
 *
 * Security: same shared-secret HMAC-SHA256-over-body as `/v1/leads` and
 * `/v1/voice/turn` (header `x-f16-signature`). Skipped only when no secret is
 * configured (dev).
 *
 * PII discipline: the phone is PII — never logged. Responses are static
 * strings; we never echo the body. Logs carry only the callId.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { getCustomerByPhone, insertCustomer } from '../db/repositories/customers.js';
import { leads } from '../db/schema/leads.js';
import { sendMessage } from '../messaging/dispatcher.js';

export const CallRequestPayloadSchema = z.object({
  /** E.164-ish phone to call back (validated loosely; carrier is the real check). */
  phone: z.string().min(6).max(20),
  fullName: z.string().min(1).max(120).optional(),
  /** Optional context shown to the agent / audit. */
  reason: z.string().max(500).optional(),
});

export interface VoiceCallRequestRouterOptions {
  db: Database;
  hmacSecret?: string;
}

export function buildVoiceCallRequestRouter(opts: VoiceCallRequestRouterOptions): Hono {
  const app = new Hono();

  app.post('/v1/voice/call-request', async (c) => {
    const rawBody = await c.req.text();

    if (opts.hmacSecret) {
      const sig = c.req.header('x-f16-signature') ?? '';
      if (!verifyHmac(rawBody, sig, opts.hmacSecret)) {
        logger.warn({}, 'voice call-request: HMAC verification failed');
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }

    let parsed: z.infer<typeof CallRequestPayloadSchema>;
    try {
      parsed = CallRequestPayloadSchema.parse(JSON.parse(rawBody));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'parse error' },
        'voice call-request: invalid payload',
      );
      return c.json({ error: 'invalid_payload' }, 400);
    }

    try {
      // Resolve or create the customer + a lead (so the call is brain-aware).
      let customer = await getCustomerByPhone(opts.db, parsed.phone);
      if (!customer) {
        customer = await insertCustomer(opts.db, {
          fullName: parsed.fullName ?? 'Prospect (call-me)',
          phone: parsed.phone,
          civility: null,
        });
      }
      const existing = await opts.db
        .select()
        .from(leads)
        .where(eq(leads.customerId, customer.id))
        .orderBy(desc(leads.createdAt))
        .limit(1);
      let lead = existing[0];
      if (!lead) {
        const [ins] = await opts.db
          .insert(leads)
          .values({
            customerId: customer.id,
            source: 'website',
            productLine: 'scooter',
            status: 'new',
            score: null,
            rawPayload: { via: 'voice-call-request', reason: parsed.reason ?? null },
          })
          .returning();
        lead = ins;
      }

      const callId = randomUUID();
      await sendMessage(
        { db: opts.db },
        {
          fromRole: 'website',
          toRole: 'voice-operator',
          intent: 'VOICE.CALL_SCHEDULED',
          payload: {
            callId,
            customerId: customer.id,
            toNumber: parsed.phone,
            scheduledAt: new Date().toISOString(),
          },
          ...(lead?.id ? { correlationId: lead.id } : {}),
        },
      );

      logger.info({ callId }, 'voice call-request: scheduled outbound call');
      return c.json({ ok: true, callId }, 202);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : 'call-request error' },
        'voice call-request: failed to schedule',
      );
      return c.json({ error: 'schedule_failed' }, 500);
    }
  });

  return app;
}

/** Constant-time HMAC-SHA256 verification (identical to the other routers). */
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
