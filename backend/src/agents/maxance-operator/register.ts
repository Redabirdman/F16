/**
 * Class registration for the Maxance Operator Agent (M8.T4).
 *
 * Same idempotent registration pattern as the Sales Agent — first call wins,
 * subsequent calls are no-ops. The spawn orchestrator + tests both invoke
 * this safely.
 *
 * The Operator subscribes to a SINGLE queue (`quote`). Its concurrency is
 * pinned at 1 — only one Maxance browser session is logged in at a time
 * on the dedicated PC, so serialising quote runs is correct. Pre-warming
 * a pool of N sessions for true parallelism is M8.T5.
 */
import { registerAgentClass } from '../registry.js';
import { MaxanceOperatorAgent } from './agent.js';
import { QUEUE_NAMES } from '../../queue/queues.js';

let _registered = false;

export function registerMaxanceOperatorClass(): void {
  if (_registered) return;
  _registered = true;
  registerAgentClass('maxance-operator', (cfg) => {
    return new MaxanceOperatorAgent({
      role: 'maxance-operator',
      instanceId: cfg.instanceId,
      // Sonnet because the Stagehand service handles all the LLM-driven
      // bits internally (price extraction, tab detection). The agent
      // itself doesn't call Claude — model is just for BaseAgent
      // bookkeeping / future tool-use extension.
      model: 'sonnet',
      queues: [QUEUE_NAMES.QUOTE],
      concurrency: 1,
      db: cfg.db,
      ...(cfg.meta ? { meta: cfg.meta } : {}),
    });
  });
}

/** Test-only: clear the local registration guard. */
export function __resetMaxanceOperatorRegistrationForTests(): void {
  _registered = false;
}
