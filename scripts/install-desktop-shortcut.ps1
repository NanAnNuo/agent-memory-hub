[CmdletBinding()]
param(
    [string]$HubRoot,
    [string]$ShortcutPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($HubRoot)) {
    $HubRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
    $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Memory Hub.lnk'
}
$launcher = Join-Path $HubRoot 'scripts\start-agent-memory-hub.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launcher not found: $launcher"
}

$shell = New-Object -ComObject WScript.Shell
$tempShortcut = Join-Path $env:TEMP 'Agent Memory Hub.lnk'
$shortcut = $shell.CreateShortcut($tempShortcut)
$shortcut.TargetPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$shortcut.WorkingDirectory = $HubRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.Description = "Start Agent Memory Hub and open the local dashboard."
$shortcut.Save()
Move-Item -LiteralPath $tempShortcut -Destination $ShortcutPath -Force
Write-Output "Created desktop shortcut: $ShortcutPath"
