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
