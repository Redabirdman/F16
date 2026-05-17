/**
 * `src/leads` barrel.
 *
 * The HTTP factory + pure-logic module are co-exported so the boot path in
 * `src/index.ts` and tests can import either entry point from a single
 * subpath.
 */
export * from './intake.js';
export * from './intake-http.js';
