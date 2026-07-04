/* eslint-disable no-console -- standalone ops script (runs under Task Scheduler, logs to file). */
/**
 * F16 prod-DB backup — pg_dump the `f16` database out of the f16-postgres-dev
 * container, encrypt (AES-256-GCM, key = F16_BACKUP_ENC_KEY in .env), keep a
 * rotated local copy, and push off-machine.
 *
 * Off-machine legs (both best-effort; local dump is the hard requirement):
 *   - Cloudflare R2 (bucket F16_R2_BUCKET) via the CF REST API on every run.
 *     Skipped with a WARN while CLOUDFLARE_API_TOKEN lacks R2 permissions —
 *     it activates automatically once a token with "Workers R2 Storage:Edit"
 *     lands in .env (see docs/runbooks/db-backups.md).
 *   - Email to F16_BACKUP_EMAIL_TO via the live Workspace SMTP — OPT-IN ONLY
 *     (set F16_BACKUP_EMAIL_ENABLED=1): shipping PII-bearing dumps by mail is
 *     a deliberate owner decision, not a default. Throttled to one per ~20h.
 *     Subject never matches the devis-inbox DR pattern, so the IMAP relay
 *     ignores these.
 *
 * Local rotation: keep every dump < 48h old, then the newest per day for 14
 * days. R2 rotation: delete objects older than 30 days.
 *
 *   npx tsx scripts/db-backup.ts            # normal run (what the task runs)
 *   npx tsx scripts/db-backup.ts --email    # force the email leg this run
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONTAINER = process.env.F16_PG_CONTAINER ?? 'f16-postgres-dev';
const PG_USER = process.env.F16_PG_USER ?? 'f16';
const PG_DB = process.env.F16_PG_DB ?? 'f16';
const BACKUP_DIR = process.env.F16_BACKUP_DIR ?? join(homedir(), 'F16-backups');
const ENC_KEY_HEX = process.env.F16_BACKUP_ENC_KEY ?? '';
const R2_BUCKET = process.env.F16_R2_BUCKET ?? 'f16-db-backups';
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const EMAIL_TO = process.env.F16_BACKUP_EMAIL_TO ?? 'contact@assuryalconseil.fr';
const EMAIL_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // ~daily, tolerant of schedule jitter
const LOCAL_KEEP_ALL_MS = 48 * 60 * 60 * 1000;
const LOCAL_KEEP_DAILY_DAYS = 14;
const R2_KEEP_DAYS = 30;
const MAGIC = Buffer.from('F16BK1'); // header for encrypted dumps
const FILE_RE = /^f16-(\d{8})-\d{6}\.dump(\.enc)?$/;

const forceEmail = process.argv.includes('--email');
const now = new Date();
const stamp = now
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14)
  .replace(/^(\d{8})/, '$1-');

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  console.log(`${new Date().toISOString()} ${level} ${msg}`);
}

// --- 1. dump -----------------------------------------------------------------
mkdirSync(BACKUP_DIR, { recursive: true });
const dump = execFileSync(
  'docker',
  ['exec', CONTAINER, 'pg_dump', '-U', PG_USER, '-d', PG_DB, '--format=custom', '--compress=9'],
  { maxBuffer: 512 * 1024 * 1024 },
);
if (dump.length < 1024)
  throw new Error(`pg_dump produced only ${dump.length} bytes — refusing to keep it`);
log('INFO', `pg_dump ok: ${dump.length} bytes (custom format, compressed)`);

// --- 2. encrypt + write local ------------------------------------------------
let payload: Buffer;
let fileName: string;
if (ENC_KEY_HEX.length === 64) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY_HEX, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(dump), cipher.final()]);
  payload = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
  fileName = `f16-${stamp}.dump.enc`;
} else {
  log('WARN', 'F16_BACKUP_ENC_KEY missing/invalid (need 64 hex chars) — writing UNENCRYPTED dump');
  payload = dump;
  fileName = `f16-${stamp}.dump`;
}
const filePath = join(BACKUP_DIR, fileName);
writeFileSync(filePath, payload);
log('INFO', `local backup written: ${filePath} (${payload.length} bytes)`);

// --- 3. local rotation ---------------------------------------------------------
const byDay = new Map<string, string[]>();
for (const f of readdirSync(BACKUP_DIR)) {
  const m = FILE_RE.exec(f);
  if (m?.[1]) (byDay.get(m[1]) ?? byDay.set(m[1], []).get(m[1]))?.push(f);
}
const cutoffDay = new Date(now.getTime() - LOCAL_KEEP_DAILY_DAYS * 86400_000)
  .toISOString()
  .slice(0, 10)
  .replace(/-/g, '');
let pruned = 0;
for (const [day, files] of byDay) {
  files.sort();
  const newest = files[files.length - 1];
  for (const f of files) {
    const ageMs = now.getTime() - fileTime(f);
    const keep = ageMs < LOCAL_KEEP_ALL_MS || (f === newest && day >= cutoffDay);
    if (!keep) {
      unlinkSync(join(BACKUP_DIR, f));
      pruned++;
    }
  }
}
if (pruned) log('INFO', `local rotation: pruned ${pruned} old dump(s)`);

function fileTime(f: string): number {
  const m = /^f16-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(f);
  if (!m) return 0;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
}

// --- 4. off-machine: Cloudflare R2 --------------------------------------------
interface CfResp<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}
async function r2<T>(method: string, path: string, body?: Buffer | string): Promise<CfResp<T>> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${CF_TOKEN}`,
        'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
      },
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    },
  );
  return (await res.json()) as CfResp<T>;
}

async function pushToR2(): Promise<boolean> {
  if (!CF_TOKEN || !CF_ACCOUNT) {
    log('WARN', 'R2 leg skipped: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set');
    return false;
  }
  let put = await r2('PUT', `/${R2_BUCKET}/objects/${fileName}`, payload);
  if (
    !put.success &&
    put.errors.some((e) => /bucket.*not found|10006/i.test(`${e.code} ${e.message}`))
  ) {
    const mk = await r2('POST', '', JSON.stringify({ name: R2_BUCKET }));
    if (mk.success) {
      log('INFO', `R2 bucket ${R2_BUCKET} created`);
      put = await r2('PUT', `/${R2_BUCKET}/objects/${fileName}`, payload);
    }
  }
  if (!put.success) {
    const authErr = put.errors.some((e) => e.code === 10000);
    log(
      'WARN',
      authErr
        ? 'R2 leg skipped: CF token lacks R2 permissions — create a token with "Workers R2 Storage:Edit" (see docs/runbooks/db-backups.md §R2)'
        : `R2 upload failed: ${JSON.stringify(put.errors)}`,
    );
    return false;
  }
  log('INFO', `R2 upload ok: r2://${R2_BUCKET}/${fileName}`);
  // Rotation: delete objects older than R2_KEEP_DAYS (timestamp lives in the key).
  const list = await r2<Array<{ key?: string; name?: string }>>(
    'GET',
    `/${R2_BUCKET}/objects?per_page=500`,
  );
  if (list.success) {
    const cutoff = now.getTime() - R2_KEEP_DAYS * 86400_000;
    for (const o of list.result ?? []) {
      const key = o.key ?? o.name ?? '';
      if (FILE_RE.test(key) && fileTime(key) > 0 && fileTime(key) < cutoff) {
        await r2('DELETE', `/${R2_BUCKET}/objects/${key}`);
        log('INFO', `R2 rotation: deleted ${key}`);
      }
    }
  }
  return true;
}

// --- 5. off-machine: email (daily throttle) ------------------------------------
const statePath = join(BACKUP_DIR, 'state.json');
function readState(): { lastEmailAt?: string } {
  try {
    return existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, 'utf8')) as { lastEmailAt?: string })
      : {};
  } catch {
    return {};
  }
}

async function pushByEmail(): Promise<boolean> {
  if (process.env.F16_BACKUP_EMAIL_ENABLED !== '1') {
    log('INFO', 'email leg: disabled (opt in with F16_BACKUP_EMAIL_ENABLED=1)');
    return false;
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    log('WARN', 'email leg skipped: SMTP_* not configured');
    return false;
  }
  const state = readState();
  const last = state.lastEmailAt ? Date.parse(state.lastEmailAt) : 0;
  if (!forceEmail && now.getTime() - last < EMAIL_MIN_INTERVAL_MS) {
    log('INFO', `email leg: throttled (last sent ${state.lastEmailAt})`);
    return false;
  }
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: `"F16 backups" <${SMTP_USER}>`,
    to: EMAIL_TO,
    subject: `[F16 backup] ${fileName} (${Math.round(payload.length / 1024)} KiB)`,
    text: [
      `Automated encrypted backup of the f16 prod database.`,
      `File: ${fileName}`,
      `Restore: cd backend && npx tsx scripts/db-restore.ts <file>  (docs/runbooks/db-backups.md)`,
      `Requires F16_BACKUP_ENC_KEY to decrypt.`,
    ].join('\n'),
    attachments: [{ filename: fileName, content: payload }],
  });
  writeFileSync(statePath, JSON.stringify({ ...state, lastEmailAt: now.toISOString() }, null, 2));
  log('INFO', `email off-site ok: sent ${fileName} to ${EMAIL_TO}`);
  return true;
}

// --- run legs ------------------------------------------------------------------
const [r2Ok, emailOk] = [
  await pushToR2().catch(fail('R2')),
  await pushByEmail().catch(fail('email')),
];
function fail(leg: string) {
  return (err: unknown): boolean => {
    log('WARN', `${leg} leg errored: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  };
}
log(
  'INFO',
  `backup complete — local: ok, r2: ${r2Ok ? 'ok' : 'skipped/failed'}, email: ${emailOk ? 'sent' : 'skipped'}`,
);
