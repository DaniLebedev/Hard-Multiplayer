[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$BindHost = "0.0.0.0",
    [string]$Token = "",
    [int]$TtlMinutes = 15,
    [string]$PublicDir = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dist = if ($PublicDir) { $PublicDir } else { Join-Path $root "ghost-app\dist" }

Push-Location $root
try {
    if (-not $SkipBuild -and -not (Test-Path (Join-Path $dist "index.html"))) {
        Write-Host "Клиент ещё не собран, собираю..." -ForegroundColor Yellow
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build завершился с кодом $LASTEXITCODE" }
    }

    $env:PORT = "$Port"
    $env:HOST = $BindHost
    $env:PUBLIC_DIR = $dist
    $env:ROOM_TTL_MINUTES = "$TtlMinutes"
    if ($Token) {
        $env:RELAY_TOKEN = $Token
    }

    Write-Host "== Relay ==" -ForegroundColor Cyan
    Write-Host "Клиент:    http://127.0.0.1:$Port/"
    Write-Host "WebSocket: ws://127.0.0.1:$Port/ws"
    Write-Host "Health:    http://127.0.0.1:$Port/health"
    if ($Token) {
        Write-Host "Токен игры: включён (не забудь Token в конфиге мода)" -ForegroundColor Yellow
    }
    Write-Host "Остановка: Ctrl+C" -ForegroundColor DarkGray
    Write-Host ""

    npm start
    if ($LASTEXITCODE -ne 0) { throw "relay завершился с кодом $LASTEXITCODE" }
} finally {
    Pop-Location
}
