/**
 * WhatsApp channel barrel (M4.T2).
 *
 * Re-exports the WAHA HTTP client and the `ConversationChannel` adapter that
 * sits on top of it. Wiring (constructing the client from env + registering
 * the adapter via `registerChannel`) is done by the application bootstrap,
 * not here — this barrel stays side-effect free so tests can import pieces
 * individually.
 */
export * from './waha-client.js';
export * from './adapter.js';
