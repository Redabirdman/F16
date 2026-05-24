/**
 * Class registration for the Customer Engagement Agent (M11).
 *
 * Idempotent — first call wins, subsequent calls no-op. Matches the
 * reporter-agent / sales-agent / maxance-operator pattern.
 *
 * Singleton: one instance per process, instanceId='singleton'. The agent
 * has no per-lead instance state — every tick re-derives cadence + quiet
 * hours from conversation_turns + the system clock.
 */
import { registerAgentClass } from '../registry.js';
import { EngagementAgent } from './agent.js';
import { QUEUE_NAMES } from '../../queue/queues.js';

let _registered = false;

export function registerEngagementAgentClass(): void {
  if (_registered) return;
  _registered = true;
  registerAgentClass('engagement-agent', (cfg) => {
    return new EngagementAgent({
      role: 'engagement-agent',
      instanceId: cfg.instanceId,
      // Haiku — the nudge generator inside `messaging.ts` calls Haiku
      // directly. The `model` tier here is informational (recorded on the
      // agents_state row); the agent itself doesn't auto-call this tier.
      model: 'haiku',
      queues: [QUEUE_NAMES.ENGAGEMENT],
      concurrency: 1,
      db: cfg.db,
      ...(cfg.meta ? { meta: cfg.meta } : {}),
    });
  });
}

/** Test-only: clear the local registration guard. */
export function __resetEngagementAgentRegistrationForTests(): void {
  _registered = false;
}
