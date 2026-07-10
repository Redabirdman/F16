/**
 * Voice Operator Agent — outbound-call origination (Asterisk ARI).
 *
 * Consumes a single intent: `VOICE.CALL_SCHEDULED` {callId, customerId,
 * toNumber, scheduledAt}. When the system decides to phone a customer (e.g. the
 * Engagement Agent for a WhatsApp-silent lead), it emits this intent; the Voice
 * Operator turns it into a live call:
 *
 *   1. Generate a sessionId (uuid v4) — this becomes the Asterisk AudioSocket
 *      AS_UUID and correlates the call ↔ Pipecat ↔ our VOICE.* intents ↔ audit.
 *   2. Resolve the customer's phone (prefer the verified DB phone over the raw
 *      toNumber on the intent — the intent's number may be stale).
 *   3. putSession(sessionId, {leadId, customerId}) so Pipecat can resolve the
 *      lead/customer from the AudioSocket UUID via GET /v1/voice/session/:id.
 *   4. asteriskClient.originateCall({ to, sessionId }) → Asterisk dials over the
 *      OVH PJSIP trunk and, on answer, the f16-dial dialplan bridges audio to
 *      AudioSocket → Pipecat. No call-control webhook (the dialplan owns it).
 *   5. Emit VOICE.CALL_STARTED {callId, channelId} on success; VOICE.CALL_FAILED
 *      {callId, reason} on any error.
 *   6. Write an audit row either way.
 *
 * Mirrors the maxance-operator pattern: a BaseAgent singleton, env-gated on the
 * Asterisk config (a process without ASTERISK_* env can't originate, so a stray
 * VOICE.CALL_SCHEDULED resolves to a tagged VOICE.CALL_FAILED rather than a
 * crash). The Asterisk client is injectable for tests.
 *
 * PII discipline: the destination phone is PII — it is NEVER logged or written
 * into an audit/intent payload. We log only callId + sessionId + the Asterisk
 * channelId; the audit row records the customerId, not the number.
 */
import { createHash, randomUUID } from 'node:crypto';
import { BaseAgent, type BaseAgentConfig } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import { getCustomerById } from '../../db/repositories/customers.js';
import { createAction, hasPendingAction } from '../../db/repositories/human-actions.js';
import { notifyHumanAction } from '../human-notify.js';
import { type VoiceOriginator, asteriskClientFromEnv } from '../../voice/asterisk-client.js';
import { putSession } from '../../voice/session-store.js';
import { getRedis } from '../../queue/index.js';

export interface VoiceOperatorConfig extends BaseAgentConfig {
  /**
   * Injectable Asterisk origination client (ARI-HTTP or network-independent
   * CLI). When omitted, the agent lazily builds one from env on first use
   * (`asteriskClientFromEnv`). Tests pass a fake.
   */
  asteriskClient?: VoiceOriginator | null;
}

/** Shape of the VOICE.CALL_SCHEDULED payload (validated upstream by the registry). */
interface CallScheduledPayload {
  callId: string;
  customerId: string;
  toNumber: string;
  scheduledAt: string;
  /** toNumber is a customer-provided alternative — dial it, don't re-resolve. */
  altNumber?: boolean;
}

export class VoiceOperatorAgent extends BaseAgent {
  /** null = "not yet resolved"; set lazily from env on first handler call. */
  private client: VoiceOriginator | null;
  private readonly clientInjected: boolean;

  constructor(cfg: VoiceOperatorConfig) {
    super(cfg);
    this.client = cfg.asteriskClient ?? null;
    this.clientInjected = cfg.asteriskClient !== undefined;
  }

  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    try {
      if (envelope.intent !== 'VOICE.CALL_SCHEDULED') {
        return { ok: true, result: { skipped: 'unhandled-intent', intent: envelope.intent } };
      }
      return await this.handleScheduled(envelope);
    } catch (err) {
      logger.error(
        { err, intent: envelope.intent, instanceId: this.instanceId },
        'voice-operator: onMessage threw',
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Resolve the Asterisk client. If one was injected (tests / explicit wiring)
   * use it; otherwise build from env once and cache. A null result means the
   * env is incomplete → origination is disabled for this process.
   */
  private resolveClient(): VoiceOriginator | null {
    if (this.clientInjected) return this.client;
    if (this.client) return this.client;
    this.client = asteriskClientFromEnv();
    return this.client;
  }

  private async handleScheduled(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    const payload = envelope.payload as CallScheduledPayload;
    const { callId, customerId } = payload;

    // Duplicate-call guard (2026-07-07 live: two retried LLM turns each
    // scheduled a call → the customer's phone rang TWICE a second apart).
    // One outbound call per customer PER NUMBER per 5 minutes (2026-07-08:
    // the customer gave a DIFFERENT number after we dialed the wrong one —
    // the corrective call must not be swallowed by the guard). The number
    // is hashed so no raw phone lands in Redis keys. Best-effort — if Redis
    // is down we'd rather risk a duplicate than block a legitimate call.
    const numHash = createHash('sha256')
      .update(payload.toNumber ?? '')
      .digest('hex')
      .slice(0, 12);
    // Remembered so every failure path can RELEASE it (2026-07-10): a failed
    // originate left the 5-min lock behind, so the human 'Retry the call'
    // choice was silently swallowed as a duplicate.
    const guardKey = `f16:voice-call-inflight:${customerId}:${numHash}`;
    try {
      const first = await getRedis().set(guardKey, callId, 'EX', 300, 'NX');
      if (first === null) {
        logger.warn(
          { callId, customerId, instanceId: this.instanceId },
          'voice-operator: a call to this customer is already in flight — skipping duplicate',
        );
        return { ok: true, result: { skipped: 'call-already-inflight', callId } };
      }
    } catch {
      // Redis unavailable — proceed without the guard.
    }

    const client = this.resolveClient();
    if (!client) {
      return this.fail({
        callId,
        customerId,
        reason: 'asterisk_disabled_no_env',
        audit: false, // config gap, not a call attempt — skip the audit noise
        guardKey,
      });
    }

    // Resolve the phone. Prefer the verified DB phone; fall back to the
    // intent's toNumber. Both are PII — never logged.
    // EXCEPTION (live 2026-07-08): altNumber=true means the customer gave a
    // DIFFERENT number for this call in conversation — this stale-number
    // safeguard was clobbering it and dialing the profile phone instead.
    let toNumber = payload.toNumber;
    try {
      const customer = await getCustomerById(this.db, customerId);
      if (customer?.phone && !(payload.altNumber && toNumber)) {
        toNumber = customer.phone;
      } else if (!toNumber) {
        return this.fail({ callId, customerId, reason: 'no_phone_for_customer', guardKey });
      }
    } catch (err) {
      logger.error(
        { callId, customerId, err: err instanceof Error ? err.message : String(err) },
        'voice-operator: customer resolution failed',
      );
      return this.fail({ callId, customerId, reason: 'customer_resolution_failed', guardKey });
    }

    if (!toNumber) {
      return this.fail({ callId, customerId, reason: 'no_phone_for_customer', guardKey });
    }

    // sessionId = the Asterisk AudioSocket AS_UUID. uuid v4 — opaque + unique.
    const sessionId = randomUUID();
    // leadId correlation key: the call's correlationId carries the lead context
    // when set; otherwise we fall back to the customerId (V1: one active lead
    // per customer on the voice channel). callId stays the authoritative id.
    const leadId = envelope.correlationId ?? customerId;

    // Register the session BEFORE originating so Pipecat can resolve it the
    // moment the AudioSocket connects (the lookup races call setup).
    try {
      await putSession(sessionId, { leadId, customerId });
    } catch (err) {
      logger.error(
        { callId, customerId, sessionId, err: err instanceof Error ? err.message : String(err) },
        'voice-operator: session registry write failed',
      );
      return this.fail({ callId, customerId, reason: 'session_store_failed', guardKey });
    }

    let channelId: string;
    try {
      // Native SIP (V1 default) → OpenAI Realtime bridge; else the legacy
      // Pipecat/AudioSocket cascade. The client decides via its env flag.
      const res = client.nativeSip
        ? await client.originateNativeSip({ to: toNumber, sessionId })
        : await client.originateCall({ to: toNumber, sessionId });
      channelId = res.channelId;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'originate_failed';
      logger.error(
        { callId, customerId, sessionId, reason },
        'voice-operator: originateCall failed',
      );
      return this.fail({ callId, customerId, reason, guardKey });
    }

    // Audit the successful origination (customerId, not the phone number).
    try {
      await appendAudit(this.db, {
        actorType: 'agent',
        actorId: `${this.role}#${this.instanceId}`,
        action: 'voice.call.originated',
        targetType: 'customer',
        targetId: customerId,
        after: { callId, sessionId, channelId },
        meta: { intent: 'VOICE.CALL_SCHEDULED' },
      });
    } catch (err) {
      // Non-blocking — the call is already placed; an audit blip shouldn't
      // turn a live call into a failure.
      logger.warn(
        { callId, customerId, err: err instanceof Error ? err.message : String(err) },
        'voice-operator: audit append failed (non-blocking)',
      );
    }

    // VOICE.CALL_STARTED is a lifecycle/telemetry event on the `voice` queue.
    // It has no separate consumer in V1 (the live conversation runs through
    // /v1/voice/turn + reply-core, not this intent), and the durable origination
    // fact is already in the audit log above. We address it to `voice-operator`
    // — the SOLE consumer of the `voice` queue — which skip-acks any non-
    // SCHEDULED intent. Addressing it to `sales-agent` (which never subscribes
    // to `voice`) made it unconsumable → the dispatcher re-routed it forever.
    // Do NOT put sales-agent on the `voice` queue to "fix" it: that would make
    // SCHEDULED (→voice-operator) and STARTED/FAILED (→sales-agent) ping-pong
    // between the two roles on the shared queue.
    await this.send({
      toRole: 'voice-operator',
      toInstance: this.instanceId,
      intent: 'VOICE.CALL_STARTED',
      payload: { callId, customerId, channelId },
      correlationId: callId,
    });

    logger.info(
      { callId, customerId, sessionId, channelId, instanceId: this.instanceId },
      'voice-operator: outbound call started',
    );

    return { ok: true, result: { started: true, sessionId, channelId } };
  }

  /**
   * Emit VOICE.CALL_FAILED + (optionally) an audit row, and return a
   * successful handler result (the message WAS handled — the call just
   * couldn't be placed; we don't want BullMQ to retry a bad-phone forever).
   *
   * 2026-07-10: real attempt failures ALSO raise a deduped human action + WA
   * alert. Before this, VOICE.CALL_FAILED was a lifecycle event nobody read —
   * a call-preference lead's very first contact failed (unroutable number)
   * and the system stayed silent while the customer waited for a ring.
   */
  private async fail(args: {
    callId: string;
    customerId: string;
    reason: string;
    audit?: boolean;
    /** Duplicate-call guard key to RELEASE — a failed attempt must not hold the 5-min lock. */
    guardKey?: string;
  }): Promise<MessageHandlerResult> {
    const { callId, customerId, reason } = args;
    if (args.guardKey) {
      try {
        await getRedis().del(args.guardKey);
      } catch {
        // Redis blip — the key self-expires in ≤5 min anyway.
      }
    }
    if (args.audit !== false) {
      try {
        await appendAudit(this.db, {
          actorType: 'agent',
          actorId: `${this.role}#${this.instanceId}`,
          action: 'voice.call.failed',
          targetType: 'customer',
          targetId: customerId,
          after: { callId, reason },
          meta: { intent: 'VOICE.CALL_SCHEDULED' },
        });
      } catch (err) {
        logger.warn(
          { callId, customerId, err: err instanceof Error ? err.message : String(err) },
          'voice-operator: failure audit append failed (non-blocking)',
        );
      }
      await this.escalateFailure(customerId, reason);
    }

    // Same routing rationale as VOICE.CALL_STARTED above: a lifecycle event on
    // the `voice` queue, self-addressed to the voice-operator (its only
    // consumer) so it is durably recorded + cleanly skip-acked, never requeued.
    await this.send({
      toRole: 'voice-operator',
      toInstance: this.instanceId,
      intent: 'VOICE.CALL_FAILED',
      payload: { callId, reason },
      correlationId: callId,
    });

    logger.warn(
      { callId, customerId, reason, instanceId: this.instanceId },
      'voice-operator: call failed',
    );
    return { ok: true, result: { failed: true, reason } };
  }

  /**
   * One pending VOICE_CALL_FAILED action per customer (same dedup discipline
   * as QUOTE_FAILED); resolving it re-arms the alert. correlationId = the
   * CUSTOMER id — the retry choice-executor dials from it. English summary,
   * no UUIDs, customer name included (management-comms mandate). Best-effort:
   * an alerting hiccup must not fail the handler.
   */
  private async escalateFailure(customerId: string, reason: string): Promise<void> {
    try {
      const already = await hasPendingAction(this.db, {
        correlationId: customerId,
        intent: 'VOICE_CALL_FAILED',
      });
      if (already) return;

      let name = 'the customer';
      try {
        const customer = await getCustomerById(this.db, customerId);
        if (customer?.fullName) name = customer.fullName;
      } catch {
        // name lookup is cosmetic — the alert still goes out
      }

      const action = await createAction(this.db, {
        createdByAgent: `${this.role}#${this.instanceId}`,
        correlationId: customerId,
        intent: 'VOICE_CALL_FAILED',
        severity: 2,
        // The trailing (slug) feeds extractErrorCode → the admin queue's
        // French problem sentence; the prose before it is the WA-group line.
        summary: `Outbound call to ${name} could not be placed — ${explainCallFailure(reason)} (${reason}).`,
        options: [
          { id: 'retry', label: 'Retry the call', kind: 'approve' },
          { id: 'ignore', label: 'Ignore', kind: 'reject' },
        ],
      });
      await notifyHumanAction(
        this.db,
        { id: action.id, severity: 2, summary: action.summary },
        { role: this.role, instanceId: this.instanceId, correlationId: customerId },
      );
    } catch (err) {
      logger.warn(
        { customerId, reason, err: err instanceof Error ? err.message : String(err) },
        'voice-operator: failure escalation failed (non-blocking)',
      );
    }
  }
}

/** Machine reason → plain English for the WA-group/admin summary. */
function explainCallFailure(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('no_channel') || r.includes('originate_rejected')) {
    return 'the dial was rejected, the phone number is likely invalid or unreachable from our line';
  }
  if (r.includes('no_phone_for_customer')) {
    return 'no phone number on file';
  }
  if (r.includes('transport') || r.includes('setglobal')) {
    return 'the phone system (Asterisk) did not respond';
  }
  return `technical error (${reason})`;
}
