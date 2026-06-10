# F16 M10 V2 + M17 — bring up the whole voice stack on this PC (idempotent).
#
# Starts (only what's not already up):
#   1. WSL Asterisk + a keepalive that holds the distro open (OVH re-registers)
#   2. Backend (Hono) on :3001  (ANTHROPIC_API_KEY cleared per the boot gotcha)
#   3. cloudflared NAMED tunnel "f16" -> backend:3001 at the STABLE hostname
#      https://hooks.assuryalconseil.fr (M17 — set up via cf-tunnel-setup.ts).
#
# Run manually any time, or at logon via register-startup-task.ps1.
#
# ✅ M17: the public URL is now STABLE (https://hooks.assuryalconseil.fr) and
#    NEVER changes across restarts — no more re-registering webhooks. The named
#    tunnel authenticates with CLOUDFLARE_TUNNEL_TOKEN from backend\.env (the
#    remotely-managed tunnel's run-token). If that token is ever rotated, re-run
#    `npx tsx scripts/cf-tunnel-setup.ts` from backend\ to refresh it.
$ErrorActionPreference = 'Continue'
$F16 = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # ...\Assuryal\F16
$backend = Join-Path $F16 'backend'
$cf = Join-Path $F16 '.tools\cloudflared.exe'
$tunnelLog = Join-Path $F16 '.tools\tunnel.log'
$tunnelUrlFile = Join-Path $F16 '.tools\tunnel-url.txt'

function Test-Port($p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

# 1. WSL Asterisk + keepalive (re-registers OVH; holds the distro open).
Write-Host '[1/3] Asterisk (WSL)…'
& wsl.exe -d Ubuntu -u root -- bash -lc 'systemctl start asterisk; sleep 4; asterisk -rx "pjsip show registrations" 2>/dev/null | grep -iE "ovh|Registered" || true'
Start-Process -WindowStyle Hidden -FilePath 'wsl.exe' `
  -ArgumentList '-d','Ubuntu','-u','root','--','bash','-lc','systemctl start asterisk; exec sleep infinity'

# 2. Backend on :3001
if (Test-Port 3001) {
  Write-Host '[2/3] Backend already on :3001 — skipping'
} else {
  Write-Host '[2/3] Starting backend on :3001…'
  $env:ANTHROPIC_API_KEY = $null   # boot gotcha: shell key shadows the .env one
  $env:PORT = '3001'
  # npm ships npx as a .cmd shim on Windows — 'npx.exe' does not exist, so
  # resolve the real shim (reboot gotcha found 2026-06-10).
  $npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue) ?? (Get-Command npx -ErrorAction SilentlyContinue)
  if (-not $npx) {
    Write-Host '  ⚠️  npx not found on PATH — backend NOT started'
  } else {
    Start-Process -WindowStyle Hidden -WorkingDirectory $backend `
      -FilePath $npx.Source -ArgumentList 'tsx','src/index.ts'
  }
}

# 3. cloudflared NAMED tunnel (stable hostname). Token from backend\.env.
$tunnelUp = Get-Process cloudflared -ErrorAction SilentlyContinue
if ($tunnelUp) {
  Write-Host '[3/3] cloudflared already running — skipping (stable: https://hooks.assuryalconseil.fr)'
} else {
  Write-Host '[3/3] Starting cloudflared NAMED tunnel…'
  if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }
  $envFile = Join-Path $backend '.env'
  $tunnelToken = $null
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^CLOUDFLARE_TUNNEL_TOKEN=(.+)$' | Select-Object -First 1
    if ($m) { $tunnelToken = $m.Matches.Groups[1].Value.Trim() }
  }
  if (-not $tunnelToken) {
    Write-Host '  ⚠️  CLOUDFLARE_TUNNEL_TOKEN missing in backend\.env — run: npx tsx scripts/cf-tunnel-setup.ts'
  } else {
    Start-Process -WindowStyle Hidden -FilePath $cf `
      -ArgumentList 'tunnel','run','--token',$tunnelToken `
      -RedirectStandardOutput $tunnelLog -RedirectStandardError "$tunnelLog.err"
    Start-Sleep -Seconds 6
    Set-Content -Path $tunnelUrlFile -Value 'https://hooks.assuryalconseil.fr'
    Write-Host '  Stable URL: https://hooks.assuryalconseil.fr (permanent — webhooks need no re-registration)'
  }
}
Write-Host 'voice stack: up.'
