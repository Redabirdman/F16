/**
 * Realtime barrel — re-exports the LISTEN/NOTIFY wrapper.
 *
 * Downstream consumers (admin WebSocket in M14, WhatsApp escalator in M9)
 * import from `@f16/backend/realtime` rather than reaching into `notify.ts`
 * directly.
 */
export * from './notify.js';
