# Maxance browser launcher (one-time + on-reboot use).
#
# Two profile modes:
#   * default  — DEDICATED profile under stagehand/data/maxance-chrome-profile/.
#                User's daily Chrome stays untouched. Requires one-time Maxance
#                login (SMS MFA) inside the dedicated profile.
#   * -Shared  — REUSES the user's daily Chrome profile (Default). Skips the
#                one-time login because Maxance is already logged in. Trade-off:
#                user must close their daily Chrome before launching this
#                (Chrome only allows one instance per user-data-dir).
#
# Both modes launch real Chrome (same binary as daily browsing) with the
# Chrome DevTools Protocol port open on 127.0.0.1:9222.
#
# Why CDP attach (not Playwright launching its own Chromium):
#   - Real Chrome BINARY → fingerprint matches a real user (User-Agent, JS
#     quirks, GPU stack). Cloudflare treats it kindly.
#   - Residential IP → high trust signal.
#   - Attach via CDP (vs Playwright's own launch) avoids the "Playwright spawned
#     this Chrome" automation tell that triggers Cloudflare Turnstile.
#
# Usage:
#   Dedicated profile (default):
#     pwsh -File stagehand\scripts\start-maxance-chrome.ps1
#   Shared with daily Chrome (close daily Chrome first):
#     pwsh -File stagehand\scripts\start-maxance-chrome.ps1 -Shared
#
# Future (V1 hardware): same script runs at boot on the dedicated mini-PC,
# always in DEDICATED mode.

[CmdletBinding()]
param(
    # When set, reuse the user's daily Chrome profile (Default) so existing
    # Maxance + Cloudflare cookies are inherited. Requires closing daily Chrome.
    [switch]$Shared
)

$ErrorActionPreference = 'Stop'

# Resolve paths relative to the repo. The script lives at stagehand/scripts/,
# so the repo root for our purposes is two levels up.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$stagehandRoot = Split-Path -Parent $scriptDir
$dedicatedProfileDir = Join-Path $stagehandRoot 'data\maxance-chrome-profile'
$sharedProfileDir = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$profileDir = if ($Shared) { $sharedProfileDir } else { $dedicatedProfileDir }
$cdpPort = 9222

# Locate chrome.exe via the Windows registry first (per-user install is most
# common), then fall back to the canonical Program Files paths.
function Find-ChromeExe {
    $candidates = @(
        (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
        (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    throw "Could not locate chrome.exe. Install Google Chrome or set CHROME_EXE env var."
}

$chromeExe = if ($env:CHROME_EXE) { $env:CHROME_EXE } else { Find-ChromeExe }

if ($Shared) {
    # Shared mode: reusing the user's daily profile means Chrome must not be
    # currently running with that profile (Chrome enforces one-instance-per-
    # user-data-dir). Detect & abort cleanly so we don't corrupt the lock.
    $runningOnProfile = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like '*chrome*' -and $_.CommandLine -and $_.CommandLine -notlike "*--remote-debugging-port=$cdpPort*"
    }
    if ($runningOnProfile) {
        Write-Host ""
        Write-Host "Daily Chrome is currently running and would conflict with shared-profile mode." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Please close ALL Chrome windows (right-click taskbar -> Close window, or" -ForegroundColor Yellow
        Write-Host "Ctrl+Shift+Q inside Chrome) and re-run this script." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Tip: Chrome's 'Continue where you left off' setting will restore your tabs" -ForegroundColor DarkGray
        Write-Host "after this script reopens Chrome." -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
} else {
    # Dedicated-mode: just make sure the profile dir exists.
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
}

# Refuse to launch if port 9222 is already in use — that would silently end up
# attaching the next CDP client to the wrong Chrome, or chrome would pick a
# random fallback port and our agent wouldn't know about it.
$existing = try { Get-NetTCPConnection -LocalPort $cdpPort -State Listen -ErrorAction Stop } catch { $null }
if ($existing) {
    Write-Host ""
    Write-Host "Port $cdpPort is already in use. Either:" -ForegroundColor Yellow
    Write-Host "  - A Chrome with CDP is already running (you can keep using it)" -ForegroundColor Yellow
    Write-Host "  - Some other process holds the port (close it first)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Existing listener PID: $($existing.OwningProcess)" -ForegroundColor Yellow
    Write-Host "Run 'Stop-Process -Id $($existing.OwningProcess) -Force' to free the port if needed." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
$modeLabel = if ($Shared) { 'SHARED (daily Chrome profile)' } else { 'DEDICATED (isolated profile)' }
Write-Host "Launching Chrome for Maxance automation..." -ForegroundColor Cyan
Write-Host "  Mode          : $modeLabel"
Write-Host "  Chrome binary : $chromeExe"
Write-Host "  Profile dir   : $profileDir"
Write-Host "  CDP endpoint  : http://127.0.0.1:$cdpPort"
Write-Host ""
if ($Shared) {
    Write-Host "Daily-Chrome cookies (incl. existing Maxance login + Cloudflare clearance)" -ForegroundColor Green
    Write-Host "are now available to the agent. Use Chrome normally — agent will open its" -ForegroundColor Green
    Write-Host "own tab when needed." -ForegroundColor Green
} else {
    Write-Host "First run: log into Maxance, do the SMS MFA once, tick the 30-day box." -ForegroundColor Green
    Write-Host "Subsequent launches: the cookie keeps you signed in for ~30 days." -ForegroundColor Green
}
Write-Host ""

# Launch Chrome. We DON'T use Start-Process -Wait because we want the script
# to return immediately and leave Chrome running in the foreground. The user
# closes Chrome to stop it.
$chromeArgs = @(
    "--remote-debugging-port=$cdpPort",
    "--user-data-dir=$profileDir",
    # Suppress the "Chrome is being controlled by automated software" banner
    # at the top of the window. Doesn't strip CDP — just hides the bar.
    "--disable-blink-features=AutomationControlled",
    # Skip the first-run welcome wizard (dedicated mode only — shared profile
    # already passed first run).
    "--no-first-run",
    "--no-default-browser-check"
)
if ($Shared) {
    # Explicitly select the Default profile (the one with the user's daily
    # cookies + bookmarks + history). Chrome would do this implicitly without
    # the flag, but being explicit avoids surprises if the user has multiple
    # profiles configured.
    $chromeArgs += "--profile-directory=Default"
}
# Land on Maxance immediately so the user can verify they're logged in.
$chromeArgs += "https://extranet.maxance.com/MaXance/"

Start-Process -FilePath $chromeExe -ArgumentList $chromeArgs | Out-Null

Write-Host "Chrome launched. Wait a few seconds, then verify CDP is up:" -ForegroundColor Cyan
Write-Host "  curl http://127.0.0.1:$cdpPort/json/version" -ForegroundColor DarkGray
Write-Host ""
