/**
 * SMS channel barrel (M4.T5).
 *
 * Re-exports the android-sms-gateway HTTP client and the `ConversationChannel`
 * adapter that sits on top of it. Wiring (constructing the client from env +
 * registering the adapter via `registerChannel`) is done by the application
 * bootstrap, not here — this barrel stays side-effect free so tests can
 * import pieces individually.
 */
export * from './gateway-client.js';
export * from './adapter.js';
