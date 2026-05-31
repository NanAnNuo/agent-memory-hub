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
$cmdPath = [IO.Path]::ChangeExtension($ShortcutPath, '.cmd')
$launcher = Join-Path $HubRoot 'scripts\start-agent-memory-hub.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launcher not found: $launcher"
}

$junctionRoot = Join-Path $env:LOCALAPPDATA 'AgentMemoryHub'
$junction = Join-Path $junctionRoot 'project'
New-Item -ItemType Directory -Force -Path $junctionRoot | Out-Null
if (Test-Path -LiteralPath $junction) {
    $item = Get-Item -LiteralPath $junction -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        cmd.exe /c "rmdir `"$junction`"" | Out-Null
    } else {
        throw "Cannot create launcher junction because a real directory exists: $junction"
    }
}
cmd.exe /c "mklink /J `"$junction`" `"$HubRoot`"" | Out-Null
$launcherForShortcut = Join-Path $junction 'scripts\start-agent-memory-hub.ps1'

$cmdLines = @(
    '@echo off',
    'setlocal',
    ('cd /d "{0}"' -f $junction),
    ('"{0}\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -NoExit -File "{1}" -HubRoot "{2}"' -f $env:SystemRoot, $launcherForShortcut, $junction)
)
Set-Content -LiteralPath $cmdPath -Value $cmdLines -Encoding ASCII

Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
Write-Output "Created desktop launcher: $cmdPath"
