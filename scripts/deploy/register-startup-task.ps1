# F16 M10 V2 — register the voice stack to auto-start at logon (Task Scheduler).
#
# Creates a scheduled task "F16VoiceStack" that runs start-voice-stack.ps1 at
# user logon, so backend + Asterisk + tunnel come back after a reboot without
# manual steps. Run once (normal user is fine; it registers under the current user).
#
#   pwsh -File register-startup-task.ps1            # register / update
#   pwsh -File register-startup-task.ps1 -Remove    # unregister
param([switch]$Remove)

$taskName = 'F16VoiceStack'
$start = Join-Path $PSScriptRoot 'start-voice-stack.ps1'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$taskName'."
  return
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }   # fall back to Windows PowerShell

$action = New-ScheduledTaskAction -Execute $pwsh `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered '$taskName' to run at logon:"
Write-Host "  $pwsh -File `"$start`""
Write-Host "Run now with:  Start-ScheduledTask -TaskName $taskName"
Write-Host "Remove with:   pwsh -File register-startup-task.ps1 -Remove"
