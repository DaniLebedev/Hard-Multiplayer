# Установка и запуск

Пошаговая инструкция: от чистой машины до сессии с другом. Если что-то не работает —
смотри [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## 1. Что нужно

| Компонент | Версия | Зачем |
| --- | --- | --- |
| Windows | 10/11 x64 | Игра и мод. |
| Hard Bullet | Steam-версия, build 26187433+ | Сама игра. |
| VR-шлем | OpenXR или SteamVR | Для реальной игры. Без шлема игра закрывается на старте. |
| .NET SDK | 10.0+ (проверено на 10.0.400) | Cpp2IL master; мод собирается и на 6+. |
| Node.js | 20+ (проверено на 24) | Relay, клиент призрака, mock-game. |
| PowerShell | 5.1+ | Скрипты. |
| Git | любая свежая | Клонирование и версии. |

Для разработки клиента **VR не нужен**: есть mock-game.

## 2. Клонирование и зависимости

```powershell
git clone <repo-url> "D:\Projects\Hard Multiplayer"
cd "D:\Projects\Hard Multiplayer"
npm install
```

`npm install` ставит зависимости всех workspace-пакетов: `shared`, `relay`, `ghost-app`,
`tools/mock-game`.

## 3. Установка BepInEx 6

Мод работает на **BepInEx 6.0.0-be.791 Unity.IL2CPP x64**. MelonLoader не подходит: он
не понимает metadata v107 (Unity 6.5).

1. Закрой Hard Bullet.
2. Скачай архив:

   ```
   https://builds.bepinex.dev/projects/bepinex_be/791/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.791%2Bb782da4.zip
   ```

3. Распакуй **в папку `bin` игры**, а не в корень Steam-библиотеки:

   ```
   D:\SteamLibrary\steamapps\common\Hard Bullet\bin\
   ```

   После распаковки рядом с `Hard Bullet.exe` должны появиться:

   ```
   winhttp.dll
   doorstop_config.ini
   .doorstop_version
   BepInEx\
   dotnet\
   ```

4. Запусти игру один раз. BepInEx создаст `BepInEx\config\BepInEx.cfg` и папки
   `BepInEx\plugins`, `BepInEx\interop`, `BepInEx\unity-libs`.

   Без подключённого шлема игра может закрыться на инициализации OpenXR — это нормально,
   конфиги и логи при этом уже создаются.

5. **Обязательно** отключи Unity-логгер BepInEx. На Unity `6000.5.8f1` BepInEx
   `6.0.0-be.791` падает в `ClassInjector` ещё до загрузки плагинов, если этот логгер
   включён. В `BepInEx\config\BepInEx.cfg`:

   ```ini
   [Logging]
   UnityLogListening = false
   ```

   Скрипт `tools/scripts/install-mod.ps1` выставляет это автоматически. Если оставить
   `true`, в `ErrorLog.log` будет `AccessViolationException` в
   `Il2CppInterop.Runtime.Injection.ClassInjector`, а игра закроется без загрузки мода.

> Внешний `Hard Bullet.exe` в корне папки игры — это WPF-лаунчер. Он запускает
> `bin\Hard Bullet.exe` с `-openxr` или `-openvr`. BepInEx должен лежать именно в `bin`.

## 4. Interop для Unity 6.5 / metadata v107

BepInEx 6.0.0-be.791 не умеет сам генерировать interop для metadata v107. Нужен обходной
путь: Cpp2IL master → dummy DLL → Il2CppInterop CLI 1.5.3.

### 4.1. Автоматически

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\scripts\setup-interop.ps1 `
  -GameDir "D:\SteamLibrary\steamapps\common\Hard Bullet\bin"
```

Скрипт:

1. проверяет `GameAssembly.dll` и `global-metadata.dat`;
2. скачивает и распаковывает BepInEx, если его нет;
3. клонирует и собирает Cpp2IL master (нужен .NET 10 SDK);
4. генерирует dummy DLL в `tools\.cache\dummy`;
5. скачивает Il2CppInterop CLI 1.5.3;
6. генерирует interop в `BepInEx\interop`;
7. выставляет `[IL2CPP] UpdateInteropAssemblies = false`.

Генерация занимает несколько минут и требует интернет.

### 4.2. Вручную

```powershell
$game = "D:\SteamLibrary\steamapps\common\Hard Bullet\bin"
$tools = "D:\Projects\Hard Multiplayer\tools\.cache"
New-Item -ItemType Directory -Force $tools | Out-Null

# 1. Cpp2IL master
git clone --depth 1 https://github.com/SamboyCoding/Cpp2IL.git "$tools\Cpp2IL-src"
dotnet build "$tools\Cpp2IL-src\Cpp2IL\Cpp2IL.csproj" -c Release -f net10.0

# 2. Dummy DLL
dotnet "$tools\Cpp2IL-src\Cpp2IL\bin\Release\net10.0\Cpp2IL.dll" `
  --game-path "$game" `
  --output-as dummydll `
  --output-to "$tools\dummy"

# 3. Il2CppInterop CLI 1.5.3
Invoke-WebRequest `
  -Uri "https://github.com/BepInEx/Il2CppInterop/releases/download/v1.5.3/Il2CppInterop.CLI.1.5.3.zip" `
  -OutFile "$tools\interop-cli.zip"
Expand-Archive "$tools\interop-cli.zip" "$tools\interop-cli" -Force

# 4. Unity base libraries (если BepInEx\unity-libs пустая)
Invoke-WebRequest `
  -Uri "https://unity.bepinex.dev/libraries/6000.5.8.zip" `
  -OutFile "$game\BepInEx\unity-libs\6000.5.8.zip"
Expand-Archive "$game\BepInEx\unity-libs\6000.5.8.zip" "$game\BepInEx\unity-libs" -Force

# 5. Interop
dotnet "$tools\interop-cli\net6.0\Il2CppInterop.CLI.dll" generate `
  --input "$tools\dummy" `
  --output "$game\BepInEx\interop" `
  --unity "$game\BepInEx\unity-libs" `
  --game-assembly "$game\GameAssembly.dll"
```

> Версия Unity в URL — `6000.5.8` **без** суффикса `f1`. Именно так называет архив
> BepInEx; `6000.5.8f1.zip` отдаёт 404.

### 4.3. Отключи автообновление interop

Открой `BepInEx\config\BepInEx.cfg` и найди секцию `[IL2CPP]`:

```ini
[IL2CPP]
UpdateInteropAssemblies = false
```

Если оставить `true`, BepInEx попытается перегенерировать сборки сам, снова упадёт на
v107 и может испортить рабочую папку `interop`.

Проверка: в `BepInEx\interop` должно быть около 168 DLL, включая `Assembly-CSharp.dll`,
`UnityEngine.CoreModule.dll`, `Il2Cppmscorlib.dll`.

## 5. Сборка мода

Укажи путь к игре одним из способов:

```powershell
# Вариант 1: переменная окружения
$env:HARDBULLET_DIR = "D:\SteamLibrary\steamapps\common\Hard Bullet\bin"
dotnet build .\mod\HardMultiplayer.csproj -c Release

# Вариант 2: параметр MSBuild
dotnet build .\mod\HardMultiplayer.csproj -c Release `
  -p:GameDir="D:\SteamLibrary\steamapps\common\Hard Bullet\bin"
```

Либо впиши путь по умолчанию в `mod\HardMultiplayer.csproj`:

```xml
<GameDir Condition="'$(GameDir)' == ''">D:\SteamLibrary\steamapps\common\Hard Bullet\bin</GameDir>
```

После сборки `HardMultiplayer.dll` автоматически копируется в `BepInEx\plugins`.
Мод не добавляет собственные MonoBehaviour: на Unity 6.5 BepInEx ClassInjector крашит
игру. Вместо этого `Patches.cs` ставит Harmony-postfix на `PlayerRoot.Update` и вызывает
`GhostDirector.Tick()`; `0Harmony.dll` уже входит в BepInEx.

Проверь:

```powershell
Get-Item "$env:HARDBULLET_DIR\BepInEx\plugins\HardMultiplayer.dll"
```

Или используй скрипт:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\scripts\install-mod.ps1 `
  -GameDir "D:\SteamLibrary\steamapps\common\Hard Bullet\bin"
```

## 6. Конфиг мода

Файл: `BepInEx\config\hardmultiplayer.ghost.cfg`. Создаётся при первом запуске плагина.
Если игра ещё ни разу не доходила до загрузки плагинов, скопируй пример:

```powershell
Copy-Item .\mod\hardmultiplayer.ghost.cfg.example `
  "$env:HARDBULLET_DIR\BepInEx\config\hardmultiplayer.ghost.cfg"
```

Основные параметры:

| Секция | Ключ | По умолчанию | Описание |
| --- | --- | --- | --- |
| `General` | `Enabled` | `true` | Включить мод. |
| `Relay` | `Url` | `ws://127.0.0.1:8080/ws` | Адрес relay. Для интернета — `wss://.../ws`. |
| `Relay` | `Room` | `TEST` | Код комнаты, 4–8 символов `A–Z/0–9`. |
| `Relay` | `Token` | пусто | Должен совпадать с `RELAY_TOKEN` на relay. |
| `Relay` | `Name` | `Призрак` | Имя игры в комнате. |
| `Tuning` | `SnapshotHz` | `10` | Частота снапшотов, 1–30. |
| `Tuning` | `MaxEnergy` | `100` | Максимум энергии, 20–500. |
| `Tuning` | `EnergyRegen` | `6` | Восстановление энергии в секунду. |

Для игры через интернет:

```ini
[Relay]
Url = wss://ghost.example.com/ws
Room = K7Q2
Token = <секрет>
```

Код комнаты также показывается игроку текстом в игре при первом подключении.

## 7. Локальный запуск

### 7.1. Собери клиент и запусти relay

```powershell
npm run build
npm start
```

Relay слушает `0.0.0.0:8080`:

- клиент призрака — `http://127.0.0.1:8080/`;
- WebSocket — `ws://127.0.0.1:8080/ws`;
- здоровье — `http://127.0.0.1:8080/health`.

Или скриптом:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\scripts\run-relay.ps1
```

### 7.2. Запусти игру

Убедись, что шлем подключён, и запусти Hard Bullet через Steam. В
`BepInEx\LogOutput.log` должно появиться:

```
Hard Multiplayer загружен.
Комната: TEST. Relay: ws://127.0.0.1:8080/ws
```

### 7.3. Позови друга

Друг открывает `http://<IP-твоего-ПК>:8080/`, вводит код комнаты и имя.

- В одной сети: `ipconfig` → IPv4-адрес, например `http://192.168.1.50:8080/`.
- Разреши входящий TCP 8080 в брандмауэре Windows для частной сети.
- Для интернета — см. следующий раздел.

## 8. Игра через интернет

### 8.1. Вариант A: VPS

1. Возьми минимальный VPS (1 vCPU, 1 ГБ RAM достаточно) с Node.js 20+.
2. Скопируй репозиторий, установи зависимости и собери клиент:

   ```bash
   npm ci
   npm run build
   ```

3. Задай переменные:

   ```bash
   export PORT=8080
   export HOST=127.0.0.1
   export RELAY_TOKEN="$(openssl rand -hex 24)"
   export ROOM_TTL_MINUTES=15
   npm start
   ```

4. Поставь nginx или Caddy как reverse proxy с HTTPS. Пример nginx:

   ```nginx
   server {
     listen 443 ssl http2;
     server_name ghost.example.com;

     ssl_certificate     /etc/letsencrypt/live/ghost.example.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/ghost.example.com/privkey.pem;

     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_read_timeout 3600s;
     }
   }
   ```

5. В конфиге мода:

   ```ini
   [Relay]
   Url = wss://ghost.example.com/ws
   Token = <тот же RELAY_TOKEN>
   ```

6. Друг открывает `https://ghost.example.com/`.

`RELAY_TOKEN` защищает только роль `game`: без него посторонний не сможет притвориться
игрой и слать поддельные снапшоты. Призраку токен не нужен.

### 8.2. Вариант B: Cloudflare Tunnel (без VPS)

Подходит для быстрых тестов. Нужен `cloudflared`.

```powershell
# терминал 1
npm start

# терминал 2
cloudflared tunnel --url http://127.0.0.1:8080
```

`cloudflared` выведет адрес вида `https://random-words.trycloudflare.com`. Тогда:

- друг открывает этот адрес;
- в конфиге мода: `Url = wss://random-words.trycloudflare.com/ws`.

Тоннель поддерживает WebSocket. Быстрые `trycloudflare`-туннели живут, пока запущен
процесс, и не гарантируют постоянный адрес. Для постоянной игры используй именованный
туннель или VPS.

## 9. Разработка без VR (mock-game)

Mock-game притворяется игрой и говорит на протоколе v2.

```powershell
# терминал 1: relay
npm run build
npm start

# терминал 2: фальшивая игра
npm run dev:mock -- --room=TEST

# терминал 3: клиент с горячей перезагрузкой
npm run dev:ghost
```

Открой `http://127.0.0.1:5173/?room=TEST` (Vite) или `http://127.0.0.1:8080/` (собранный
клиент). Mock-game симулирует игрока, врагов, бочки, энергию, кулдауны и 3D-карту, поэтому
можно проверять полёт, preview и способности без шлема.

Перед запуском настоящей игры **останови mock-game**, иначе в комнате `TEST` уже будет
игра и мод получит `room_full`. Либо используй разные коды комнат.

## 10. Обновление игры

После патча Hard Bullet:

1. Проверь версию Unity и metadata в `Player.log` / `global-metadata.dat`.
2. Перегенерируй dummy DLL и interop (раздел 4). Старые interop-сборки могут не
   совпасть с новыми сигнатурами.
3. Оставь `UpdateInteropAssemblies = false` и `UnityLogListening = false`.
4. Пересобери мод.
5. Проверь `BepInEx\LogOutput.log` на ошибки загрузки плагина.

Если игра обновилась до новой версии Unity, может понадобиться свежий BepInEx 6 be и
новая версия Cpp2IL. Версии из этого документа — проверенная комбинация для
`6000.5.8f1`, metadata v107.

## 11. Удаление

1. Удали `BepInEx\plugins\HardMultiplayer.dll`.
2. При желании удали `BepInEx\config\hardmultiplayer.ghost.cfg`.
3. Полностью убрать BepInEx: удали `BepInEx\`, `dotnet\`, `winhttp.dll`,
   `doorstop_config.ini`, `.doorstop_version` из `bin`.
4. Relay: останови процесс и удали папку/сервис.

Мод не изменяет файлы игры и не требует переустановки Hard Bullet.
