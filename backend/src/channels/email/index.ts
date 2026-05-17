/**
 * Email channel barrel (M4.T4).
 *
 * Re-exports the SMTP client wrapper and the `ConversationChannel` adapter.
 * Application bootstrap is responsible for constructing the transport from
 * env vars (`loadSmtpConfigFromEnv` + `createTransport`) and registering
 * `new EmailAdapter({...})` via `registerChannel`.
 */
export * from './smtp-client.js';
export * from './markdown.js';
export * from './adapter.js';
