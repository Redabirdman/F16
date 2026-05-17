/**
 * Shared pino logger for @f16/backend.
 *
 * Dev: pretty-printed via pino-pretty.
 * Prod: raw JSON lines (cheap to parse by log shippers).
 *
 * LOG_LEVEL overrides the default (info in prod, debug otherwise).
 */
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  base: { service: 'f16-backend' },
  ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});
