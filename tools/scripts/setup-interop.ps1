[CmdletBinding()]
param(
    [string]$GameDir = $env:HARDBULLET_DIR,
    [string]$ToolsDir = "",
    [string]$UnityVersion = "6000.5.8",
    [string]$Cpp2ILCommit = "b5ad444b82267cb1e4b88b8b373c008105bdea52",
    [string]$BepInExUrl = "https://builds.bepinex.dev/projects/bepinex_be/791/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.791%2Bb782da4.zip",
    [string]$Il2CppInteropUrl = "https://github.com/BepInEx/Il2CppInterop/releases/download/v1.5.3/Il2CppInterop.CLI.1.5.3.zip",
    [switch]$SkipBepInEx,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $ToolsDir) { $ToolsDir = Join-Path $root "tools\.cache" }

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$File завершился с кодом $LASTEXITCODE"
    }
}

function Get-File {
    param([string]$Url, [string]$OutFile)
    $dir = Split-Path -Parent $OutFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Write-Host "-> скачивание: $Url"
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

function Set-IniValue {
    param(
        [string]$Path,
        [string]$Section,
        [string]$Key,
        [string]$Value
    )

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

    if (-not (Test-Path $Path)) {
        Set-Content -Path $Path -Value @("[$Section]", "$Key = $Value") -Encoding UTF8
        return
    }

    $lines = @(Get-Content -Path $Path)
    $sectionIndex = -1
    $keyIndex = -1
    $current = ""

    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*\[(.+?)\]\s*$') {
            $current = $matches[1]
            if ($current -eq $Section -and $sectionIndex -lt 0) { $sectionIndex = $i }
            continue
        }
        if ($current -eq $Section -and $lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") {
            $keyIndex = $i
            break
        }
    }

    if ($keyIndex -ge 0) {
        $lines[$keyIndex] = "$Key = $Value"
    } elseif ($sectionIndex -ge 0) {
        $before = @()
        if ($sectionIndex -gt 0) { $before = $lines[0..($sectionIndex - 1)] }
        $after = @()
        if ($sectionIndex -lt ($lines.Count - 1)) { $after = $lines[($sectionIndex + 1)..($lines.Count - 1)] }
        $lines = @($before) + @($lines[$sectionIndex], "$Key = $Value") + @($after)
    } else {
        $lines = @($lines) + @("", "[$Section]", "$Key = $Value")
    }

    Set-Content -Path $Path -Value $lines -Encoding UTF8
}

# ---------------------------------------------------------------------------
# Проверки
# ---------------------------------------------------------------------------

if (-not $GameDir) {
    $candidates = @(
        "D:\SteamLibrary\steamapps\common\Hard Bullet\bin",
        "C:\Program Files (x86)\Steam\steamapps\common\Hard Bullet\bin"
    )
    $GameDir = $candidates | Where-Object { Test-Path (Join-Path $_ "GameAssembly.dll") } | Select-Object -First 1
}

if (-not $GameDir) {
    throw "Укажи -GameDir (папка bin с Hard Bullet.exe и GameAssembly.dll) или HARDBULLET_DIR."
}

$GameDir = (Resolve-Path $GameDir).Path
$gameAssembly = Join-Path $GameDir "GameAssembly.dll"
$exe = Join-Path $GameDir "Hard Bullet.exe"
$metadata = Join-Path $GameDir "Hard Bullet_Data\il2cpp_data\Metadata\global-metadata.dat"
$bepinex = Join-Path $GameDir "BepInEx"

if (-not (Test-Path $gameAssembly)) { throw "Не найден '$gameAssembly'." }
if (-not (Test-Path $exe)) { throw "Не найден '$exe'. Нужна папка bin, а не корень игры." }
if (-not (Test-Path $metadata)) { throw "Не найден '$metadata'." }

New-Item -ItemType Directory -Force $ToolsDir | Out-Null

Write-Host "Игра:  $GameDir"
Write-Host "Tools: $ToolsDir"
Write-Host "Unity: $UnityVersion"

# ---------------------------------------------------------------------------
# BepInEx
# ---------------------------------------------------------------------------

if (-not $SkipBepInEx -and -not (Test-Path (Join-Path $bepinex "core\BepInEx.Core.dll"))) {
    Write-Step "Установка BepInEx"
    $zip = Join-Path $ToolsDir "BepInEx-be.791.zip"
    if (-not (Test-Path $zip) -or $Force) { Get-File $BepInExUrl $zip }
    Expand-Archive -Path $zip -DestinationPath $GameDir -Force
    if (-not (Test-Path (Join-Path $bepinex "core\BepInEx.Core.dll"))) {
        throw "BepInEx распаковался, но BepInEx\core\BepInEx.Core.dll не найден."
    }
} else {
    Write-Step "BepInEx уже установлен"
}

$unityLibs = Join-Path $bepinex "unity-libs"
if (-not (Test-Path (Join-Path $unityLibs "UnityEngine.CoreModule.dll"))) {
    Write-Step "Unity base libraries"
    New-Item -ItemType Directory -Force $unityLibs | Out-Null
    $zip = Join-Path $unityLibs "$UnityVersion.zip"
    if (-not (Test-Path $zip) -or $Force) {
        Get-File "https://unity.bepinex.dev/libraries/$UnityVersion.zip" $zip
    }
    Expand-Archive -Path $zip -DestinationPath $unityLibs -Force
    if (-not (Test-Path (Join-Path $unityLibs "UnityEngine.CoreModule.dll"))) {
        throw "Не удалось получить Unity base libraries. Проверь версию Unity: $UnityVersion"
    }
}

# ---------------------------------------------------------------------------
# Cpp2IL
# ---------------------------------------------------------------------------

Write-Step "Cpp2IL"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Нужен git в PATH."
}

$cpp2ilSrc = Join-Path $ToolsDir "Cpp2IL-src"
$cpp2ilDll = Join-Path $cpp2ilSrc "Cpp2IL\bin\Release\net10.0\Cpp2IL.dll"

if ($Force -or -not (Test-Path $cpp2ilDll)) {
    if (-not (Test-Path $cpp2ilSrc)) {
        Write-Host "-> git clone Cpp2IL"
        Invoke-Native "git" @("clone", "https://github.com/SamboyCoding/Cpp2IL.git", $cpp2ilSrc)
    }

    if ($Cpp2ILCommit) {
        Write-Host "-> git checkout $Cpp2ILCommit"
        Invoke-Native "git" @("-C", $cpp2ilSrc, "fetch", "--depth", "1", "origin", $Cpp2ILCommit)
        Invoke-Native "git" @("-C", $cpp2ilSrc, "checkout", "--detach", "FETCH_HEAD")
    }

    Write-Host "-> dotnet build Cpp2IL (net10.0)"
    Invoke-Native "dotnet" @("build", (Join-Path $cpp2ilSrc "Cpp2IL\Cpp2IL.csproj"), "-c", "Release", "-f", "net10.0")
}

if (-not (Test-Path $cpp2ilDll)) { throw "Cpp2IL.dll не собран: $cpp2ilDll" }

# ---------------------------------------------------------------------------
# Dummy DLL
# ---------------------------------------------------------------------------

Write-Step "Dummy DLL"
$dummy = Join-Path $ToolsDir "dummy"
if ($Force -or -not (Test-Path (Join-Path $dummy "Assembly-CSharp.dll"))) {
    if (Test-Path $dummy) { Remove-Item -Recurse -Force $dummy }
    New-Item -ItemType Directory -Force $dummy | Out-Null
    Invoke-Native "dotnet" @(
        $cpp2ilDll,
        "--game-path", $GameDir,
        "--output-as", "dummydll",
        "--output-to", $dummy
    )
}

$dummyCount = @(Get-ChildItem $dummy -Filter *.dll -ErrorAction SilentlyContinue).Count
if ($dummyCount -lt 50) {
    throw "Dummy DLL подозрительно мало ($dummyCount). Проверь вывод Cpp2IL."
}
Write-Host "Dummy DLL: $dummyCount"

# ---------------------------------------------------------------------------
# Il2CppInterop CLI
# ---------------------------------------------------------------------------

Write-Step "Il2CppInterop CLI"
$interopCliDir = Join-Path $ToolsDir "interop-cli"
$interopCli = Join-Path $interopCliDir "net6.0\Il2CppInterop.CLI.dll"
if ($Force -or -not (Test-Path $interopCli)) {
    $zip = Join-Path $ToolsDir "Il2CppInterop.CLI.1.5.3.zip"
    if (-not (Test-Path $zip) -or $Force) { Get-File $Il2CppInteropUrl $zip }
    if (Test-Path $interopCliDir) { Remove-Item -Recurse -Force $interopCliDir }
    Expand-Archive -Path $zip -DestinationPath $interopCliDir -Force
}
if (-not (Test-Path $interopCli)) { throw "Il2CppInterop.CLI.dll не найден: $interopCli" }

# ---------------------------------------------------------------------------
# Interop
# ---------------------------------------------------------------------------

Write-Step "Генерация interop"
$interop = Join-Path $bepinex "interop"
$interopHasAssemblies = Test-Path (Join-Path $interop "Assembly-CSharp.dll")

if ($Force -or -not $interopHasAssemblies) {
    $tempInterop = Join-Path $ToolsDir "interop-new"
    if (Test-Path $tempInterop) { Remove-Item -Recurse -Force $tempInterop }
    New-Item -ItemType Directory -Force $tempInterop | Out-Null

    Invoke-Native "dotnet" @(
        $interopCli, "generate",
        "--input", $dummy,
        "--output", $tempInterop,
        "--unity", $unityLibs,
        "--game-assembly", $gameAssembly
    )

    $generated = @(Get-ChildItem $tempInterop -Filter *.dll -ErrorAction SilentlyContinue).Count
    if (-not (Test-Path (Join-Path $tempInterop "Assembly-CSharp.dll")) -or $generated -lt 100) {
        throw "Interop сгенерирован неполно ($generated DLL). Проверь вывод Il2CppInterop."
    }

    $oldInterop = "$interop.old"
    if (Test-Path $oldInterop) { Remove-Item -Recurse -Force $oldInterop }
    if (Test-Path $interop) { Rename-Item -Path $interop -NewName "interop.old" }

    try {
        Move-Item -Path $tempInterop -Destination $interop
    } catch {
        if (Test-Path $oldInterop) { Rename-Item -Path $oldInterop -NewName "interop" }
        throw
    }

    if (Test-Path $oldInterop) { Remove-Item -Recurse -Force $oldInterop }
    Write-Host "Interop: $generated DLL"
} else {
    Write-Host "Interop уже есть, пропускаю (используй -Force для перегенерации)."
}

# ---------------------------------------------------------------------------
# Конфиг BepInEx
# ---------------------------------------------------------------------------

Write-Step "Настройка BepInEx"
$bepinexCfg = Join-Path $bepinex "config\BepInEx.cfg"
Set-IniValue -Path $bepinexCfg -Section "IL2CPP" -Key "UpdateInteropAssemblies" -Value "false"
Write-Host "UpdateInteropAssemblies = false"

$interopCount = @(Get-ChildItem $interop -Filter *.dll -ErrorAction SilentlyContinue).Count
Write-Host ""
Write-Host "Готово. Interop DLL: $interopCount" -ForegroundColor Green
Write-Host "Дальше: собери мод (tools/scripts/install-mod.ps1) и запусти игру со шлемом."
