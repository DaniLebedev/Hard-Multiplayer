[CmdletBinding()]
param(
    [int]$Port = 5173,
    [string]$Room = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $root
try {
    Write-Host "== Ghost app (Vite dev) ==" -ForegroundColor Cyan
    $url = "http://127.0.0.1:$Port/"
    if ($Room) { $url += "?room=$($Room.ToUpperInvariant())" }
    Write-Host "Открой: $url"
    Write-Host "WebSocket проксируется на ws://127.0.0.1:8080/ws"
    Write-Host ""

    npm --workspace ghost-app run dev -- --host 127.0.0.1 --port $Port
    if ($LASTEXITCODE -ne 0) { throw "ghost-app завершился с кодом $LASTEXITCODE" }
} finally {
    Pop-Location
}
