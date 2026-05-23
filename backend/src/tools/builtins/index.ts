/**
 * Built-in tool barrel.
 *
 * Importing this module triggers side-effect registration of every starter
 * tool via the `registerTool({...})` calls in each module body. The
 * Claude Agent SDK wiring (M6) imports this once at boot so the registry is
 * populated before the first agent spawns.
 *
 * The named exports below are re-exports of each tool's canonical name
 * constant — useful for tests + the agent-allowedTools lists.
 */
import './customer-read-profile.js';
import './customer-update-profile.js';
import './customer-remember-fact.js';
import './knowledge-search.js';
import './human-escalate.js';
import './quote-request.js';

export { customerReadProfileToolName } from './customer-read-profile.js';
export { customerUpdateProfileToolName } from './customer-update-profile.js';
export { customerRememberFactToolName } from './customer-remember-fact.js';
export { knowledgeSearchToolName } from './knowledge-search.js';
export { humanEscalateToolName } from './human-escalate.js';
export { quoteRequestToolName } from './quote-request.js';
