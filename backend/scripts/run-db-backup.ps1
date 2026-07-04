# Task Scheduler entrypoint for the F16 DB backup (registered by
# register-db-backup-task.ps1). Runs db-backup.ts from the backend package and
# appends stdout/stderr to %USERPROFILE%\F16-backups\backup.log.
$ErrorActionPreference = 'Continue'
$backend = Split-Path -Parent $PSScriptRoot          # backend/scripts -> backend
$logDir = if ($env:F16_BACKUP_DIR) { $env:F16_BACKUP_DIR } else { Join-Path $env:USERPROFILE 'F16-backups' }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'backup.log'

$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $npx) { $npx = Join-Path $env:ProgramFiles 'nodejs\npx.cmd' }

Set-Location $backend
"=== backup run $(Get-Date -Format o) ===" | Add-Content $log
& $npx tsx scripts/db-backup.ts *>> $log
"=== exit $LASTEXITCODE ===" | Add-Content $log
exit $LASTEXITCODE
