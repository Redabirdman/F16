/**
 * Channel bootstrap (wiring layer).
 *
 * The channel registry (`./registry.ts`) only holds adapters that something
 * actually registers — but until now NOTHING did at boot. The result: every
 * `sendViaChannel()` → `getChannel('whatsapp'|'email')` threw
 * "No channel registered", silently killing the sales-agent + engagement-agent
 * customer-reply path. This module closes that gap: `start()` calls
 * `registerConfiguredChannels()` once at boot to register every channel whose
 * env is present.
 *
 * Design notes:
 *   - Env-gated: a channel registers only when its config var is set, so dev /
 *     test boots (which set neither) are unaffected — `registered` comes back
 *     empty and nothing is wired.
 *   - Idempotent via the `tryGetChannel` guards: repeated calls (or a test
 *     calling it twice) never trip the registry's "already registered" throw.
 *   - Email is wrapped in try/catch and built with `verifyOnCreate: false` so a
 *     down / not-yet-configured mail server NEVER blocks or crashes boot — a
 *     bad SMTP config degrades to "email channel unavailable", not "server
 *     won't start".
 *   - PII discipline (§9): logs carry channel IDs only — never SMTP creds,
 *     addresses, or API keys.
 */
import { registerChannel, tryGetChannel } from './registry.js';
import { WahaClient } from './whatsapp/waha-client.js';
import { WhatsAppAdapter } from './whatsapp/adapter.js';
import { EmailAdapter } from './email/adapter.js';
import { createTransport, loadSmtpConfigFromEnv } from './email/smtp-client.js';
import { logger } from '../logger.js';

export interface RegisterChannelsResult {
  /** Channel ids actually registered by this call (empty when nothing configured). */
  registered: string[];
}

/**
 * Register every channel whose configuration is present in `env`. Safe to call
 * more than once (the per-channel guards make it a no-op for already-registered
 * channels). Returns the ids registered by THIS call.
 */
export async function registerConfiguredChannels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegisterChannelsResult> {
  const registered: string[] = [];

  // --- WhatsApp (WAHA) ------------------------------------------------------
  const wahaBaseUrl = env.WAHA_BASE_URL;
  if (wahaBaseUrl && !tryGetChannel('whatsapp')) {
    const client = new WahaClient({
      baseUrl: wahaBaseUrl,
      // Conditional spread (exactOptionalPropertyTypes): omit, don't pass
      // `undefined`, when the optional env var is absent.
      ...(env.WAHA_API_KEY ? { apiKey: env.WAHA_API_KEY } : {}),
      ...(env.WAHA_SESSION ? { session: env.WAHA_SESSION } : {}),
    });
    registerChannel(new WhatsAppAdapter({ client }));
    registered.push('whatsapp');
  }

  // --- Email (SMTP: Gmail / Google Workspace / self-host relay) -------------
  // verifyOnCreate:false → no network call here, so a down mail server can
  // never block or crash boot. Any failure (bad config) is logged and swallowed
  // so the rest of the server still comes up. Gated on SMTP_HOST (legacy
  // BILLIONMAIL_SMTP_HOST still accepted by loadSmtpConfigFromEnv).
  const smtpHost = env.SMTP_HOST ?? env.BILLIONMAIL_SMTP_HOST;
  if (smtpHost && !tryGetChannel('email')) {
    try {
      const cfg = loadSmtpConfigFromEnv(env);
      const transport = await createTransport({ config: cfg, verifyOnCreate: false });
      registerChannel(
        new EmailAdapter({
          transport,
          fromName: cfg.fromName,
          fromAddress: cfg.fromAddress,
        }),
      );
      registered.push('email');
    } catch (err) {
      // PII discipline: message only, no config values.
      logger.warn(
        { channel: 'email', err: err instanceof Error ? err.message : String(err) },
        'channels: email registration failed (skipping; server boot continues)',
      );
    }
  }

  logger.info({ channels: registered }, 'channels: registered');
  return { registered };
}
