$ErrorActionPreference = 'Stop'

$rootDir = $PSScriptRoot
$backendDir = Join-Path $rootDir 'valhalla-elizaos'

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
    -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Node.js 23.3+ and npm are required. Install them, then rerun setup.ps1.'
}

$nodeVersion = [version]((node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'23.3') {
    throw 'Node.js 23.3 or newer is required.'
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'Bun is required for valhalla-elizaos. Install Bun, then rerun setup.ps1.'
}

if (-not (Test-Path (Join-Path $rootDir 'package-lock.json')) -or
    -not (Test-Path (Join-Path $backendDir 'bun.lock'))) {
    throw 'A committed npm or Bun lockfile is missing; refusing to generate one during setup.'
}

Push-Location $rootDir
try {
    Write-Output 'Installing root dependencies from package-lock.json...'
    npm ci --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { throw 'Root npm dependency installation failed.' }

    foreach ($cacheDir in @(
        (Join-Path $rootDir 'node_modules/.cache'),
        (Join-Path $backendDir 'node_modules/.cache')
    )) {
        if (Test-Path $cacheDir) {
            Remove-Item -LiteralPath $cacheDir -Recurse -Force
        }
    }

    Push-Location $backendDir
    try {
        Write-Output 'Installing ElizaOS dependencies from bun.lock...'
        bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'ElizaOS dependency installation failed.' }

        bun run type-check
        if ($LASTEXITCODE -ne 0) { throw 'ElizaOS TypeScript type-check failed.' }
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}

Write-Output 'Valhalla core dependencies verified.'
