/**
 * @f16/backend — LLM facade. F16 M3.T5.
 *
 * Re-exports the model tier router, prompt-cache helpers, and the single-turn
 * Claude wrapper. Agents import from here, not from `@anthropic-ai/claude-agent-sdk`
 * directly, so we can swap transports (Bedrock, Vertex) without touching call sites.
 */
export * from './router.js';
export * from './cache.js';
export * from './claude.js';
