/**
 * Voice Operator Agent (M10) — outbound-call origination.
 *
 * Consumes a single intent: `VOICE.CALL_SCHEDULED` {callId, customerId,
 * toNumber, scheduledAt}. When the system decides to phone a customer (e.g.
 * the Engagement Agent for a WhatsApp-silent lead), it emits this intent; the
 * Voice Operator turns it into a live call:
 *
 *   1. Resolve the customer's phone (prefer the verified DB phone over the raw
 *      toNumber on the intent — the intent's number may be stale).
 *   2. Generate a sessionId (correlates the jambonz call ↔ Pipecat WS ↔ our
 *      VOICE.* intents ↔ audit).
 *   3. jambonzClient.originateCall(...) → jambonz dials over the OVH trunk and,
 *      on answer, fetches our call-hook which bridges audio to Pipecat.
 *   4. Emit VOICE.CALL_STARTED on success; VOICE.CALL_FAILED on any error.
 *   5. Write a maxance-style audit row either way.
 *
 * Mirrors the maxance-operator pattern: a BaseAgent singleton, env-gated on the
 * jambonz config (a process without JAMBONZ_* env can't originate, so a stray
 * VOICE.CALL_SCHEDULED resolves to a tagged VOICE.CALL_FAILED rather than a
 * crash). The jambonz client is injectable for tests.
 *
 * PII discipline: the destination phone is PII — it is NEVER logged or written
 * into an audit/intent payload. We log only callId + sessionId + the jambonz
 * call sid; the audit row records the customerId, not the number.
 */
import { randomUUID } from 'node:crypto';
import { BaseAgent, type BaseAgentConfig } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import { getCustomerById } from '../../db/repositories/customers.js';
import {
  JambonzClient,
  jambonzClientFromEnv,
  type CallMetadata,
} from '../../voice/jambonz-client.js';

export interface VoiceOperatorConfig extends BaseAgentConfig {
  /**
   * Injectable jambonz client. When omitted, the agent lazily builds one from
   * env on first use (`jambonzClientFromEnv`). Tests pass a fake.
   */
  jambonzClient?: JambonzClient | null;
}

/** Shape of the VOICE.CALL_SCHEDULED payload (validated upstream by the registry). */
interface CallScheduledPayload {
  callId: string;
  customerId: string;
  toNumber: string;
  scheduledAt: string;
}

export class VoiceOperatorAgent extends BaseAgent {
  /** null = "not yet resolved"; set lazily from env on first handler call. */
  private client: JambonzClient | null;
  private readonly clientInjected: boolean;

  constructor(cfg: VoiceOperatorConfig) {
    super(cfg);
    this.client = cfg.jambonzClient ?? null;
    this.clientInjected = cfg.jambonzClient !== undefined;
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
   * Resolve the jambonz client. If one was injected (tests / explicit wiring)
   * use it; otherwise build from env once and cache. A null result means the
   * env is incomplete → origination is disabled for this process.
   */
  private resolveClient(): JambonzClient | null {
    if (this.clientInjected) return this.client;
    if (this.client) return this.client;
    this.client = jambonzClientFromEnv();
    return this.client;
  }

  private async handleScheduled(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    const payload = envelope.payload as CallScheduledPayload;
    const { callId, customerId } = payload;

    const client = this.resolveClient();
    if (!client) {
      return this.fail({
        callId,
        customerId,
        reason: 'jambonz_disabled_no_env',
        audit: false, // config gap, not a call attempt — skip the audit noise
      });
    }

    // Resolve the phone. Prefer the verified DB phone; fall back to the
    // intent's toNumber. Both are PII — never logged.
    let toNumber = payload.toNumber;
    try {
      const customer = await getCustomerById(this.db, customerId);
      if (customer?.phone) {
        toNumber = customer.phone;
      } else if (!toNumber) {
        return this.fail({ callId, customerId, reason: 'no_phone_for_customer' });
      }
    } catch (err) {
      logger.error(
        { callId, customerId, err: err instanceof Error ? err.message : String(err) },
        'voice-operator: customer resolution failed',
      );
      return this.fail({ callId, customerId, reason: 'customer_resolution_failed' });
    }

    if (!toNumber) {
      return this.fail({ callId, customerId, reason: 'no_phone_for_customer' });
    }

    const sessionId = `voice-${callId}-${randomUUID().slice(0, 8)}`;
    const metadata: CallMetadata = {
      sessionId,
      // Pipecat's `leadId` slot — VOICE.* intents carry customerId, and the
      // call-hook/Pipecat contract calls it leadId. We thread the customerId
      // through as the lead correlation key (V1: one active lead per customer
      // on the voice channel). callId remains the authoritative correlation id.
      leadId: customerId,
      customerId,
      callId,
    };

    let callSid: string;
    try {
      const res = await client.originateCall({ to: toNumber, metadata });
      callSid = res.callSid;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'originate_failed';
      logger.error(
        { callId, customerId, sessionId, reason },
        'voice-operator: originateCall failed',
      );
      return this.fail({ callId, customerId, reason });
    }

    // Audit the successful origination (customerId, not the phone number).
    try {
      await appendAudit(this.db, {
        actorType: 'agent',
        actorId: `${this.role}#${this.instanceId}`,
        action: 'voice.call.originated',
        targetType: 'customer',
        targetId: customerId,
        after: { callId, sessionId, jambonzCallSid: callSid },
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

    await this.send({
      toRole: 'sales-agent',
      intent: 'VOICE.CALL_STARTED',
      payload: { callId, customerId },
      correlationId: callId,
    });

    logger.info(
      { callId, customerId, sessionId, jambonzCallSid: callSid, instanceId: this.instanceId },
      'voice-operator: outbound call started',
    );

    return { ok: true, result: { started: true, sessionId, jambonzCallSid: callSid } };
  }

  /**
   * Emit VOICE.CALL_FAILED + (optionally) an audit row, and return a
   * successful handler result (the message WAS handled — the call just
   * couldn't be placed; we don't want BullMQ to retry a bad-phone forever).
   */
  private async fail(args: {
    callId: string;
    customerId: string;
    reason: string;
    audit?: boolean;
  }): Promise<MessageHandlerResult> {
    const { callId, customerId, reason } = args;
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
    }

    await this.send({
      toRole: 'sales-agent',
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
}
