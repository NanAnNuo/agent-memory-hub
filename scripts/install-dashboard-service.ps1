[CmdletBinding()]
param(
    [string]$HubRoot,
    [string]$TaskName = 'Agent Memory Hub Dashboard',
    [int]$Port = 43121,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($HubRoot)) {
    $HubRoot = Split-Path -Parent $PSScriptRoot
}
$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $HubRoot 'scripts\start-agent-memory-hub.ps1'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "Launcher missing: $entry."
}

$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$entry`" -NoBrowser"
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe -ErrorAction Stop).Source -Argument $argument -WorkingDirectory $HubRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps Agent Memory Hub available through a localhost dashboard.' -Force | Out-Null

$alreadyListening = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $alreadyListening) {
    Start-ScheduledTask -TaskName $TaskName
}

$tokenPath = Join-Path $HOME '.memory-hub\dashboard.token'
for ($index = 0; $index -lt 20 -and -not (Test-Path -LiteralPath $tokenPath); $index++) {
    Start-Sleep -Milliseconds 250
}
if (-not (Test-Path -LiteralPath $tokenPath)) {
    throw "Dashboard started but access token was not generated: $tokenPath"
}
$listener = $null
for ($index = 0; $index -lt 40 -and -not $listener; $index++) {
    $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) {
        Start-Sleep -Milliseconds 250
    }
}
if (-not $listener) {
    throw "Dashboard process did not begin listening on http://127.0.0.1:$Port/."
}
if ($OpenBrowser) {
    $token = Get-Content -LiteralPath $tokenPath -Raw
    Start-Process "http://127.0.0.1:$Port/#token=$($token.Trim())"
}
Write-Output "Installed logon task '$TaskName'."
