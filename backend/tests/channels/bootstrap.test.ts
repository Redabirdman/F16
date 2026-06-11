/**
 * Unit tests for channel bootstrap wiring. No infra required.
 *
 * `registerConfiguredChannels` is the boot-time call that fixes the latent
 * bug where NOTHING registered the whatsapp/email adapters, so every
 * `sendViaChannel()` threw "No channel registered". These tests prove it:
 *   - registers exactly the channels whose env is present,
 *   - registers nothing when nothing is configured,
 *   - is idempotent (safe to call twice without the "already registered" throw).
 *
 * We pass a FAKE `env` object rather than mutating `process.env`, and reset the
 * registry before each case via `__resetChannelsForTests()`.
 *
 * Note on email: `createTransport({ verifyOnCreate: false })` builds a real
 * nodemailer transporter but skips `verify()`, so there is NO network call —
 * safe offline. We assert via `tryGetChannel`/`getChannel`, never sending.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerConfiguredChannels } from '../../src/channels/bootstrap.js';
import {
  getChannel,
  tryGetChannel,
  listChannels,
  __resetChannelsForTests,
} from '../../src/channels/registry.js';
import { WhatsAppAdapter } from '../../src/channels/whatsapp/adapter.js';

const EMAIL_ENV = {
  BILLIONMAIL_SMTP_HOST: 'mail.example.test',
  BILLIONMAIL_SMTP_PORT: '587',
  BILLIONMAIL_FROM_ADDRESS: 'noreply@example.test',
  BILLIONMAIL_FROM_NAME: 'Assuryal',
} satisfies NodeJS.ProcessEnv;

describe('registerConfiguredChannels', () => {
  beforeEach(() => {
    __resetChannelsForTests();
  });

  it('registers only whatsapp when WAHA_BASE_URL is set (no email vars)', async () => {
    const env = { WAHA_BASE_URL: 'http://waha.example.test' } satisfies NodeJS.ProcessEnv;

    const result = await registerConfiguredChannels(env);

    expect(result.registered).toEqual(['whatsapp']);
    expect(getChannel('whatsapp')).toBeInstanceOf(WhatsAppAdapter);
    expect(() => getChannel('email')).toThrow(/No channel registered/);
  });

  it('registers only email when BILLIONMAIL_SMTP_* are set (no WAHA)', async () => {
    const result = await registerConfiguredChannels({ ...EMAIL_ENV });

    expect(result.registered).toEqual(['email']);
    expect(tryGetChannel('email')).toBeDefined();
    expect(tryGetChannel('whatsapp')).toBeUndefined();
  });

  it('registers both whatsapp and email when both are configured', async () => {
    const env = { WAHA_BASE_URL: 'http://waha.example.test', ...EMAIL_ENV };

    const result = await registerConfiguredChannels(env);

    expect(result.registered).toEqual(['whatsapp', 'email']);
    expect(
      listChannels()
        .map((c) => c.id)
        .sort(),
    ).toEqual(['email', 'whatsapp']);
  });

  it('registers nothing when neither is configured', async () => {
    const result = await registerConfiguredChannels({});

    expect(result.registered).toEqual([]);
    expect(listChannels()).toHaveLength(0);
  });

  it('is idempotent: calling twice does not throw and does not double-register', async () => {
    const env = { WAHA_BASE_URL: 'http://waha.example.test', ...EMAIL_ENV };

    const first = await registerConfiguredChannels(env);
    expect(first.registered).toEqual(['whatsapp', 'email']);

    // Second call: guards make it a no-op, so nothing is reported as newly
    // registered and the registry still holds exactly one of each.
    const second = await registerConfiguredChannels(env);
    expect(second.registered).toEqual([]);
    expect(listChannels()).toHaveLength(2);
  });
});
