# Если что-то не работает

Сначала определи, какой слой сломан:

| Симптом | Слой | Куда смотреть |
| --- | --- | --- |
| Игра закрывается сразу после запуска | Игра / OpenXR | `Player.log` |
| В логе нет `Hard Multiplayer загружен` | BepInEx / мод | `BepInEx\LogOutput.log` |
| Клиент призрака не открывается | Relay / статика | `http://<host>:8080/health` |
| Клиент открывается, но нет карты | Комната / мод | статус в шапке, журнал |
| Команды не выполняются | Мод / игра | `ack` в журнале, лог мода |
| Всё работало, потом перестало | Сеть / кэш | переподключение, DevTools |

## 1. Игра и BepInEx

### 1.1. Игра закрывается сразу, без окна

Проверь `%USERPROFILE%\AppData\LocalLow\GexagonVR\Hard Bullet\Player.log`.

Если там:

```
XR_ERROR_FORM_FACTOR_UNAVAILABLE
```

— не подключён VR-шлем или не запущен OpenXR/SteamVR. Это не ошибка мода. Подключи
шлем, запусти SteamVR (если нужен) и попробуй снова.

Код выхода `-1073741819` (`0xC0000005`) в этой ситуации — следствие падения VR-инициализации,
а не доказательство проблемы с BepInEx.

### 1.2. BepInEx не загружается

Проверь:

- BepInEx распакован в `...\Hard Bullet\bin`, рядом с `Hard Bullet.exe`, а не в корень
  папки игры;
- есть `winhttp.dll`, `doorstop_config.ini`, `BepInEx\core`;
- антивирус не удалил `winhttp.dll` (иногда Doorstop ложно считается угрозой);
- игра запускается из Steam, а не через сторонний лаунчер, который подменяет рабочую
  папку.

В `BepInEx\LogOutput.log` должна быть строка вида:

```
[Info   :   BepInEx] BepInEx 6.0.0-be.791 ...
```

Если лога нет вообще — BepInEx не внедрился.

### 1.3. `Unsupported metadata version found! We support 23-106, got 107`

Это MelonLoader. Он не подходит для Unity 6.5. Удали MelonLoader (`MelonLoader\`,
`version.dll` и т.п.) и используй BepInEx 6 по инструкции
[`SETUP.md`](SETUP.md#3-установка-bepinex-6).

### 1.4. BepInEx пытается сам генерировать interop и падает

Симптомы:

- `BepInEx\interop` пустая или в ней мало файлов;
- в логе ошибки Cpp2IL / Il2CppInterop;
- игра падает до загрузки плагинов.

Проверь `BepInEx\config\BepInEx.cfg`:

```ini
[IL2CPP]
UpdateInteropAssemblies = false
```

Если стоит `true`, BepInEx снова запустит старый пайплайн. Перегенерируй interop вручную
(раздел 4 в [`SETUP.md`](SETUP.md#4-interop-для-unity-65--metadata-v107)) и оставь
`false`.

### 1.5. В `BepInEx\interop` меньше 150 DLL

Генерация не завершилась. Удали папку `interop` и повтори:

```powershell
dotnet .\interop-cli\net6.0\Il2CppInterop.CLI.dll generate `
  --input .\tools\.cache\dummy `
  --output "$game\BepInEx\interop" `
  --unity "$game\BepInEx\unity-libs" `
  --game-assembly "$game\GameAssembly.dll"
```

Частые причины:

- `--unity` указывает на пустую `unity-libs` — скачай `6000.5.8.zip`;
- dummy DLL неполные — перегенерируй Cpp2IL;
- не хватило памяти — закрой лишние процессы, попробуй `--no-parallel`.

### 1.6. `Interop assemblies are possibly out of date`

Это предупреждение BepInEx, а не ошибка: он сравнивает хэш interop-сборок с ожидаемым.
Если interop только что сгенерирован вручную, хэш просто неизвестен. Чтобы убрать
предупреждение, создай файл `BepInEx\interop\assembly-hash.txt` с хэшем из лога:

```powershell
Set-Content `
  "D:\SteamLibrary\steamapps\common\Hard Bullet\bin\BepInEx\interop\assembly-hash.txt" `
  "1035a9ef2283168562ea60d1e9cead90"
```

Хэш бери именно из своего лога — после обновления игры или BepInEx он изменится. Если
игра действительно обновилась, не подавляй предупреждение, а перегенерируй interop.

### 1.7. Плагин не загружается

В `LogOutput.log` ищи:

```
[Info   :   BepInEx] Loading [Hard Multiplayer 0.1.0]
```

Если строки нет:

- `HardMultiplayer.dll` лежит не в `BepInEx\plugins`;
- DLL собран под другую версию BepInEx;
- в логе есть `ReflectionTypeLoadException` или `FileNotFoundException` — не хватает
  interop-сборки. Проверь, что `Assembly-CSharp.dll`, `UnityEngine.CoreModule.dll`,
  `Il2Cppmscorlib.dll` есть в `BepInEx\interop`.

Если есть `Class::Init signatures have been exhausted, using a substitute!` — это
предупреждение, не ошибка. Плагин может работать.

### 1.8. Ошибка сборки `CS0656: Missing compiler required member ... NullableAttribute`

Это коллизия nullable-атрибутов в сгенерированных interop-сборках. В проекте уже есть
`mod\NullableAttributes.cs` и `<Nullable>disable</Nullable>`. Если ошибка появилась
снова:

- не включай nullable в `HardMultiplayer.csproj`;
- не добавляй пакет, который приносит свои `NullableAttribute`;
- проверь, что `NullableAttributes.cs` включён в компиляцию (он лежит в `mod\` и
  подхватывается SDK по умолчанию).

### 1.9. `dotnet build` не находит `Assembly-CSharp.dll`

`GameDir` указывает не туда. Нужна папка `bin`, где лежат `Hard Bullet.exe`,
`GameAssembly.dll` и `BepInEx\interop`. Проверь:

```powershell
dotnet build .\mod\HardMultiplayer.csproj -c Release `
  -p:GameDir="D:\SteamLibrary\steamapps\common\Hard Bullet\bin"
```

### 1.10. Мод загрузился, но карта не приходит

Смотри `LogOutput.log`:

- `GhostDirector готов` — объект создан;
- `Relay подключён` — WebSocket открыт;
- `Карта отправлена: сцена '...', стен N` — скан прошёл.

Если карты нет:

- игра ещё в меню/загрузке, `PlayerRoot.IsInitialized == false`;
- сцена без `BoxCollider` (маловероятно);
- `ScanMap` кидает исключение — ищи `Hard Multiplayer API error (map: ...)`.

Карта пересчитывается при смене сцены. В меню она может быть пустой — это нормально.

## 2. Relay

### 2.1. `EADDRINUSE: address already in use 0.0.0.0:8080`

Порт занят другим relay или mock-game. Варианты:

```powershell
# найти процесс
Get-NetTCPConnection -LocalPort 8080 | Select-Object OwningProcess
Get-Process -Id <PID>

# или запустить на другом порту
$env:PORT = 8081
npm start
```

Не забудь поменять `Relay.Url` в конфиге мода на новый порт.

### 2.2. Браузер показывает `503 Ghost client is not built yet`

Relay не нашёл `ghost-app/dist`. Собери клиент:

```powershell
npm run build
```

Или укажи путь явно:

```powershell
$env:PUBLIC_DIR = "D:\Projects\Hard Multiplayer\ghost-app\dist"
npm start
```

### 2.3. WebSocket отдаёт 404

Relay принимает upgrade только по `/ws`. Проверь URL:

```
ws://127.0.0.1:8080/ws
wss://ghost.example.com/ws
```

Частая ошибка — `ws://host:8080/` без `/ws`.

### 2.4. `bad_token`

На relay задан `RELAY_TOKEN`, а мод прислал пустой или другой токен. Либо убери
`RELAY_TOKEN` из окружения relay, либо впиши тот же токен в:

```ini
[Relay]
Token = <секрет>
```

Токен нужен только игре, призраку — нет.

### 2.5. `room_full`

В комнате уже есть игра или два призрака. Самая частая причина — **запущен mock-game**,
который занял комнату `TEST`. Останови его или используй другой код комнаты.

Проверка:

```powershell
curl http://127.0.0.1:8080/api/rooms/TEST
```

Ответ покажет `game: true/false`, `ghosts`, `peers`.

### 2.6. `protocol_mismatch`

Версии не совпадают. Обнови одновременно relay, `ghost-app` и мод. Версия должна быть
`1` в `shared/ts/protocol.ts`, `shared/csharp/Protocol.cs` и в собранных артефактах.

### 2.7. `no_game`

В комнате нет game-клиента:

- игра не запущена;
- мод выключен в конфиге (`General/Enabled = false`);
- игра подключилась к другому relay/комнате;
- игра ещё не успела подключиться — подожди пару секунд.

### 2.8. Туннель Cloudflare обрывает соединение

Быстрые `trycloudflare`-туннели нестабильны и живут, пока запущен `cloudflared`.
Для постоянной игры:

- используй именованный туннель с постоянным доменом;
- или VPS с nginx/Caddy и `proxy_read_timeout 3600s`;
- проверь, что прокси не буферизует WebSocket и передаёт `Upgrade`/`Connection`.

Мод сам переподключается с задержкой до 15 секунд, клиент — тоже.

## 3. Клиент призрака

### 3.1. «ОЖИДАНИЕ КАРТЫ»

Карта ещё не пришла. Причины:

- игра не в комнате (`no_game`);
- игра в меню, карта пустая;
- мод не отправил карту — смотри лог;
- клиент подключился к другому relay.

Проверь статус в шапке: «ОНЛАЙН» означает, что WebSocket открыт, но не что игра есть.
`/api/rooms/<код>` покажет, есть ли `game`.

### 3.2. Карта есть, но игрок не двигается

Снапшоты не приходят. Проверь:

- в журнале нет потока событий;
- ping растёт;
- в логе мода есть `Relay подключён`, но нет отправок.

Если снапшоты идут, а игрок стоит — возможно, игра на паузе или игрок в меню.

### 3.3. Способность не срабатывает

Смотри журнал и тосты:

| Сообщение / `error` | Что делать |
| --- | --- |
| `Нет соединения с relay` | Проверь relay и статус. |
| `Перезарядка: N с` | Подожди; кулдаун общий для всех призраков. |
| `Не хватает энергии` | Подожди восстановления (6/с). |
| `Нужен хаос 15%` | Сделай несколько действий, чтобы поднять хаос. |
| `no_game` | Игра не в комнате. |
| `failed` | Игровой API не смог: нет префаба бочки, объект исчез, сцена не готова. Смотри лог мода. |

Помни: клиент проверяет по своим прогнозам, relay — по последнему снапшоту, мод — по
авторитетным значениям. Небольшие расхождения нормальны; окончательное слово за модом.

### 3.4. Клиент показывает старое состояние после обновления

Браузер закэшировал старый JS. Сделай hard refresh (`Ctrl+F5`) или пересобери и
перезапусти relay. Vite-сборка использует хэши в именах файлов, но `index.html`
кэшируется как `no-cache`.

### 3.5. Нет звука

Браузеры блокируют автозапуск аудио до первого клика. Кликни по странице или нажми
«Подключиться». Кнопка `M` включает/выключает звук; проверь, что он не выключен.

### 3.6. На телефоне неудобно

Клиент адаптивен, но управление рассчитано на клавиатуру и мышь. На телефоне доступны
клики по карте и карточкам; WASD/QE заменяются на кнопки только частично. Для игры
лучше ноутбук.

## 4. Мод в игре

### 4.1. Спавн врага отвечает `failed`

`EnemyFactory.Factory` может быть `null` вне игровой сцены. Также `GetProduct` может
кинуть исключение, если сцена ещё грузится. Подожди, пока игрок появится в мире, и
повтори. В логе будет:

```
EnemyFactory.GetProduct не сработал: ...
```

### 4.2. Бочка не появляется

Мод ищет существующую `ExplodingBarrel` в сцене и клонирует её. Если в сцене нет ни
одной бочки, `ThrowBarrel` вернёт `false`. Это ограничение v1: нет глобального префаба
бочки. В сценах с бочками работает.

### 4.3. Полтергейст ничего не делает

- в радиусе 15 м нет источников света;
- все `Rigidbody` кинематические или далеко;
- сцена использует baked-освещение без `Light`-компонентов.

Мод возвращает `affected = 0`, но команда считается успешной. Это нормально для тёмных
сцен без динамического света.

### 4.4. Манифестация не видна

- призрак далеко от игрока или за стеной;
- сфера появляется на позиции камеры призрака + 1.2 м по Y;
- если камера ещё не отправлялась, используется позиция за игроком.

Сфера — это `Sphere` с `MeshRenderer` и `Light`. Если материалы сцены переопределяют
рендер, видимость может отличаться. В v1 это заглушка, а не полноценная модель.

### 4.5. Шёпот не появляется

`PlayerTextOverlay` может быть не активен в меню. В игровой сцене текст показывается на
4 секунды. Если игрок умер/загружается, оверлей может быть скрыт.

### 4.6. Игра тормозит после долгой сессии

Проверь:

- сколько врагов в сцене (мод отправляет до 60, но игра может иметь больше);
- сколько бочек (мод читает до 30);
- не накопились ли `FlickerEffect` (они удаляются по таймеру);
- не растёт ли очередь relay (ограничена 256).

Если проблема повторяется, уменьши `SnapshotHz` до 5 и `MaxEnergy`/частоту действий.

## 5. Логи и диагностика

| Что | Где |
| --- | --- |
| BepInEx | `...\Hard Bullet\bin\BepInEx\LogOutput.log` |
| BepInEx errors | `...\Hard Bullet\bin\BepInEx\ErrorLog.log` |
| Unity player | `%USERPROFILE%\AppData\LocalLow\GexagonVR\Hard Bullet\Player.log` |
| Relay | консоль процесса / systemd journal / pm2 logs |
| Клиент | DevTools → Console и Network → WS |

Полезные команды:

```powershell
# здоровье relay
curl http://127.0.0.1:8080/health

# кто в комнате
curl http://127.0.0.1:8080/api/rooms/TEST

# хвост лога мода
Get-Content "...\BepInEx\LogOutput.log" -Tail 80 -Wait

# порт
Get-NetTCPConnection -LocalPort 8080
```

`/health` возвращает:

```json
{ "ok": true, "protocol": 1, "rooms": 1, "peers": 2, "uptime": 143 }
```

## 6. Полный сброс

Если ничего не помогает:

1. Закрой игру, relay, mock-game и вкладки клиента.
2. Удали `BepInEx\interop` и `BepInEx\plugins\HardMultiplayer.dll`.
3. Перегенерируй interop по [`SETUP.md`](SETUP.md#4-interop-для-unity-65--metadata-v107).
4. Пересобери мод.
5. Убедись, что `UpdateInteropAssemblies = false`.
6. Запусти relay, проверь `/health`.
7. Запусти игру, проверь `Hard Multiplayer загружен` и код комнаты.
8. Подключи клиента, проверь карту и снапшоты.
9. Только потом проверяй способности.

Если проблема воспроизводится, приложи к описанию:

- версию игры и Unity;
- версию BepInEx и interop;
- `LogOutput.log` и `Player.log`;
- вывод `/health` и `/api/rooms/<код>`;
- что именно нажал призрак и какой `ack` получил.
