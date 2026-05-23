/**
 * Shared pino logger for @f16/backend.
 *
 * Dev: pretty-printed via pino-pretty.
 * Prod: raw JSON lines (cheap to parse by log shippers).
 *
 * LOG_LEVEL overrides the default (info in prod, debug otherwise).
 *
 * PII redaction (option C / Compliance Sentry V0): pino's built-in `redact`
 * masks well-known PII field paths so the obvious mistakes (logging
 * `{ email, phone }`) don't leak plaintext. Free-form string values inside
 * other keys are NOT scanned here — that's the caller's responsibility
 * (use `redactPII()` from compliance/pii-redact.ts before passing into
 * logger.info). Pino's structured-field scan is the cheap safety net.
 */
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Field paths pino will mask. The leaf paths are the ones agents have
 * historically (almost-)leaked. Wildcards apply per-key — `*.email` masks
 * `payload.email`, `customer.email`, `subscriber.email` in one rule.
 */
const REDACT_PATHS = [
  // Direct fields.
  'email',
  'phone',
  'iban',
  'fullName',
  'firstName',
  'lastName',
  'pdfSentTo',
  // Common one-level nesting from our intents.
  '*.email',
  '*.phone',
  '*.iban',
  '*.fullName',
  '*.firstName',
  '*.lastName',
  '*.pdfSentTo',
  // Two-level (payload.subscriber.email etc.).
  '*.*.email',
  '*.*.phone',
  '*.*.iban',
  '*.*.fullName',
  '*.*.firstName',
  '*.*.lastName',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  base: { service: 'f16-backend' },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});
