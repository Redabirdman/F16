# F16 prod-DB backups & restore

Prod Postgres = docker `f16-postgres-dev` (host port 5435, db/user `f16`) on the
office PC. Backups exist because on 2026-07-03 a test-suite mistake truncated
the prod database with **zero** recovery options.

## What runs

| Piece                | What                                                                                                                                   | Where                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dump                 | `pg_dump -Fc` inside the container, AES-256-GCM-encrypted (`F16_BACKUP_ENC_KEY` in `backend/.env`)                                     | [backend/scripts/db-backup.ts](../../backend/scripts/db-backup.ts)                                                                                                              |
| Schedule             | Windows Task Scheduler task **"F16 DB Backup"**, every 6 h from 03:30, catch-up on missed slots (RPO ≤ 6 h)                            | registered by [backend/scripts/register-db-backup-task.ps1](../../backend/scripts/register-db-backup-task.ps1) via [run-db-backup.ps1](../../backend/scripts/run-db-backup.ps1) |
| Local copies         | `%USERPROFILE%\F16-backups\f16-YYYYMMDD-HHMMSS.dump.enc` + `backup.log` — keep all < 48 h, then newest/day for 14 days                 | rotation inside db-backup.ts                                                                                                                                                    |
| Off-machine          | Cloudflare R2 bucket `f16-db-backups` on every run (30-day rotation)                                                                   | needs an R2-capable token, see §R2                                                                                                                                              |
| Off-machine (opt-in) | Daily encrypted dump emailed to `contact@assuryalconseil.fr` — only if `F16_BACKUP_EMAIL_ENABLED=1` (PII-by-mail is an owner decision) | email leg in db-backup.ts                                                                                                                                                       |

Run one manually: `cd backend && npx tsx scripts/db-backup.ts`

## Restore (one command)

```bash
cd backend
npx tsx scripts/db-restore.ts latest              # -> scratch db f16_restore_verify + row counts
npx tsx scripts/db-restore.ts latest --prod --force   # OVERWRITE prod f16 (stop backend first!)
```

- `latest` picks the newest file in `%USERPROFILE%\F16-backups`; a path works too
  (download from R2/email into that dir first — same file format).
- Decryption needs `F16_BACKUP_ENC_KEY` in `backend/.env`. **If this PC dies the
  key dies with it** — it must also live in Ridaa's password manager.
- Prod restore: stop the backend, run with `--prod --force`, restart the backend.
  The script terminates connections, drops and recreates `f16`, restores, and
  prints per-table row counts.
- Verified end-to-end 2026-07-03: backup → decrypt → scratch restore → row counts
  matched prod exactly (19 tables).
- Roles/extensions are recreated by `infra/docker-compose.dev.yml` +
  `infra/postgres/init.sql` if the container itself is lost — restore assumes a
  healthy container (`docker compose -f infra/docker-compose.dev.yml up -d`).

## §R2 — activating the off-machine leg (one manual step)

The CLOUDFLARE_API_TOKEN in `backend/.env` (verified 2026-07-03) has **no R2
permissions** and cannot mint tokens, so this needs one dashboard action:

1. dash.cloudflare.com → account `89eba934…` → R2 (accept the free plan if not
   yet enabled) — no need to create the bucket, the script creates it.
2. Create an API token with **Workers R2 Storage: Edit** (account-scoped).
3. Store it (never paste secrets into files/argv):
   `cd backend && SETENV_CLOUDFLARE_API_TOKEN=<token> npx tsx scripts/update-env.ts`
   — or keep the current token and add the R2 permission to it in the dashboard.
4. Next scheduled run uploads automatically; check `%USERPROFILE%\F16-backups\backup.log`
   for `R2 upload ok`.

Note: replacing CLOUDFLARE*API_TOKEN affects the other CF scripts (tunnel, WAF,
DNS) — simplest is editing the existing token's permissions to \_add* R2 Edit.

## WAL / point-in-time recovery — assessed, not enabled

`archive_mode=on` would need a host-mounted archive dir (container recreate),
weekly `pg_basebackup` discipline, and a much hairier restore path. For a ~10 MB
database the 6-hourly dump cadence (RPO ≤ 6 h, near-zero complexity) is the
better trade. Revisit if the DB grows past a few GB or the business needs RPO
in minutes.

## Monitoring

- `Get-ScheduledTaskInfo 'F16 DB Backup'` — LastTaskResult 0 = ok.
- `%USERPROFILE%\F16-backups\backup.log` — one `backup complete` line per run.
- The task runs as the logged-on user (this prod PC stays logged in, same
  constraint as the voice stack). If the machine is ever run logged-out, re-register
  the task with stored credentials.
