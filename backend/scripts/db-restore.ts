/* eslint-disable no-console -- standalone ops script. */
/**
 * F16 prod-DB restore — one command, from a local backup file produced by
 * scripts/db-backup.ts (encrypted `.dump.enc` or plain `.dump`).
 *
 * By default restores into a SCRATCH database (f16_restore_verify) so you can
 * inspect the data risk-free, and prints per-table row counts as verification.
 * Restoring over the real `f16` database requires BOTH --prod and --force.
 *
 *   npx tsx scripts/db-restore.ts latest                 # newest local dump -> scratch db
 *   npx tsx scripts/db-restore.ts <path-to-dump>         # specific file    -> scratch db
 *   npx tsx scripts/db-restore.ts latest --db my_check   # custom target db
 *   npx tsx scripts/db-restore.ts latest --prod --force  # OVERWRITE prod f16 (stop backend first!)
 *
 * Needs F16_BACKUP_ENC_KEY in .env for .enc files. Dumps that only exist in
 * R2/email must be downloaded into the backup dir first (they are plain files).
 */
import 'dotenv/config';
import { execFileSync, spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONTAINER = process.env.F16_PG_CONTAINER ?? 'f16-postgres-dev';
const PG_USER = process.env.F16_PG_USER ?? 'f16';
const PROD_DB = process.env.F16_PG_DB ?? 'f16';
const BACKUP_DIR = process.env.F16_BACKUP_DIR ?? join(homedir(), 'F16-backups');
const ENC_KEY_HEX = process.env.F16_BACKUP_ENC_KEY ?? '';
const MAGIC = Buffer.from('F16BK1');
const FILE_RE = /^f16-\d{8}-\d{6}\.dump(\.enc)?$/;

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const source = positional[0];
if (!source) {
  console.error(
    'usage: npx tsx scripts/db-restore.ts <latest|path-to-dump> [--db <name>] [--prod --force]',
  );
  process.exit(1);
}
const target = flag('prod') ? PROD_DB : (opt('db') ?? 'f16_restore_verify');
if (flag('prod') && !flag('force')) {
  console.error(
    `REFUSED: restoring over prod '${PROD_DB}' overwrites live data. Re-run with --prod --force`,
  );
  console.error('(and stop the backend first so nothing writes mid-restore).');
  process.exit(1);
}

// --- resolve + decrypt the dump -------------------------------------------------
let filePath = source;
if (source === 'latest') {
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => FILE_RE.test(f))
    .sort();
  const newest = files[files.length - 1];
  if (!newest) throw new Error(`no backups found in ${BACKUP_DIR}`);
  filePath = join(BACKUP_DIR, newest);
}
const raw = readFileSync(filePath);
let dump: Buffer;
if (raw.subarray(0, MAGIC.length).equals(MAGIC)) {
  if (ENC_KEY_HEX.length !== 64)
    throw new Error('encrypted dump but F16_BACKUP_ENC_KEY missing/invalid in .env');
  const iv = raw.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(ENC_KEY_HEX, 'hex'), iv);
  decipher.setAuthTag(tag);
  dump = Buffer.concat([decipher.update(raw.subarray(MAGIC.length + 28)), decipher.final()]);
  console.log(`decrypted ${filePath}: ${dump.length} bytes`);
} else {
  dump = raw;
  console.log(`plain dump ${filePath}: ${dump.length} bytes`);
}

// --- recreate target db + restore ------------------------------------------------
function psql(db: string, sql: string): string {
  return execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', PG_USER, '-d', db, '-tAc', sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

if (target === PROD_DB) {
  console.log(`!!! overwriting prod database '${PROD_DB}' from ${filePath}`);
  psql(
    'postgres',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PROD_DB}' AND pid <> pg_backend_pid()`,
  );
}
psql('postgres', `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
psql('postgres', `CREATE DATABASE "${target}" OWNER "${PG_USER}"`);
console.log(`database '${target}' recreated, restoring...`);

const res = spawnSync(
  'docker',
  [
    'exec',
    '-i',
    CONTAINER,
    'pg_restore',
    '-U',
    PG_USER,
    '-d',
    target,
    '--no-owner',
    '--exit-on-error',
  ],
  { input: dump, maxBuffer: 512 * 1024 * 1024 },
);
if (res.status !== 0) {
  console.error(res.stderr?.toString() ?? '');
  throw new Error(`pg_restore exited ${res.status}`);
}
console.log('pg_restore ok');

// --- verify: per-table row counts -------------------------------------------------
const tables = psql(
  target,
  `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
)
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean);
console.log(`\nverification — ${tables.length} tables in '${target}':`);
for (const t of tables) {
  const n = psql(target, `SELECT count(*) FROM "${t}"`).trim();
  console.log(`  ${t.padEnd(40)} ${n} rows`);
}
console.log(
  target === PROD_DB
    ? '\nPROD RESTORED — restart the backend now.'
    : `\nscratch restore complete. Inspect via adminer (localhost:8081) or drop it with:\n  docker exec ${CONTAINER} psql -U ${PG_USER} -d postgres -c 'DROP DATABASE ${target}'`,
);
