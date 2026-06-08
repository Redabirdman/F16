/* eslint-disable no-console -- standalone env updater. */
/**
 * Idempotently set keys in backend/.env. Values are passed via process env as
 * `SETENV_<KEY>=<value>` so secrets never live in this file or in argv-as-text.
 * Existing keys are replaced in place (no duplicate-shadowing); missing keys
 * are appended.
 *
 *   SETENV_WAHA_API_KEY=xxx npx tsx scripts/update-env.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const path = '.env';
const updates: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('SETENV_') && v !== undefined) updates[k.slice('SETENV_'.length)] = v;
}
if (Object.keys(updates).length === 0) {
  console.error('no SETENV_* vars provided');
  process.exit(1);
}

const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
const lines = content.split(/\r?\n/);
const seen = new Set<string>();
const out = lines.map((line) => {
  const m = line.match(/^([A-Za-z0-9_]+)=/);
  if (m && m[1] && updates[m[1]] !== undefined) {
    seen.add(m[1]);
    return `${m[1]}=${updates[m[1]]}`;
  }
  return line;
});
for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
writeFileSync(path, out.join('\n'));
console.log('updated/added keys:', Object.keys(updates).join(', '));
