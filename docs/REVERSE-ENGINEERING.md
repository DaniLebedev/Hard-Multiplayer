# Reverse engineering: Unity 6.5, metadata v107

Документ фиксирует, что именно выяснено про Hard Bullet, какими инструментами это
сделано и как повторить разведку после обновления игры. Он нужен, чтобы не проходить
цепочку «MelonLoader → BepInEx → Cpp2IL → Il2CppInterop» заново.

> Используй это только со своей копией игры. Проект не распространяет файлы игры,
> `GameAssembly.dll`, `global-metadata.dat` или сгенерированные interop-сборки.

## 1. Окружение

| Параметр | Значение |
| --- | --- |
| Игра | Hard Bullet |
| Steam AppID | `1294760` |
| BuildID | `26187433` |
| Unity | `6000.5.8f1` (5cb7df797b7d) |
| Скриптовый бэкенд | IL2CPP, x64 |
| Версия metadata | `107` |
| Папка игры | `D:\SteamLibrary\steamapps\common\Hard Bullet\bin` |
| Лаунчер | `Hard Bullet.exe` в корне (WPF) запускает `bin\Hard Bullet.exe` |
| Метаданные | `bin\Hard Bullet_Data\il2cpp_data\Metadata\global-metadata.dat` |
| Бинарник IL2CPP | `bin\GameAssembly.dll` |

Проверка версии metadata:

```powershell
$p = "...\bin\Hard Bullet_Data\il2cpp_data\Metadata\global-metadata.dat"
$b = [IO.File]::ReadAllBytes($p)[0..7]
($b | ForEach-Object { $_.ToString('X2') }) -join ' '
[BitConverter]::ToUInt32($b, 4)
```

Ожидаемо:

```
AF 1B B1 FA 6B 00 00 00
107
```

`0xFAB11BAF` — магия, `107` — версия.

## 2. Почему не MelonLoader

MelonLoader 0.7.3 устанавливался, но падал на разборе metadata:

```
Unsupported metadata version found! We support 23-106, got 107
```

То есть поддержка заканчивается на v106 (Unity 6.4 и ниже). Патчить MelonLoader под v107
не стали: BepInEx 6 даёт более прямой путь через Il2CppInterop.

## 3. Почему не авто-генерация BepInEx

BepInEx 6.0.0-be.791 с `UpdateInteropAssemblies = true` пытается сам вызвать Cpp2IL и
Il2CppInterop. На metadata v107 эта цепочка не проходит: версия Cpp2IL внутри be.791
слишком старая. Игра завершается до загрузки плагинов, а `BepInEx\interop` остаётся
пустой или неполной.

Рабочая схема:

```
Cpp2IL master (поддерживает v108)
        │
        ├─ dummy DLL (135 штук)
        │
        ▼
Il2CppInterop CLI 1.5.3
        │
        ├─ interop-сборки (168 штук)
        │
        ▼
BepInEx 6 be.791 + UpdateInteropAssemblies = false
```

Ключевой момент: **dummy DLL генерирует Cpp2IL, а interop — Il2CppInterop CLI**, а не
сам BepInEx. После генерации автообновление отключается, иначе BepInEx попытается
перезаписать рабочую папку своим старым пайплайном.

## 4. Инструменты и версии

| Инструмент | Версия | Ссылка |
| --- | --- | --- |
| BepInEx | 6.0.0-be.791+b782da4 | `https://builds.bepinex.dev/projects/bepinex_be/791/` |
| Cpp2IL | master, commit `b5ad444` (2022.1.0) | `https://github.com/SamboyCoding/Cpp2IL` |
| Il2CppInterop CLI | 1.5.3 | `https://github.com/BepInEx/Il2CppInterop/releases/tag/v1.5.3` |
| .NET SDK | 10.0.400 | `https://dotnet.microsoft.com/` |
| ilspycmd | 8.2.0.7535 | `dotnet tool install -g ilspycmd` |
| Node.js | 24 | для relay и клиента |

Cpp2IL master на момент проверки собирается под `net10.0`:

```powershell
git clone --depth 1 https://github.com/SamboyCoding/Cpp2IL.git
dotnet build .\Cpp2IL\Cpp2IL.csproj -c Release -f net10.0
```

Выход: `Cpp2IL\bin\Release\net10.0\Cpp2IL.dll`.

Проверка форматов вывода:

```powershell
dotnet Cpp2IL.dll --list-output-formats
```

Нужен `dummydll`.

## 5. Генерация dummy DLL

```powershell
dotnet Cpp2IL.dll `
  --game-path "D:\SteamLibrary\steamapps\common\Hard Bullet\bin" `
  --output-as dummydll `
  --output-to "D:\Projects\Hard Multiplayer\tools\.cache\dummy"
```

Результат — 135 DLL, включая `Assembly-CSharp.dll`, `UnityEngine.CoreModule.dll`,
`Il2Cppmscorlib.dll`. Это **не** рабочие сборки, а скелеты типов и сигнатур для
Il2CppInterop.

Cpp2IL может написать в логе `Using actual IL2CPP Metadata version 106`, хотя в заголовке
стоит `107`. Это нормально: v107 не меняет формат относительно 106.1 (Unity просто
подняла номер), и Cpp2IL использует совместимый путь разбора.

Cpp2IL сам находит `GameAssembly.dll` и `global-metadata.dat` по папке игры. Если
автоопределение сломалось, есть `--exe-name`, `--force-binary-path`,
`--force-metadata-path`.

## 6. Генерация interop

```powershell
Expand-Archive Il2CppInterop.CLI.1.5.3.zip .\interop-cli -Force

dotnet .\interop-cli\net6.0\Il2CppInterop.CLI.dll generate `
  --input "D:\Projects\Hard Multiplayer\tools\.cache\dummy" `
  --output "D:\SteamLibrary\steamapps\common\Hard Bullet\bin\BepInEx\interop" `
  --unity "D:\SteamLibrary\steamapps\common\Hard Bullet\bin\BepInEx\unity-libs" `
  --game-assembly "D:\SteamLibrary\steamapps\common\Hard Bullet\bin\GameAssembly.dll"
```

`--unity` указывает на оригинальные Unity-сборки, которые BepInEx скачивает в
`BepInEx\unity-libs`. Для Unity 6.5 нужен архив `6000.5.8.zip` (без `f1`):

```
https://unity.bepinex.dev/libraries/6000.5.8.zip
```

Результат — 168 сборок в `BepInEx\interop`.

## 7. Настройка BepInEx

`BepInEx\config\BepInEx.cfg`:

```ini
[IL2CPP]
UpdateInteropAssemblies = false
PreloadIL2CPPInteropAssemblies = true
```

`PreloadIL2CPPInteropAssemblies = true` оставлен включённым: мод ссылается на игровые
типы, и они должны быть загружены до плагинов.

## 8. Что происходит при запуске

При старте BepInEx:

1. `winhttp.dll` (doorstop) загружает `dotnet\` и BepInEx;
2. chainloader читает `BepInEx\interop`, потому что автообновление выключено;
3. создаются прокси-типы Il2CppInterop;
4. загружается `HardMultiplayer.dll` из `BepInEx\plugins`;
5. `Plugin.Load()` создаёт `RelayClient` и `GhostDirector`.

В логе встречается предупреждение:

```
Class::Init signatures have been exhausted, using a substitute!
```

Оно не фатально: Il2CppInterop не нашёл точную сигнатуру `Class::Init` и использует
заменитель. Chainloader при этом доходит до загрузки плагинов.

Без подключённого шлема игра завершается на OpenXR:

```
XR_ERROR_FORM_FACTOR_UNAVAILABLE
```

Код выхода `-1073741819` (`0xC0000005`). Это ограничение окружения, а не мода. В текущем
окружении лог обрывается на `Chainloader initialized`: до `Plugin.Load()` дело не
доходит, поэтому проверить игровые вызовы без шлема нельзя. Для проверки протокола,
relay и клиента используется mock-game; спавн, бочки, свет и манифестацию нужно
проверять со шлемом.

## 9. Найденные игровые API

Всё, что использует мод, собрано здесь. Имена и сигнатуры — из interop-сборок
`Assembly-CSharp.dll`.

### 9.1. Игрок

```csharp
PlayerRoot.Instance            // static PlayerRoot
PlayerRoot.IsInitialized       // static bool
PlayerRoot.PlayerFoot          // Transform
PlayerRoot.PlayerHead          // Transform
PlayerRoot.PlayerDirection     // Transform
PlayerRoot.HealthContainer     // HealthContainer
```

`PlayerRoot.PlayerFoot.position` — позиция игрока, `PlayerDirection.forward` — направление
взгляда. `HealthContainer.CurrentHealth` и `IsHealthContainerEmpty` дают HP и признак
смерти.

### 9.2. Враги

```csharp
EnemyFactory.Factory           // static EnemyFactory
IProduct<EnemyRoot> EnemyFactory.GetProduct(
    Vector3 position,
    Quaternion rotation,
    float scale,
    bool instantSpawn = false,
    bool startAI = true)

EnemyProduct.Product           // EnemyRoot
```

`GetProduct` — основной способ спавна. Мод передаёт `instantSpawn: true`, `startAI: true`
и поворот лицом к игроку. `EnemyRoot` имеет:

```csharp
HealthContainer HealthContainer
FSMAI FSMAI
Blackboard Blackboard
void ReturnToPool()
```

`HealthContainer`:

```csharp
float CurrentHealth
float MaximumHealth
float HealthPercent
bool IsHealthContainerEmpty
void Kill()
```

Мод не вызывает `Kill()` и не меняет HP: только читает состояние.

### 9.3. Бочки

```csharp
ExplodingBarrel.Trigger()
ExplodingBarrel.Activate()
ExplodingBarrel.Deactivate()
ExplodingBarrel.SubtractTime(float)
ExplodingBarrel.DelayedExplosionRoutine()
```

`Trigger()` запускает штатное поведение взрыва. Мод клонирует существующую бочку через
`Object.Instantiate`, ставит в точку и вызывает `Trigger()`. Если клонирование не
удалось, двигает существующую бочку (fallback).

### 9.4. Текст

```csharp
PlayerTextOverlay.SetText(string)
PlayerTextOverlay.ClearText()
```

Используется для шёпота и показа кода комнаты. Текст живёт 4 секунды, затем мод вызывает
`ClearText()`.

### 9.5. Unity-обёртки

Il2CppInterop поддерживает:

```csharp
Object.FindObjectsOfType<T>()
Object.FindObjectOfType<T>()
Object.Instantiate<T>(T original, Vector3 position, Quaternion rotation)
Object.Destroy(Object obj, float t)
```

`FindObjectsOfType<T>()` возвращает `T[]` и работает для `EnemyRoot`,
`ExplodingBarrel`, `BoxCollider`, `Rigidbody`, `Light`.

### 9.6. Сцены

```csharp
SceneManager.GetActiveScene().name
```

По имени сцены мод понимает, что пора пересчитать карту.

## 10. Инъекция MonoBehaviour

`GhostDirector` — managed-класс, унаследованный от `MonoBehaviour`, с конструктором
`IntPtr`:

```csharp
public GhostDirector(IntPtr pointer) : base(pointer) { }
```

BepInEx `BasePlugin.AddComponent<T>()` автоматически регистрирует такие типы через
`ClassInjector`. Важное ограничение: `ClassInjector` инжектит только поля типов
`Il2CppStringField`, `Il2CppReferenceField<T>`, `Il2CppValueField<T>`. Обычные managed-
поля (`float`, `Dictionary<string,float>`, ссылки на другие managed-классы) остаются в
managed-памяти и не участвуют в IL2CPP-сериализации. Поэтому в `GhostDirector` можно
держать `_energy`, `_cooldowns`, `_game` и т.п. без `Il2Cpp*Field`.

## 11. Как исследовать дальше

### Через interop и ilspycmd

```powershell
ilspycmd -t EnemyFactory "D:\SteamLibrary\steamapps\common\Hard Bullet\bin\BepInEx\interop\Assembly-CSharp.dll"
ilspycmd -t PlayerRoot   "...\Assembly-CSharp.dll"
ilspycmd -t ExplodingBarrel "...\Assembly-CSharp.dll"
```

Или открой `Assembly-CSharp.dll` в ILSpy/dnSpy. Это прокси-сборки: тела методов —
заглушки, но сигнатуры, поля и наследование настоящие.

### Через Cpp2IL

```powershell
dotnet Cpp2IL.dll --game-path "...\bin" --output-as isil --output-to .\cpp2il_out
```

Дамп псевдокода полезен, когда нужно понять поведение метода (например, как
`ExplodingBarrel.Trigger()` выбирает задержку). Это тяжёлая операция; для повседневной
работы хватает interop-сигнатур.

### Поиск по строкам

```powershell
Select-String -Path .\cpp2il_out\*.cs -Pattern 'DelayedExplosion|SubtractTime'
```

## 12. Обновление после патча игры

1. Проверь metadata: если версия изменилась (например, 108), старые dummy DLL могут не
   подойти.
2. Обнови Cpp2IL до свежего master.
3. Перегенерируй dummy DLL и interop.
4. Проверь, что `BepInEx\interop` содержит `Assembly-CSharp.dll` и базовые Unity-модули.
5. Пересобери мод. Если сигнатуры изменились, компилятор укажет на расхождения.
6. Запусти игру со шлемом и проверь лог.

Если игра перешла на новую версию Unity, может понадобиться новый BepInEx 6 be и новый
архив `unity-libs`. Версии в этом документе — проверенная комбинация для
`6000.5.8f1` / v107.

## 13. Ограничения разведки

- Без VR нельзя проверить, как игра ведёт себя в реальной сцене: спавн, урон, свет,
  смерть игрока.
- `Class::Init signatures have been exhausted` может скрывать редкие проблемы с
  generic-методами. Если мод падает на конкретном вызове, смотри `LogOutput.log` и
  `Player.log`.
- Названия типов и методов могут быть обфусцированы в других сборках; в
  `Assembly-CSharp.dll` они читаемые.
- `EnemyKind` в моде — метка, а не выбор префаба: `GetProduct` не принимает тип врага.
  Для реальных типов нужно искать отдельные фабрики/префабы и менять `GameBridge`.
