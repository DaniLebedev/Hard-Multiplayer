[CmdletBinding()]
param(
    [string]$Room = "TEST",
    [string]$RelayUrl = "ws://127.0.0.1:8080/ws",
    [string]$Name = "Mock VR"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $root
try {
    Write-Host "== Mock game ==" -ForegroundColor Cyan
    Write-Host "Комната: $Room"
    Write-Host "Relay:   $RelayUrl"
    Write-Host ""

    npm --workspace mock-game run start -- --room=$Room --relay=$RelayUrl --name=$Name
    if ($LASTEXITCODE -ne 0) { throw "mock-game завершился с кодом $LASTEXITCODE" }
} finally {
    Pop-Location
}
