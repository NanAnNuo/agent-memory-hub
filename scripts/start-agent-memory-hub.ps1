[CmdletBinding()]
param(
    [string]$HubRoot,
    [string]$EverCoreRoot = $env:AGENT_HUB_EVERCORE_ROOT,
    [int]$DashboardPort = 43121,
    [int]$EverCorePort = 1995,
    [switch]$SkipEverCore
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($HubRoot)) {
    $HubRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($EverCoreRoot)) {
    $EverCoreRoot = 'D:\桌面\工作文件夹\项目\日常通用任务处理\EverOS\methods\EverCore'
}

function Test-Port {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

Push-Location $HubRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $HubRoot 'dist\dashboard-main.js'))) {
        npm run build
    }

    if (-not $SkipEverCore) {
        if (-not (Test-Path -LiteralPath $EverCoreRoot)) {
            throw "EverCore root not found: $EverCoreRoot"
        }
        $env:AGENT_HUB_EVERCORE_ROOT = $EverCoreRoot
        $env:AGENT_HUB_EVERCORE_URL = "http://127.0.0.1:$EverCorePort"
        $env:AGENT_HUB_EVERCORE_ENABLED = 'true'

        $envFile = Join-Path $EverCoreRoot '.env'
        if (-not (Test-Path -LiteralPath $envFile)) {
            throw "EverCore .env is missing: $envFile. Copy env.template to .env and fill the required LLM/vector keys."
        }

        Push-Location $EverCoreRoot
        try {
            docker compose up -d
            if (-not (Test-Port -Port $EverCorePort)) {
                $uv = (Get-Command uv -ErrorAction Stop).Source
                Start-Process -FilePath $uv -ArgumentList @('run', 'python', 'src/run.py', '--port', "$EverCorePort") -WorkingDirectory $EverCoreRoot -WindowStyle Hidden
            }
        } finally {
            Pop-Location
        }
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
    Start-Process "http://127.0.0.1:$DashboardPort/#token=$token"
    Write-Output "Agent Memory Hub opened at http://127.0.0.1:$DashboardPort/"
} finally {
    Pop-Location
}
