# F16 backend keepalive (2026-07-05 audit — "a dead process 502s the admin").
#
# Runs every minute via the Task Scheduler job "F16 Backend Keepalive"
# (scripts/install-backend-keepalive.ps1). Probes /metrics; when the backend
# is unreachable it clears any zombie tsx process and relaunches the backend
# detached — same recipe the operators use by hand.
#
# Pause during maintenance: create backend/var/keepalive.pause (the probe is
# skipped while the file exists) — delete it to resume.
#
# The relaunched process logs to var/backend.keepalive-run.log (NOT
# var/backend.log) so a keepalive restart never clobbers the primary log a
# human/agent session is tailing.

$ErrorActionPreference = 'SilentlyContinue'
$backendDir = Split-Path -Parent $PSScriptRoot
$varDir = Join-Path $backendDir 'var'
$logFile = Join-Path $varDir 'keepalive.log'
$pauseFile = Join-Path $varDir 'keepalive.pause'

function Write-KeepaliveLog([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line
}

if (Test-Path $pauseFile) {
  # Maintenance in progress — stay out of the way.
  exit 0
}

try {
  $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/metrics' -TimeoutSec 5 -UseBasicParsing
  if ($resp.StatusCode -eq 200) { exit 0 }
} catch {
  # fall through to restart
}

Write-KeepaliveLog 'backend unreachable — restarting'

# Clear zombies (port may be held by a wedged process).
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'src/index\.ts' } |
  ForEach-Object {
    Write-KeepaliveLog "killing pid $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 2

Start-Process npx.cmd -ArgumentList 'tsx', 'src/index.ts' `
  -WorkingDirectory $backendDir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $varDir 'backend.keepalive-run.log') `
  -RedirectStandardError (Join-Path $varDir 'backend.keepalive-run.err.log') `
  -Environment @{ PORT = '3001' }

Start-Sleep -Seconds 15
try {
  $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/metrics' -TimeoutSec 5 -UseBasicParsing
  if ($resp.StatusCode -eq 200) {
    Write-KeepaliveLog 'restart OK — backend answering'
    exit 0
  }
} catch {}
Write-KeepaliveLog 'restart attempted but backend still unreachable (will retry next tick)'
