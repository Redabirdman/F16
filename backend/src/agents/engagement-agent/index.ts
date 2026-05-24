/**
 * Customer Engagement Agent barrel (M11).
 *
 * Exports the public surface used by the supervisor + tests. Internal
 * helpers (quiet-hours, candidate query, messaging) live alongside but
 * are not re-exported — callers go through the agent.
 */
export { EngagementAgent } from './agent.js';
export {
  registerEngagementAgentClass,
  __resetEngagementAgentRegistrationForTests,
} from './register.js';
export {
  startEngagementScheduler,
  type EngagementSchedulerHandle,
  type EngagementSchedulerOptions,
} from './scheduler.js';
export {
  findEngagementCandidates,
  ELIGIBLE_LEAD_STATUSES,
  type EngagementCandidate,
} from './candidate.js';
export { isQuietNow } from './quiet-hours.js';
