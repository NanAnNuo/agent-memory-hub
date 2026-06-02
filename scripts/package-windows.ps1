[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string]$ProductName = 'AgentMemoryHub'
)

$ErrorActionPreference = 'Stop'
$HubRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $HubRoot 'release\AgentMemoryHub-win-x64'
}

$resolvedHub = [IO.Path]::GetFullPath($HubRoot)
$resolvedOutput = [IO.Path]::GetFullPath($OutputRoot)
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $HubRoot 'release'))
if (-not $resolvedOutput.StartsWith($releaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside the project release directory: $releaseRoot"
}
if ($resolvedOutput.Length -le 10 -or ($resolvedOutput -notmatch 'AgentMemoryHub')) {
    throw "Refusing to package into an unsafe output path: $resolvedOutput"
}

function Invoke-Checked {
    param(
        [scriptblock]$Command,
        [string]$Label
    )
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Remove-DevelopmentDependencies {
    param([string]$AppRoot)
    $nodeModules = Join-Path $AppRoot 'node_modules'
    foreach ($path in @(
        (Join-Path $nodeModules 'playwright'),
        (Join-Path $nodeModules 'playwright-core'),
        (Join-Path $nodeModules 'vitest'),
        (Join-Path $nodeModules 'typescript'),
        (Join-Path $nodeModules '@types'),
        (Join-Path $nodeModules '@vitest'),
        (Join-Path $nodeModules '@playwright'),
        (Join-Path $nodeModules '.vite')
    )) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Push-Location $HubRoot
try {
    Invoke-Checked -Label 'npm run build' -Command { npm run build }

    if (Test-Path -LiteralPath $resolvedOutput) {
        Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
    }
    $appRoot = Join-Path $resolvedOutput 'app'
    New-Item -ItemType Directory -Force -Path $appRoot | Out-Null

    foreach ($name in @('dist', 'web', 'assets', 'config', 'rules', 'scripts', 'node_modules')) {
        Copy-Item -LiteralPath (Join-Path $HubRoot $name) -Destination (Join-Path $appRoot $name) -Recurse -Force
    }
    foreach ($name in @('package.json', 'package-lock.json', 'README.md')) {
        Copy-Item -LiteralPath (Join-Path $HubRoot $name) -Destination (Join-Path $appRoot $name) -Force
    }

    $nodePath = (Get-Command node -ErrorAction Stop).Source
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $appRoot 'node.exe') -Force

    Remove-DevelopmentDependencies -AppRoot $appRoot

    $launcherSource = Join-Path $resolvedOutput 'AgentMemoryHubLauncher.cs'
    $launcherExe = Join-Path $resolvedOutput "$ProductName.exe"
    $launcherIcon = Join-Path $HubRoot 'assets\app-icon.ico'
    if (-not (Test-Path -LiteralPath $launcherIcon)) {
        throw "Launcher icon missing: $launcherIcon"
    }
    $source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

public static class AgentMemoryHubLauncher
{
    [STAThread]
    public static void Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string app = Path.Combine(root, "app");
            string node = Path.Combine(app, "node.exe");
            string entry = Path.Combine(app, "dist", "dashboard-main.js");
            string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string tokenPath = Path.Combine(user, ".memory-hub", "dashboard.token");
            int port = 43121;
            int.TryParse(Environment.GetEnvironmentVariable("AGENT_HUB_DASHBOARD_PORT"), out port);
            if (port <= 0) port = 43121;

            if (!File.Exists(node)) throw new FileNotFoundException("Bundled node.exe is missing.", node);
            if (!File.Exists(entry)) throw new FileNotFoundException("Dashboard entry is missing.", entry);

            if (!IsListening(port))
            {
                var info = new ProcessStartInfo(node, Quote(entry));
                info.WorkingDirectory = app;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(info);
            }

            WaitFor(() => File.Exists(tokenPath), 10000, "Dashboard token was not generated.");
            WaitFor(() => IsListening(port), 15000, "Dashboard did not start listening.");
            string token = File.ReadAllText(tokenPath).Trim();
            Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/#token=" + Uri.EscapeDataString(token)) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Agent Memory Hub startup failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void WaitFor(Func<bool> predicate, int timeoutMs, string message)
    {
        var start = Environment.TickCount;
        while (Environment.TickCount - start < timeoutMs)
        {
            if (predicate()) return;
            Thread.Sleep(250);
        }
        throw new TimeoutException(message);
    }

    private static bool IsListening(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var result = client.BeginConnect("127.0.0.1", port, null, null);
                bool ok = result.AsyncWaitHandle.WaitOne(200);
                if (!ok) return false;
                client.EndConnect(result);
                return true;
            }
        }
        catch
        {
            return false;
        }
    }
}
'@
    Set-Content -LiteralPath $launcherSource -Value $source -Encoding ASCII
    $csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64" -Recurse -Filter csc.exe |
        Where-Object { $_.FullName -like '*v4.0.30319*' } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $csc) {
        throw "C# compiler not found. Install .NET Framework build tools or run from a machine with csc.exe."
    }
    & $csc /nologo /target:winexe /out:$launcherExe /win32icon:$launcherIcon /reference:System.Windows.Forms.dll $launcherSource
    if ($LASTEXITCODE -ne 0) {
        throw "Launcher compilation failed."
    }
    Remove-Item -LiteralPath $launcherSource -Force

    $cmd = @(
        '@echo off',
        'setlocal',
        'cd /d "%~dp0app"',
        'start "" "%~dp0app\node.exe" "%~dp0app\dist\dashboard-main.js"',
        'echo Agent Memory Hub is starting on http://127.0.0.1:43121/',
        'timeout /t 2 >nul'
    )
    Set-Content -LiteralPath (Join-Path $resolvedOutput 'Start-AgentMemoryHub.cmd') -Value $cmd -Encoding ASCII

    $size = (Get-ChildItem -LiteralPath $resolvedOutput -Recurse -File | Measure-Object Length -Sum).Sum
    [pscustomobject]@{
        output = $resolvedOutput
        launcher = $launcherExe
        sizeMB = [Math]::Round($size / 1MB, 1)
        entry = 'Double-click AgentMemoryHub.exe'
    } | ConvertTo-Json
} finally {
    Pop-Location
}
