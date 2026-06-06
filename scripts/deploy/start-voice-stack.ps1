# F16 M10 V2 — bring up the whole voice stack on this PC (idempotent).
#
# Starts (only what's not already up):
#   1. WSL Asterisk + a keepalive that holds the distro open (OVH re-registers)
#   2. Backend (Hono) on :3001  (ANTHROPIC_API_KEY cleared per the boot gotcha)
#   3. cloudflared quick tunnel -> backend:3001  (URL captured to .tools\tunnel-url.txt)
#
# Run manually any time, or at logon via register-startup-task.ps1.
#
# ⚠️ The quick-tunnel URL is RANDOM each start. Until a STABLE tunnel is set up
#    (needs a Cloudflare-managed domain), after every (re)start you must
#    re-register the printed URL + "/v1/voice/openai-webhook" in the OpenAI
#    dashboard webhook. The URL is written to .tools\tunnel-url.txt.
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
  Start-Process -WindowStyle Hidden -WorkingDirectory $backend `
    -FilePath 'npx.exe' -ArgumentList 'tsx','src/index.ts'
}

# 3. cloudflared quick tunnel
$tunnelUp = Get-Process cloudflared -ErrorAction SilentlyContinue
if ($tunnelUp) {
  Write-Host '[3/3] cloudflared already running — skipping (URL in tunnel-url.txt)'
} else {
  Write-Host '[3/3] Starting cloudflared tunnel…'
  if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }
  Start-Process -WindowStyle Hidden -FilePath $cf `
    -ArgumentList 'tunnel','--url','http://localhost:3001','--no-autoupdate' `
    -RedirectStandardOutput $tunnelLog -RedirectStandardError "$tunnelLog.err"
  Start-Sleep -Seconds 8
  $url = (Select-String -Path "$tunnelLog.err",$tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1).Matches.Value
  if ($url) {
    Set-Content -Path $tunnelUrlFile -Value $url
    Write-Host ''
    Write-Host "  Tunnel URL: $url"
    Write-Host "  ⚠️  Register this in OpenAI webhooks: $url/v1/voice/openai-webhook"
  } else {
    Write-Host '  (tunnel URL not captured yet — check .tools\tunnel.log)'
  }
}
Write-Host 'voice stack: up.'
