/**
 * Class registration for the Supervisor Agent (M15.T1).
 *
 * Idempotent — first call wins, subsequent calls no-op. Same pattern as
 * reporter-agent / engagement-agent / maxance-operator.
 *
 * Singleton: one instance per process, instanceId='singleton'. Subscribes
 * to the `compliance` + `knowledge` queues (both already address
 * `toRole: 'supervisor'` from the existing emit sites).
 */
import { registerAgentClass } from '../registry.js';
import { SupervisorAgent } from './agent.js';
import { QUEUE_NAMES } from '../../queue/queues.js';

let _registered = false;

export function registerSupervisorAgentClass(): void {
  if (_registered) return;
  _registered = true;
  registerAgentClass('supervisor', (cfg) => {
    return new SupervisorAgent({
      role: 'supervisor',
      instanceId: cfg.instanceId,
      // Haiku — the agent itself doesn't call the LLM. T3's strategy.ts
      // calls Opus directly; that's a sidecar timer, not an onMessage
      // path. The tier here is informational on the agents_state row.
      model: 'haiku',
      queues: [QUEUE_NAMES.COMPLIANCE, QUEUE_NAMES.KNOWLEDGE],
      concurrency: 1,
      db: cfg.db,
      ...(cfg.meta ? { meta: cfg.meta } : {}),
    });
  });
}

/** Test-only: clear the local registration guard. */
export function __resetSupervisorAgentRegistrationForTests(): void {
  _registered = false;
}
