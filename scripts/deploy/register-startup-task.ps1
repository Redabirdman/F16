# F16 M10 V2 — auto-start the voice stack at logon.
#
# Installs a hidden launcher in the user's Startup folder that runs
# start-voice-stack.ps1 at every logon — so backend + Asterisk + tunnel come
# back after a reboot with no manual steps and NO admin rights.
#
#   pwsh -File register-startup-task.ps1            # install / update
#   pwsh -File register-startup-task.ps1 -Remove    # uninstall
#
# (We use the Startup folder rather than Task Scheduler because registering a
#  scheduled task on this machine requires elevation; the Startup folder does
#  not. To use Task Scheduler instead, run an ELEVATED shell and:
#   $a=New-ScheduledTaskAction -Execute (Get-Command pwsh).Source -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
#   Register-ScheduledTask F16VoiceStack -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn) -RunLevel Limited -Force )
param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$dest = Join-Path $startup 'F16VoiceStack.vbs'
$start = Join-Path $PSScriptRoot 'start-voice-stack.ps1'

if ($Remove) {
  if (Test-Path $dest) { Remove-Item $dest -Force }
  Write-Host "Removed logon launcher: $dest"
  return
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }

# A .vbs wrapper runs the PowerShell start script fully hidden (no console flash).
$vbs = @"
' F16 voice stack — auto-start at logon (hidden). Installed by register-startup-task.ps1.
Set s = CreateObject("WScript.Shell")
s.Run "$pwsh -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$start""", 0, False
"@
Set-Content -Path $dest -Value $vbs -Encoding ASCII

Write-Host "Installed logon launcher: $dest"
Write-Host "It runs at logon: $start"
Write-Host "Start now without rebooting:  pwsh -NoProfile -File `"$start`""
Write-Host "Remove with:                  pwsh -File register-startup-task.ps1 -Remove"
