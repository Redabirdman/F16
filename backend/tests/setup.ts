/**
 * Vitest setup — loads `backend/.env` into `process.env` for tests that need
 * secrets (e.g. `ANTHROPIC_API_KEY` for the M3.T5 live LLM tests).
 *
 * Populated env vars win — but EMPTY ones (the parent shell exported the var
 * with no value) are treated as missing so they can be filled from `.env`. The
 * harness sometimes propagates `ANTHROPIC_API_KEY=` with an empty value, which
 * without this rule would mask the real key in `.env`.
 *
 * The .env file is optional. If missing, this setup is a no-op and any test
 * that depends on a particular var should `describe.skipIf(!process.env.X)`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');

if (existsSync(envPath)) {
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present (matches dotenv semantics).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// PROD-DB GUARD (2026-07-03). THIS PC runs the F16 backend as PROD against the
// `f16` database on :5435, and the DB-gated tests TRUNCATE shared tables in
// beforeEach — pointing TEST_DATABASE_URL at prod WIPES REAL DATA (it has now
// bitten the M12, goal-1, ads-admin AND 2026-07-03 dispatcher sessions).
// Only allow database names that are explicitly test-scoped (…_test).
// Create/migrate the throwaway once:
//   docker exec f16-postgres-dev psql -U f16 -d f16 -c "CREATE DATABASE f16_test;"
//   docker exec f16-postgres-dev psql -U f16 -d f16_test -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
//   DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16_test pnpm db:migrate
// then run tests with TEST_DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16_test
if (process.env.TEST_DATABASE_URL) {
  const dbName = new URL(process.env.TEST_DATABASE_URL).pathname.replace(/^\//, '');
  if (!/_test$/.test(dbName)) {
    throw new Error(
      `TEST_DATABASE_URL points at database '${dbName}', which is not a *_test database. ` +
        `On this machine 'f16' is PRODUCTION and the suite TRUNCATEs tables — refusing to run. ` +
        `Use postgres://f16:f16@127.0.0.1:5435/f16_test (see tests/setup.ts for one-time creation).`,
    );
  }
}
