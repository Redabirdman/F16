/**
 * Supervisor Agent barrel (M15).
 *
 * Exposes everything the worker bootstrap needs:
 *   - `registerSupervisorAgentClass()` — register the BaseAgent factory
 *   - `startArbitration()` — cross-agent conflict scheduler (M15.T4)
 *   - `startStrategyReview()` — daily Opus review scheduler (M15.T3)
 *
 * The class itself + the schedulers are independent — the worker
 * bootstrap can enable/disable each via flags.
 */
export { SupervisorAgent } from './agent.js';
export {
  registerSupervisorAgentClass,
  __resetSupervisorAgentRegistrationForTests,
} from './register.js';
export {
  startArbitration,
  type ArbitrationHandle,
  type ArbitrationOptions,
  type ArbitrationTickResult,
} from './arbitration.js';
export {
  startStrategyReview,
  buildDigest,
  proposeConfigChanges,
  type StrategyReviewHandle,
  type StrategyReviewOptions,
  type StrategyReviewResult,
  type StrategyDigest,
} from './strategy.js';
