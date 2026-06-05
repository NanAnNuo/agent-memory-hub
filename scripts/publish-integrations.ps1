[CmdletBinding()]
param(
    [string]$HubRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataRoot = (Join-Path $HOME '.memory-hub'),
    [switch]$ApplyRules,
    [switch]$PublishPortableSkills,
    [switch]$RegisterMcp,
    [switch]$AllowExistingCredentialUse
)

$ErrorActionPreference = 'Stop'
$archiveMain = Join-Path $HubRoot 'dist\archive-main.js'
$orchestratorMain = Join-Path $HubRoot 'dist\orchestrator-main.js'
$ruleSource = Join-Path $HubRoot 'rules\shared-agent-policy.md'
$aghub = Join-Path $env:LOCALAPPDATA 'AGHub\bin\aghub-cli.exe'
$claudeDesktopConfig = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude_desktop_config.json'
$markerStart = '<!-- agent-collaboration-hub:start -->'
$markerEnd = '<!-- agent-collaboration-hub:end -->'

function Resolve-NodeRuntime {
    param([string]$Root)
    foreach ($candidate in @(
        (Join-Path $Root 'node.exe'),
        (Join-Path $Root 'app\node.exe')
    )) {
        if (Test-Path -LiteralPath $candidate) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return (Get-Command node -ErrorAction Stop).Source
}

function Set-ManagedRuleBlock {
    param([string]$Path, [string]$Text)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $block = "$markerStart`r`n$Text`r`n$markerEnd"
    $existing = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 } else { '' }
    $escapedStart = [regex]::Escape($markerStart)
    $escapedEnd = [regex]::Escape($markerEnd)
    if ($existing -match "$escapedStart[\s\S]*?$escapedEnd") {
        $updated = [regex]::Replace($existing, "$escapedStart[\s\S]*?$escapedEnd", $block)
    } elseif ([string]::IsNullOrWhiteSpace($existing)) {
        $updated = "$block`r`n"
    } else {
        $updated = "$existing`r`n$block`r`n"
    }
    Set-Content -LiteralPath $Path -Value $updated -Encoding UTF8
}

function Publish-AghubMcp {
    param([string]$Agent, [string]$Name, [string]$Command)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $aghub --agent $Agent -g add mcps --name $Name --command $Command 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & $aghub --agent $Agent -g update mcps $Name --command $Command | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $ErrorActionPreference = $previousPreference
            throw "AGHub could not publish MCP '$Name' for '$Agent'."
        }
    }
    $ErrorActionPreference = $previousPreference
}

function Register-ClaudeDesktopMcp {
    param(
        [string]$ConfigPath,
        [string]$NodePath,
        [string]$ArchiveEntry,
        [string]$OrchestratorEntry,
        [string]$DataDirectory
    )
    $directory = Split-Path -Parent $ConfigPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    if (Test-Path -LiteralPath $ConfigPath) {
        Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak-agent-memory-hub-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
        $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $config = [pscustomobject]@{}
    }
    if (-not $config.PSObject.Properties['mcpServers']) {
        $config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{})
    }
    $archiveServer = [ordered]@{
        command = $NodePath
        args = @($ArchiveEntry)
        env = [ordered]@{ AGENT_HUB_DATA_DIR = $DataDirectory }
    }
    $orchestratorServer = [ordered]@{
        command = $NodePath
        args = @($OrchestratorEntry)
        env = [ordered]@{ AGENT_HUB_DATA_DIR = $DataDirectory }
    }
    $config.mcpServers | Add-Member -Force -NotePropertyName 'agent-archive' -NotePropertyValue $archiveServer
    $config.mcpServers | Add-Member -Force -NotePropertyName 'agent-orchestrator' -NotePropertyValue $orchestratorServer
    $config | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
}

if ($ApplyRules) {
    $rules = Get-Content -LiteralPath $ruleSource -Raw -Encoding UTF8
    Set-ManagedRuleBlock -Path (Join-Path $HOME '.codex\AGENTS.md') -Text $rules
    Set-ManagedRuleBlock -Path (Join-Path $env:LOCALAPPDATA 'Claude-3p\CLAUDE.md') -Text $rules
    Set-ManagedRuleBlock -Path (Join-Path $HOME '.config\opencode\AGENTS.md') -Text $rules
    Write-Output 'Published managed multi-agent rules to Codex, Claude, and OpenCode user instruction files.'
}

if ($PublishPortableSkills) {
    if (-not (Test-Path -LiteralPath $aghub)) { throw "AGHub CLI is missing: $aghub" }
    $skills = [ordered]@{}
    foreach ($root in @((Join-Path $DataRoot 'skills\global'), (Join-Path $DataRoot 'skills\projects'))) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($directory in Get-ChildItem -LiteralPath $root -Directory -Recurse) {
            if ((Test-Path -LiteralPath (Join-Path $directory.FullName 'SKILL.md')) -and -not $skills.Contains($directory.Name)) {
                $skills[$directory.Name] = $directory.FullName
            }
        }
    }
    $published = 0
    foreach ($skillPath in $skills.Values) {
        foreach ($agent in @('claude', 'opencode')) {
            $previousPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & $aghub --agent $agent -g add skills --from $skillPath 2>$null | Out-Null
            $ErrorActionPreference = $previousPreference
        }
        $published += 1
    }
    Write-Output "Submitted $published Hub-managed skills to AGHub targets claude and opencode; native agent skill directories were not scanned."
}

if ($RegisterMcp) {
    if (-not $AllowExistingCredentialUse) {
        throw 'MCP publication uses existing authenticated client contexts. Re-run with -AllowExistingCredentialUse after explicitly accepting that behavior.'
    }
    foreach ($path in @($archiveMain, $orchestratorMain)) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Required executable or build output missing: $path" }
    }
    $node = Resolve-NodeRuntime -Root $HubRoot
    $archiveCommand = "`"$node`" `"$archiveMain`""
    $orchestratorCommand = "`"$node`" `"$orchestratorMain`""

    if (Get-Command codex -ErrorAction SilentlyContinue) {
        & codex mcp remove agent-archive 2>$null | Out-Null
        & codex mcp remove agent-orchestrator 2>$null | Out-Null
        & codex mcp add --env "AGENT_HUB_DATA_DIR=$DataRoot" agent-archive -- $node $archiveMain | Out-Null
        & codex mcp add --env "AGENT_HUB_DATA_DIR=$DataRoot" agent-orchestrator -- $node $orchestratorMain | Out-Null
    } else {
        Write-Warning 'Codex CLI is not available; skipped native Codex MCP registration.'
    }

    Register-ClaudeDesktopMcp -ConfigPath $claudeDesktopConfig -NodePath $node -ArchiveEntry $archiveMain -OrchestratorEntry $orchestratorMain -DataDirectory $DataRoot

    if (Test-Path -LiteralPath $aghub) {
        Publish-AghubMcp -Agent opencode -Name agent-archive -Command $archiveCommand
        Publish-AghubMcp -Agent opencode -Name agent-orchestrator -Command $orchestratorCommand
    } else {
        Write-Warning 'AGHub CLI is missing; skipped OpenCode MCP publication.'
    }
    Write-Output 'Registered MCP services for available clients and Claude Desktop.'
}

if (-not $ApplyRules -and -not $PublishPortableSkills -and -not $RegisterMcp) {
    throw 'Specify -ApplyRules, -PublishPortableSkills, -RegisterMcp, or a combination.'
}
