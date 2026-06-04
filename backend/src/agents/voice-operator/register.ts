/**
 * Class registration for the Voice Operator Agent (M10).
 *
 * Idempotent — first call wins (same pattern as maxance-operator /
 * engagement-agent). Singleton: one instance per process, instanceId
 * 'singleton'. Subscribes to the `voice` queue, where VOICE.CALL_SCHEDULED
 * is routed (see src/messaging/dispatcher.ts INTENT_TO_QUEUE).
 *
 * Concurrency 1: outbound origination is cheap, but serialising keeps the
 * audit/intent ordering deterministic and avoids hammering Asterisk from a
 * single process. Bump later if origination throughput ever matters.
 */
import { registerAgentClass } from '../registry.js';
import { VoiceOperatorAgent } from './agent.js';
import { QUEUE_NAMES } from '../../queue/queues.js';

let _registered = false;

export function registerVoiceOperatorClass(): void {
  if (_registered) return;
  _registered = true;
  registerAgentClass('voice-operator', (cfg) => {
    return new VoiceOperatorAgent({
      role: 'voice-operator',
      instanceId: cfg.instanceId,
      // Sonnet for BaseAgent bookkeeping only — this agent never calls Claude;
      // it just originates calls via the Asterisk ARI client.
      model: 'sonnet',
      queues: [QUEUE_NAMES.VOICE],
      concurrency: 1,
      db: cfg.db,
      ...(cfg.meta ? { meta: cfg.meta } : {}),
    });
  });
}

/** Test-only: clear the local registration guard. */
export function __resetVoiceOperatorRegistrationForTests(): void {
  _registered = false;
}
