/**
 * Class registration for the Sales Agent.
 *
 * Calling `registerSalesAgentClass()` registers a factory under the
 * `'sales-agent'` role with the agent registry, so subsequent calls to
 * `spawn({ role: 'sales-agent', instanceId, db })` work.
 *
 * Idempotent — safe to call multiple times in the same process. The first
 * call wins; later ones are no-ops. This matters because:
 *   - the sales-spawn orchestrator calls it at startup,
 *   - tests may instantiate multiple orchestrators in the same process,
 *   - a future supervisor (M15) may also call it before spawning.
 *
 * Tests that wipe the registry via `__resetAgentRegistryForTests()` should
 * also reset the local guard (see `__resetSalesAgentRegistrationForTests`).
 */
import { registerAgentClass } from '../registry.js';
import { SalesAgent } from './agent.js';
import { QUEUE_NAMES } from '../../queue/queues.js';

let _registered = false;

export function registerSalesAgentClass(): void {
  if (_registered) return;
  _registered = true;
  registerAgentClass('sales-agent', (cfg) => {
    return new SalesAgent({
      role: 'sales-agent',
      instanceId: cfg.instanceId,
      model: 'sonnet',
      // The Sales Agent consumes from BOTH queues:
      //   - 'lead'     — receives LEAD.SCORED (first-turn welcome)
      //   - 'customer' — receives CUSTOMER.MESSAGE_RECEIVED (ongoing chat)
      // BaseAgent spins up one BullMQ worker per queue; both feed the same
      // onMessage handler. `queues[0]` ('lead') is reported as the primary
      // queue in agents_state for the admin's at-a-glance summary.
      queues: [QUEUE_NAMES.LEAD, QUEUE_NAMES.CUSTOMER],
      db: cfg.db,
      ...(cfg.meta ? { meta: cfg.meta } : {}),
    });
  });
}

/** Test-only: clear the local registration guard. */
export function __resetSalesAgentRegistrationForTests(): void {
  _registered = false;
}
