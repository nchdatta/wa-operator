# Registers Operator Mode to start at logon in the owner's own Windows session (needed for GUI apps,
# screenshots and the browser). Run from a NORMAL (not elevated) PowerShell in the project folder:
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
param([string]$TaskName = 'WhatsApp Operator Mode', [switch]$Remove)

$ErrorActionPreference = 'Stop'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed '$TaskName'."
  exit 0
}

$project = (Resolve-Path "$PSScriptRoot\..").Path
$node = (Get-Command node).Source
$entry = Join-Path $project 'dist\bin\service.js'
if (-not (Test-Path $entry)) { throw "Build first: npm run build ($entry not found)" }

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $entry + '"') -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
# Limited = no admin rights (Operator Mode refuses to run elevated).
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName' to start at logon. Start it now with: Start-ScheduledTask -TaskName '$TaskName'"

# Keep the PC awake on mains power.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host 'Sleep and hibernate on AC power turned off.'
Write-Host 'Still to do by hand: Autologon (Sysinternals) then lock screen, and power-on after power loss in BIOS. See docs/setup.md.'
