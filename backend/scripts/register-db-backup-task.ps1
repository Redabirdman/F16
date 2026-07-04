# Registers (idempotently) the "F16 DB Backup" scheduled task: every 6 hours
# starting 03:30, catch-up if a slot was missed while the PC was off. Runs as
# the logged-on user — this prod PC stays logged in (same constraint as the
# voice stack), so no stored password is needed.
#
#   pwsh -File backend/scripts/register-db-backup-task.ps1
$ErrorActionPreference = 'Stop'
$taskName = 'F16 DB Backup'
$wrapper = Join-Path $PSScriptRoot 'run-db-backup.ps1'
$pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwshExe) { $pwshExe = (Get-Command powershell).Source }

$action = New-ScheduledTaskAction -Execute $pwshExe -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""
$start = (Get-Date).Date.AddHours(3).AddMinutes(30)
if ($start -lt (Get-Date)) { $start = $start.AddHours(6 * [Math]::Ceiling(((Get-Date) - $start).TotalHours / 6)) }
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours 6)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "task '$taskName' registered: every 6h from $start, wrapper $wrapper"
