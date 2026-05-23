/** Reporter Agent barrel (option G — WA group human-action escalator). */
export { ReporterAgent, type ReporterAgentDeps } from './agent.js';
export {
  registerReporterAgentClass,
  __resetReporterAgentRegistrationForTests,
} from './register.js';
export {
  formatHumanActionRequest,
  formatHumanActionResolved,
  formatOptionsBlock,
  severityBadge,
} from './format.js';
