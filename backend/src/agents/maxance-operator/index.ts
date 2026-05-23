/**
 * Maxance Operator agent barrel (M8.T4).
 *
 * Public surface: the agent class, the registration helper, and the
 * Stagehand HTTP client. Internals (helpers, types) stay private.
 */
export { MaxanceOperatorAgent } from './agent.js';
export {
  registerMaxanceOperatorClass,
  __resetMaxanceOperatorRegistrationForTests,
} from './register.js';
export {
  StagehandClient,
  StagehandClientError,
  getDefaultStagehandClient,
  __setStagehandClientForTests,
  type QuotePreviewResult,
  type LoginResult,
  type StagehandQuoteParams,
  type StagehandClientConfig,
} from './stagehand-client.js';
