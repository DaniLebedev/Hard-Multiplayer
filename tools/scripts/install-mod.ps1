[CmdletBinding()]
param(
    [string]$GameDir = $env:HARDBULLET_DIR,
    [string]$Configuration = "Release",
    [switch]$SkipConfig
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (-not $GameDir) {
    $candidates = @(
        "D:\SteamLibrary\steamapps\common\Hard Bullet\bin",
        "C:\Program Files (x86)\Steam\steamapps\common\Hard Bullet\bin"
    )
    $GameDir = $candidates | Where-Object { Test-Path (Join-Path $_ "GameAssembly.dll") } | Select-Object -First 1
}

if (-not $GameDir) {
    throw "Укажи -GameDir или переменную HARDBULLET_DIR (папка bin с Hard Bullet.exe)."
}

$gameAssembly = Join-Path $GameDir "GameAssembly.dll"
if (-not (Test-Path $gameAssembly)) {
    throw "В '$GameDir' нет GameAssembly.dll. Это точно папка bin игры?"
}

$plugins = Join-Path $GameDir "BepInEx\plugins"
if (-not (Test-Path $plugins)) {
    throw "Не найдена '$plugins'. Сначала установи BepInEx (см. docs/SETUP.md)."
}

Push-Location $root
try {
    Write-Host "== Сборка мода ==" -ForegroundColor Cyan
    dotnet build "mod/HardMultiplayer.csproj" -c $Configuration "-p:GameDir=$GameDir"
    if ($LASTEXITCODE -ne 0) { throw "dotnet build завершился с кодом $LASTEXITCODE" }

    $dll = Join-Path $root "mod\bin\$Configuration\net6.0\HardMultiplayer.dll"
    if (-not (Test-Path $dll)) {
        throw "Не найден собранный '$dll'."
    }

    Copy-Item $dll (Join-Path $plugins "HardMultiplayer.dll") -Force
    Write-Host "Плагин установлен: $(Join-Path $plugins 'HardMultiplayer.dll')" -ForegroundColor Green

    # BepInEx 6.0.0-be.791 падает на Unity 6000.5.8f1, когда устанавливает
    # свой Unity-логгер через ClassInjector. Отключаем этот логгер: мод пишет
    # через BepInEx и сам перехватывает исключения.
    $bepinexCfg = Join-Path $GameDir "BepInEx\config\BepInEx.cfg"
    $bepInExDir = Split-Path -Parent $bepinexCfg
    New-Item -ItemType Directory -Force $bepInExDir | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    if (-not (Test-Path $bepinexCfg)) {
        [IO.File]::WriteAllText($bepinexCfg, "[Logging]`r`nUnityLogListening = false`r`n", $utf8)
        Write-Host "Создан BepInEx.cfg: UnityLogListening = false (обход краша на Unity 6)." -ForegroundColor Yellow
    } else {
        $bepText = [IO.File]::ReadAllText($bepinexCfg)
        if ($bepText -match '(?m)^\s*UnityLogListening\s*=') {
            if ($bepText -match '(?m)^\s*UnityLogListening\s*=\s*true') {
                $bepText = $bepText -replace '(?m)^\s*UnityLogListening\s*=\s*true\s*$', 'UnityLogListening = false'
                [IO.File]::WriteAllText($bepinexCfg, $bepText, $utf8)
                Write-Host "Отключён UnityLogListening (обход краша на Unity 6)." -ForegroundColor Yellow
            }
        } elseif ($bepText -match '(?m)^\[Logging\]\s*$') {
            $bepText = $bepText -replace '(?m)^\[Logging\]\s*$', "[Logging]`r`nUnityLogListening = false"
            [IO.File]::WriteAllText($bepinexCfg, $bepText, $utf8)
            Write-Host "Добавлен UnityLogListening = false (обход краша на Unity 6)." -ForegroundColor Yellow
        } else {
            $bepText = $bepText.TrimEnd() + "`r`n`r`n[Logging]`r`nUnityLogListening = false`r`n"
            [IO.File]::WriteAllText($bepinexCfg, $bepText, $utf8)
            Write-Host "Добавлен UnityLogListening = false (обход краша на Unity 6)." -ForegroundColor Yellow
        }
    }

    if (-not $SkipConfig) {
        $configDir = Join-Path $GameDir "BepInEx\config"
        $config = Join-Path $configDir "hardmultiplayer.ghost.cfg"
        if (-not (Test-Path $config)) {
            New-Item -ItemType Directory -Force $configDir | Out-Null
            Copy-Item (Join-Path $root "mod\hardmultiplayer.ghost.cfg.example") $config
            Write-Host "Создан конфиг: $config" -ForegroundColor Yellow
            Write-Host "Проверь [Relay] Url и Room перед запуском игры."
        } else {
            Write-Host "Конфиг уже есть, не трогаю: $config"
        }
    }
} finally {
    Pop-Location
}
