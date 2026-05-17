/**
 * Public surface for `src/agents`. Re-exports the BaseAgent abstraction +
 * the envelope/result types from the dispatcher so consumers never have to
 * reach into the messaging layer directly.
 */
export type { ModelTier, BaseAgentConfig } from './base.js';
export { BaseAgent } from './base.js';
export type { AgentMessageEnvelope, MessageHandlerResult } from '../messaging/dispatcher.js';
export {
  registerAgentClass,
  listAgentClasses,
  listRunning,
  getInstance,
  spawn,
  kill,
  killAll,
  heartbeat,
  __resetAgentRegistryForTests,
} from './registry.js';
export type { AgentClassFactory } from './registry.js';
