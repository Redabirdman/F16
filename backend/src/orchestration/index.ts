/**
 * Orchestration barrel — workers that wire intents to lifecycle events
 * (spawn / kill / handoff) rather than implementing domain logic themselves.
 */
export {
  startSalesSpawnOrchestrator,
  handleScored,
  type SalesSpawnOrchestratorOptions,
} from './sales-spawn.js';
