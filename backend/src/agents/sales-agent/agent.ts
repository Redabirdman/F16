/**
 * Sales Agent — M5.T4 PLACEHOLDER.
 *
 * The real Sales Agent (the per-lead WhatsApp/voice conversation loop) ships
 * in M6. For M5.T4 we only need a concrete subclass so the orchestrator's
 * spawn path is verifiable end-to-end: the class registers, the registry
 * spawns an instance, the BullMQ worker picks up the addressed message,
 * BaseAgent's instance-filter routes it here, and we acknowledge.
 *
 * Swap-in point for M6:
 *   - Constructor, role, queue, model tier stay identical.
 *   - Only the body of `onMessage` is rewritten (LLM loop, Mem0 recall,
 *     channel adapters, etc.). The orchestrator + register module stay put.
 */
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';

export class SalesAgent extends BaseAgent {
  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    logger.info(
      {
        instanceId: this.instanceId,
        intent: envelope.intent,
        correlationId: envelope.correlationId,
      },
      'sales-agent (placeholder): received message — M6 will implement real handling',
    );
    return { ok: true, result: { placeholder: true, intent: envelope.intent } };
  }
}
