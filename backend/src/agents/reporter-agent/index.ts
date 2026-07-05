/** Reporter Agent barrel (option G — WA group human-action escalator). */
export { ReporterAgent, type ReporterAgentDeps } from './agent.js';
export {
  registerReporterAgentClass,
  __resetReporterAgentRegistrationForTests,
} from './register.js';
export {
  buildHumanActionRequestMessage,
  buildHumanActionResolvedMessage,
  optionsBlockEn,
  severityBadgeEn,
  intentTitleEn,
  explainErrorCode,
  shortRef,
  stripUuids,
  splitDraft,
  resolveActionContext,
  HUMAN_ACTION_DRAFT_MARKER,
} from './humanize.js';
