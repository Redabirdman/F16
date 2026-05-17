/**
 * Channel layer barrel (design §8 / M4.T1).
 *
 * Public entry point: callers import `ConversationChannel`, `ContactRef`,
 * `getChannel`, etc. from `@f16/backend/channels` (or the relative path
 * within the package). Adapter implementations (M4.T2 onwards) will live in
 * sibling files under `src/channels/` and self-register via `registerChannel`.
 */
export * from './types.js';
export * from './registry.js';
export * from './send.js';
