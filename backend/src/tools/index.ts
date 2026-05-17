/**
 * Public surface of the tool subsystem.
 *
 * Importing this barrel both pulls in the registry helpers AND triggers
 * registration of every built-in tool (via the side effect of importing
 * `builtins/index.ts`).
 */
export * from './registry.js';
export * from './builtins/index.js';
