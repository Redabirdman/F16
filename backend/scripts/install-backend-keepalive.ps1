# Registers the "F16 Backend Keepalive" scheduled task (2026-07-05).
# Runs backend-keepalive.ps1 every minute + at logon, as the current user,
# hidden. Same pattern as the "F16 DB Backup" task. Re-running this script
# replaces the existing task (idempotent install).

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'backend-keepalive.ps1'
$taskName = 'F16 Backend Keepalive'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

# Every minute, indefinitely, starting now; plus at logon.
# NB: [TimeSpan]::MaxValue is rejected by the task XML schema — use 10 years.
# NB: an AtLogOn trigger requires elevation to register — the 1-minute
# repetition + StartWhenAvailable already covers reboots (missed runs fire
# as soon as the box is back), so we run un-elevated without it.
$trigger1 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger1 `
  -Settings $settings -Description 'Restarts the F16 backend on :3001 when /metrics stops answering. Pause: create backend/var/keepalive.pause.'

Write-Output "Registered task '$taskName' (every 1 min, resumes after reboot via StartWhenAvailable)."
