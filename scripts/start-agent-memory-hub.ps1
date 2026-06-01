[CmdletBinding()]
param(
    [string]$HubRoot,
    [int]$DashboardPort = 43121,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($HubRoot)) {
    $HubRoot = Split-Path -Parent $PSScriptRoot
}

function Test-Port {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

Push-Location $HubRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $HubRoot 'dist\dashboard-main.js'))) {
        npm run build
    }

    $tokenPath = Join-Path $HOME '.memory-hub\dashboard.token'
    if (-not (Test-Port -Port $DashboardPort)) {
        $node = (Get-Command node -ErrorAction Stop).Source
        Start-Process -FilePath $node -ArgumentList @((Join-Path $HubRoot 'dist\dashboard-main.js')) -WorkingDirectory $HubRoot -WindowStyle Hidden
    }

    for ($index = 0; $index -lt 40 -and -not (Test-Path -LiteralPath $tokenPath); $index++) {
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $tokenPath)) {
        throw "Dashboard token was not generated: $tokenPath"
    }
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    if (-not $NoBrowser) {
        Start-Process "http://127.0.0.1:$DashboardPort/#token=$token"
    }
    Write-Output "Agent Memory Hub opened at http://127.0.0.1:$DashboardPort/"
} catch {
    Write-Error $_
    Write-Host ""
    Write-Host "Startup failed. Press Enter to close this window."
    [void][Console]::ReadLine()
    exit 1
} finally {
    Pop-Location
}
