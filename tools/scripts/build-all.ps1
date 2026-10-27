[CmdletBinding()]
param(
    [string]$GameDir = $env:HARDBULLET_DIR,
    [switch]$SkipNpmInstall,
    [switch]$SkipMod
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $root
try {
    Write-Host "== Hard Multiplayer: сборка ==" -ForegroundColor Cyan

    if (-not $SkipNpmInstall -and -not (Test-Path (Join-Path $root "node_modules"))) {
        Write-Host "-> npm install" -ForegroundColor Yellow
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install завершился с кодом $LASTEXITCODE" }
    }

    Write-Host "-> npm run build (ghost-app + typecheck relay)" -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build завершился с кодом $LASTEXITCODE" }

    if (-not $SkipMod) {
        $dotnetArgs = @("build", "mod/HardMultiplayer.csproj", "-c", "Release")
        if ($GameDir) {
            $dotnetArgs += "-p:GameDir=$GameDir"
            Write-Host "-> dotnet build (GameDir=$GameDir)" -ForegroundColor Yellow
        } else {
            Write-Host "-> dotnet build (GameDir из csproj)" -ForegroundColor Yellow
        }

        dotnet @dotnetArgs
        if ($LASTEXITCODE -ne 0) { throw "dotnet build завершился с кодом $LASTEXITCODE" }
    }

    Write-Host ""
    Write-Host "Готово." -ForegroundColor Green
    if (-not $SkipMod -and $GameDir) {
        Write-Host "Плагин: $(Join-Path $GameDir 'BepInEx\plugins\HardMultiplayer.dll')"
    }
} finally {
    Pop-Location
}
