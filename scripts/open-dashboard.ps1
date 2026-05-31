[CmdletBinding()]
param([int]$Port = 43121)

$ErrorActionPreference = 'Stop'
$tokenPath = Join-Path $HOME '.memory-hub\dashboard.token'
if (-not (Test-Path -LiteralPath $tokenPath)) {
    throw 'Dashboard access token does not exist. Install and start the dashboard service first.'
}
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
Start-Process "http://127.0.0.1:$Port/#token=$token"
