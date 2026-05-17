/**
 * Drizzle client for @f16/backend.
 *
 * Two entry points:
 *   - `createDb(url)` — factory that builds a fresh client (use in tests / per-tenant pools).
 *   - `db()`          — lazy process-wide singleton built from DATABASE_URL (use in app code).
 *
 * Lazy init is intentional: importing this module must not require DATABASE_URL,
 * so tests can stub the env and tooling (drizzle-kit) can import the schema barrel
 * without booting a connection.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';
import { logger } from '../logger.js';

export type Database = ReturnType<typeof createDb>;

export function createDb(connectionString: string): ReturnType<typeof drizzle<typeof schema>> {
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: (notice) => logger.debug({ notice }, 'pg notice'),
  });
  return drizzle(client, { schema, logger: false });
}

// Lazy singleton — only created when first imported with env set.
let _db: Database | null = null;

export function db(): Database {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    _db = createDb(url);
  }
  return _db;
}

/**
 * Test-only escape hatch — clears the cached singleton so a test that mutates
 * DATABASE_URL gets a fresh init path. Not part of the public API; do not call
 * from application code.
 */
export function __resetDbForTests(): void {
  _db = null;
}
