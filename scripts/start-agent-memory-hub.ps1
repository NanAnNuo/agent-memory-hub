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
    $candidateParents = New-Object System.Collections.Generic.List[string]
    $candidateParents.Add((Split-Path -Parent $HubRoot))
    $hubItem = Get-Item -LiteralPath $HubRoot -ErrorAction SilentlyContinue
    if ($hubItem -and $hubItem.Target) {
        $candidateParents.Add((Split-Path -Parent $hubItem.Target))
    }
    $EverCoreRoot = $candidateParents |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Unique |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Directory -ErrorAction SilentlyContinue } |
        ForEach-Object { Join-Path $_.FullName 'EverOS\methods\EverCore' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
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

    $env:AGENT_HUB_EVERCORE_ENABLED = 'false'
    if (-not $SkipEverCore) {
        if ([string]::IsNullOrWhiteSpace($EverCoreRoot) -or -not (Test-Path -LiteralPath $EverCoreRoot)) {
            Write-Warning "EverCore root not found. Dashboard will open without EverCore sync."
        } else {
            $env:AGENT_HUB_EVERCORE_ROOT = $EverCoreRoot
            $env:AGENT_HUB_EVERCORE_URL = "http://127.0.0.1:$EverCorePort"

            $envFile = Join-Path $EverCoreRoot '.env'
            if (-not (Test-Path -LiteralPath $envFile)) {
                Write-Warning "EverCore .env is missing: $envFile. Dashboard will open; configure EverCore .env to enable semantic memory sync."
            } else {
                Push-Location $EverCoreRoot
                try {
                    try {
                        docker compose up -d
                    } catch {
                        Write-Warning "EverCore Docker dependency startup reported a warning/failure: $($_.Exception.Message). Continuing because compatible services may already be running."
                    }
                    if (-not (Test-Port -Port $EverCorePort)) {
                        $uv = (Get-Command uv -ErrorAction Stop).Source
                        $env:PYTHONIOENCODING = 'utf-8'
                        Start-Process -FilePath $uv -ArgumentList @('run', 'python', 'src/run.py', '--port', "$EverCorePort") -WorkingDirectory $EverCoreRoot -WindowStyle Hidden
                    }
                    for ($index = 0; $index -lt 60 -and -not (Test-Port -Port $EverCorePort); $index++) {
                        Start-Sleep -Seconds 1
                    }
                    if (Test-Port -Port $EverCorePort) {
                        $env:AGENT_HUB_EVERCORE_ENABLED = 'true'
                    } else {
                        Write-Warning "EverCore API did not become reachable on port $EverCorePort. Dashboard will open without EverCore sync."
                    }
                } catch {
                    Write-Warning "EverCore startup failed: $($_.Exception.Message). Dashboard will still open."
                } finally {
                    Pop-Location
                }
            }
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
} catch {
    Write-Error $_
    Write-Host ""
    Write-Host "Startup failed. Press Enter to close this window."
    [void][Console]::ReadLine()
    exit 1
} finally {
    Pop-Location
}
