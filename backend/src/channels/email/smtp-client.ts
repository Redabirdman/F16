/**
 * BillionMail SMTP client wrapper (M4.T4).
 *
 * Thin layer over nodemailer. BillionMail (https://github.com/aaPanel/BillionMail)
 * is a self-hosted email server speaking standard SMTP, so the adapter just
 * needs a verified `Transporter`. Production: `mail.assuryalconseil.fr` on 587
 * (STARTTLS). Dev: `localhost:1025` (mailhog/mailpit, no TLS, no auth).
 *
 * The factory accepts an `EmailTransportLike` interface so tests can inject a
 * stub without spinning up nodemailer (see tests/channels/email/adapter.test.ts).
 *
 * PII discipline (§9 — Security):
 *   - NEVER log the recipient address, subject, or body.
 *   - Errors NEVER echo `to`/`subject`/`text`/`html`. Logs only structural
 *     facts: `{ status, messageId }`.
 */
import nodemailer from 'nodemailer';
import type { Transporter, SendMailOptions, SentMessageInfo } from 'nodemailer';
import { logger } from '../../logger.js';

/**
 * Minimal surface of nodemailer's `Transporter` that we depend on. Both the
 * real nodemailer transporter and the test stub satisfy this.
 */
export interface EmailTransportLike {
  sendMail(opts: SendMailOptions): Promise<SentMessageInfo>;
  verify(): Promise<true>;
}

/** Connection config read from SMTP_* env vars (BILLIONMAIL_* accepted for back-compat). */
export interface SmtpConfig {
  host: string;
  port: number;
  /** STARTTLS (587) → false + requireTLS=true; SMTPS (465) → secure=true. */
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  fromAddress: string;
  fromName: string;
}

/**
 * Pull SMTP config from environment. Throws if required vars are missing —
 * callers should guard with `try/catch` or check at startup, not per-send.
 */
export function loadSmtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  // Provider-agnostic SMTP_* env, with back-compat fallback to the original
  // BILLIONMAIL_* names. Works with any SMTP server — Gmail / Google Workspace
  // (smtp.gmail.com:587 + App Password), a self-hosted relay, or dev mailpit.
  const host = env.SMTP_HOST ?? env.BILLIONMAIL_SMTP_HOST;
  const portRaw = env.SMTP_PORT ?? env.BILLIONMAIL_SMTP_PORT;
  const fromAddress = env.SMTP_FROM_ADDRESS ?? env.BILLIONMAIL_FROM_ADDRESS;
  const fromName = env.SMTP_FROM_NAME ?? env.BILLIONMAIL_FROM_NAME;
  if (!host) throw new Error('SMTP_HOST is required');
  if (!portRaw) throw new Error('SMTP_PORT is required');
  if (!fromAddress) throw new Error('SMTP_FROM_ADDRESS is required');
  if (!fromName) throw new Error('SMTP_FROM_NAME is required');
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`SMTP_PORT is not a valid port: ${portRaw}`);
  }
  return {
    host,
    port,
    // SMTPS = 465 (implicit TLS); everything else negotiates with STARTTLS or
    // runs plaintext (dev mailpit on 1025).
    secure: port === 465,
    user: env.SMTP_USER ?? env.BILLIONMAIL_SMTP_USER,
    pass: env.SMTP_PASS ?? env.BILLIONMAIL_SMTP_PASS,
    fromAddress,
    fromName,
  };
}

export interface CreateTransportOptions {
  config: SmtpConfig;
  /** Whether to call `verify()` after construction. Default true. */
  verifyOnCreate?: boolean;
}

/**
 * Construct a nodemailer transporter from SmtpConfig and (by default) verify
 * the SMTP connection. Returns the typed `EmailTransportLike` so adapters
 * stay decoupled from nodemailer's full surface.
 */
export async function createTransport(opts: CreateTransportOptions): Promise<EmailTransportLike> {
  const { config } = opts;
  const verifyOnCreate = opts.verifyOnCreate ?? true;
  const transporter: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // STARTTLS upgrade on 587. Dev mailhog (1025) doesn't speak TLS at all.
    requireTLS: !config.secure && config.port === 587,
    ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
  });
  if (verifyOnCreate) {
    await transporter.verify();
  }
  return transporter satisfies EmailTransportLike;
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: SendMailOptions['attachments'];
  /** Optional Reply-To header. */
  replyTo?: string;
  /**
   * Optional `In-Reply-To` Message-Id for threading (RFC-5322 §3.6.4).
   * Pass without surrounding `<>` — nodemailer adds them.
   */
  inReplyTo?: string;
  /** Extra headers (rare; e.g. List-Unsubscribe in M11). */
  headers?: SendMailOptions['headers'];
}

export interface SendEmailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

/**
 * Send one email via the supplied transport. Returns a normalized result with
 * just the fields F16 cares about (no nodemailer internals leak out).
 *
 * PII protection: on failure we log only `{ status: 'failed', code }` — never
 * the recipient, subject, or body. The thrown error carries the same minimal
 * info so it's safe to surface to callers without scrubbing.
 */
export async function sendEmail(
  transport: EmailTransportLike,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  try {
    const info = await transport.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.inReplyTo } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
    });
    const accepted = (info.accepted ?? []).map(addrToString);
    const rejected = (info.rejected ?? []).map(addrToString);
    // Log only structural facts (no PII).
    logger.info(
      { status: 'sent', messageId: info.messageId, accepted: accepted.length },
      'email: sent',
    );
    return {
      messageId: info.messageId ?? '',
      accepted,
      rejected,
      response: info.response ?? '',
    };
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err ? (err as { code?: unknown }).code : undefined;
    logger.warn({ status: 'failed', code }, 'email: send failed');
    // Re-throw a sanitized error — never echo recipient/subject/body.
    const detail = err instanceof Error ? err.message : String(err);
    const safeDetail = stripPotentialPii(detail, input);
    throw new Error(`email send failed: ${safeDetail}`);
  }
}

/** Coerce nodemailer's `Address | string` accepted/rejected entries to plain strings. */
function addrToString(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && 'address' in a) {
    return String((a as { address: unknown }).address);
  }
  return String(a);
}

/**
 * Best-effort scrub of any echoed PII (recipient address, subject text, body
 * substrings) from an upstream error message. nodemailer/SMTP rarely echo
 * these, but we'd rather be safe — agents log these errors into the audit
 * trail.
 */
function stripPotentialPii(message: string, input: SendEmailInput): string {
  let out = message;
  if (input.to) out = out.split(input.to).join('[recipient]');
  if (input.subject) out = out.split(input.subject).join('[subject]');
  if (input.text) {
    // Only strip the first ~200 chars of the body — long bodies probably
    // aren't being echoed verbatim, and full replacement is expensive.
    const snip = input.text.slice(0, 200);
    if (snip.length > 0) out = out.split(snip).join('[body]');
  }
  return out;
}
