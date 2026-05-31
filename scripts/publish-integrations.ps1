[CmdletBinding()]
param(
    [string]$HubRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataRoot = (Join-Path $HOME '.agent-collaboration-hub'),
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
$claude = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude-code\2.1.142\claude.exe'
$markerStart = '<!-- agent-collaboration-hub:start -->'
$markerEnd = '<!-- agent-collaboration-hub:end -->'

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
    & $aghub --agent $Agent -g add mcps --name $Name --command $Command | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & $aghub --agent $Agent -g update mcps $Name --command $Command | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $ErrorActionPreference = $previousPreference
            throw "AGHub could not publish MCP '$Name' for '$Agent'."
        }
    }
    $ErrorActionPreference = $previousPreference
}

if ($ApplyRules) {
    $rules = Get-Content -LiteralPath $ruleSource -Raw -Encoding UTF8
    Set-ManagedRuleBlock -Path (Join-Path $HOME '.codex\AGENTS.md') -Text $rules
    Set-ManagedRuleBlock -Path (Join-Path $HOME '.claude\CLAUDE.md') -Text $rules
    Set-ManagedRuleBlock -Path (Join-Path $HOME '.config\opencode\AGENTS.md') -Text $rules
    Write-Output 'Published managed multi-agent rules to Codex, Claude, and OpenCode user instruction files.'
}

if ($PublishPortableSkills) {
    if (-not (Test-Path -LiteralPath $aghub)) { throw "AGHub CLI is missing: $aghub" }
    $skills = [ordered]@{}
    foreach ($root in @((Join-Path $HOME '.codex\skills'), (Join-Path $HOME '.agents\skills'))) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($directory in Get-ChildItem -LiteralPath $root -Directory) {
            if ($directory.Name -eq '.system') { continue }
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
    Write-Output "Submitted $published deduplicated portable skills to AGHub targets claude and opencode; existing managed entries are left unchanged if already present."
}

if ($RegisterMcp) {
    if (-not $AllowExistingCredentialUse) {
        throw 'MCP publication uses existing authenticated client contexts. Re-run with -AllowExistingCredentialUse after explicitly accepting that behavior.'
    }
    foreach ($path in @($archiveMain, $orchestratorMain, $aghub, $claude)) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Required executable or build output missing: $path" }
    }
    $archiveCommand = "node `"$archiveMain`""
    $orchestratorCommand = "node `"$orchestratorMain`""

    & codex mcp remove agent-archive 2>$null | Out-Null
    & codex mcp remove agent-orchestrator 2>$null | Out-Null
    & codex mcp add --env "AGENT_HUB_DATA_DIR=$DataRoot" agent-archive -- node $archiveMain | Out-Null
    & codex mcp add --env "AGENT_HUB_DATA_DIR=$DataRoot" agent-orchestrator -- node $orchestratorMain | Out-Null

    Publish-AghubMcp -Agent claude -Name agent-archive -Command $archiveCommand
    Publish-AghubMcp -Agent claude -Name agent-orchestrator -Command $orchestratorCommand
    Publish-AghubMcp -Agent opencode -Name agent-archive -Command $archiveCommand
    Publish-AghubMcp -Agent opencode -Name agent-orchestrator -Command $orchestratorCommand
    Write-Output 'Registered MCP services: Codex natively, Claude/OpenCode through AGHub.'
}

if (-not $ApplyRules -and -not $PublishPortableSkills -and -not $RegisterMcp) {
    throw 'Specify -ApplyRules, -PublishPortableSkills, -RegisterMcp, or a combination.'
}
