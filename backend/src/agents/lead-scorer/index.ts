/**
 * Lead Scorer agent barrel — M5.T3.
 *
 * Public surface:
 *   - `startLeadScorerWorker` boots the BullMQ-backed consumer.
 *   - `handleLeadNew` lets callers invoke the handler directly (tests + ad-hoc).
 *   - `buildLeadScorerSystemPrompt` / `buildLeadScorerUserPrompt` are exposed
 *     so other agents (or eval scripts) can reuse the rubric.
 */
export {
  startLeadScorerWorker,
  handleLeadNew,
  type LeadScorerWorkerOptions,
  type LeadScoreOutput,
} from './worker.js';

export {
  buildLeadScorerSystemPrompt,
  buildLeadScorerUserPrompt,
  type LeadScorerUserPromptInput,
} from './prompt.js';
