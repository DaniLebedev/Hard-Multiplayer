# Протокол v1

Источник истины:

- [`shared/ts/protocol.ts`](../shared/ts/protocol.ts) — типы, способности, константы;
- [`shared/csharp/Protocol.cs`](../shared/csharp/Protocol.cs) — C#-зеркало для мода.

При изменении протокола **сначала** правь TypeScript, затем C#. Версия должна совпадать
на relay, в моде и в клиенте.

## 1. Транспорт

| Параметр | Значение |
| --- | --- |
| Транспорт | WebSocket, текстовые фреймы |
| Endpoint | `ws://<host>:8080/ws` или `wss://<host>/ws` |
| Формат | JSON, одно сообщение — один объект с полем `t` |
| Максимальный размер | relay — 2 МБ, мод — 4 МБ |
| Handshake | первое сообщение обязательно `hello`, таймаут 10 с |
| Версия | `1` (`PROTOCOL_VERSION`) |
| Сжатие | отключено (`perMessageDeflate: false`) |
| Ping | WebSocket ping relay каждые 30 с; прикладной `ping`/`pong` — по желанию |

Relay принимает upgrade только по пути `/ws`. Остальные пути отдают HTTP или 404.

## 2. Конверт

У каждого сообщения есть строковое поле `t`. Остальные поля зависят от типа.

```json
{ "t": "ping", "ts": 1760000000000 }
```

Направления:

- `game → relay` — игра;
- `relay → game` — команды, камера, чат;
- `ghost → relay` — команды, камера, чат, ping;
- `relay → ghost` — состояние, карта, события, ack;
- `relay → all` — `peer`, `chat`.

## 3. Handshake

```
Клиент                          Relay
  │                               │
  │──── hello ───────────────────►│  проверка t, protocol, room, role, token
  │                               │
  │◄─── welcome ──────────────────│  peerId, список участников
  │◄─── [map] ────────────────────│  если призрак и есть кэш
  │◄─── [snapshot] ───────────────│  если призрак и есть кэш
  │                               │
  │◄─── peer(joined) ─────────────│  остальным участникам
```

### `hello`

```json
{
  "t": "hello",
  "protocol": 1,
  "room": "TEST",
  "role": "ghost",
  "name": "Аня"
}
```

| Поле | Тип | Обяз. | Описание |
| --- | --- | --- | --- |
| `protocol` | number | да | Должен быть равен `1`. |
| `room` | string | да | 4–8 символов `A–Z`, `0–9`; приводится к верхнему регистру. |
| `role` | `"game"` \| `"ghost"` | да | Роль участника. |
| `token` | string | нет | Только для `game`, если на relay задан `RELAY_TOKEN`. |
| `name` | string | нет | До 24 символов, очищается от управляющих символов. |

### `welcome`

```json
{
  "t": "welcome",
  "protocol": 1,
  "room": "TEST",
  "peerId": "p_1a2b3c4d",
  "peers": [{ "id": "p_9f8e7d6c", "role": "game", "name": "VR" }],
  "serverTime": 1760000000000
}
```

### `peer`

```json
{ "t": "peer", "event": "joined", "peerId": "p_1a2b3c4d", "role": "ghost", "name": "Аня" }
```

`event` — `joined` или `left`.

### `error`

```json
{ "t": "error", "code": "bad_token", "message": "Неверный токен relay." }
```

## 4. Состояние игры

### `snapshot` (game → relay → ghost)

Отправляется с частотой `SnapshotHz` (по умолчанию 10 Гц).

```json
{
  "t": "snapshot",
  "seq": 412,
  "ts": 1760000000123,
  "scene": "Level_1",
  "player": {
    "pos": { "x": 1.2, "y": 0.1, "z": -3.4 },
    "yaw": 1.57,
    "vel": { "x": 0.3, "y": 0, "z": -0.8 },
    "hp": 87.5,
    "alive": true
  },
  "ghost": {
    "pos": { "x": 1.2, "y": 0.1, "z": -9.4 },
    "yaw": 1.57,
    "manifested": false,
    "stunned": false
  },
  "enemies": [
    { "id": 7, "kind": "runner", "pos": { "x": 4, "y": 0, "z": 2 }, "hp": 45, "state": "chase", "ghost": false }
  ],
  "props": [
    { "id": 3, "kind": "barrel", "pos": { "x": -2, "y": 0, "z": 5 }, "mass": 20 }
  ],
  "energy": 62.4,
  "maxEnergy": 100,
  "chaos": 18.2,
  "cooldowns": { "spawn_enemy": 3.4, "manifest": 12.1 },
  "stats": { "scares": 4, "kills": 2, "spawns": 5, "barrels": 1, "sessionTime": 143.2 }
}
```

| Поле | Описание |
| --- | --- |
| `seq` | Монотонный номер снапшота. |
| `ts` | Unix-время в миллисекундах. |
| `scene` | Имя активной сцены Unity. |
| `player.yaw` | Радианы, направление взгляда в плоскости XZ. |
| `player.vel` | Сглаженная скорость игрока. |
| `player.hp` / `alive` | Здоровье и признак жизни. |
| `ghost.pos` | Позиция камеры призрака (или позиция за игроком, если камера ещё не пришла). |
| `ghost.manifested` | Активна ли манифестация. |
| `ghost.stunned` | В v1 всегда `false` (стан не реализован). |
| `enemies` | До 60 ближайших живых врагов. |
| `enemies[].state` | `idle`, `chase`, `attack`, `dead` — вычисляется по дистанции до игрока. |
| `props` | До 30 взрывных бочек. |
| `energy` / `maxEnergy` | Текущая и максимальная энергия. |
| `chaos` | 0–100. |
| `cooldowns` | Оставшиеся секунды по каждой способности. |
| `stats` | Счётчики сессии. |

### `map` (game → relay → ghost)

```json
{
  "t": "map",
  "scene": "Level_1",
  "bounds": { "minX": -34, "minZ": -34, "maxX": 34, "maxZ": 34 },
  "walls": [
    { "x": 0, "z": 30, "w": 60, "d": 1, "h": 4 }
  ],
  "image": null
}
```

| Поле | Описание |
| --- | --- |
| `bounds` | Прямоугольник карты в мировых координатах. |
| `walls` | Прямоугольные препятствия (до 700). `x/z` — центр, `w/d` — размеры по X/Z, `h` — высота. |
| `image` | Зарезервировано под top-down картинку; в v1 `null`. |

Карта приходит при подключении и при смене сцены. Relay кэширует последнюю и отдаёт
новому призраку.

### `event` (game → relay → ghost)

```json
{ "t": "event", "kind": "enemy_spawned", "data": { "kind": "runner", "x": 4, "z": 2 }, "ts": 1760000000123 }
```

| `kind` | `data` |
| --- | --- |
| `enemy_spawned` | `kind`, `x`, `z` |
| `barrel_exploded` | зависит от игры; в v1 мод отправляет `scare` с `type: "barrel"` |
| `player_hit` | `damage`, `hp` |
| `player_died` | `hp` |
| `ghost_stunned` | зарезервировано |
| `manifest_start` | `x`, `y`, `z` |
| `manifest_end` | — |
| `scare` | `type`: `barrel`, `telekinesis`, `poltergeist`, `whisper`; координаты и доп. поля |
| `scene_changed` | `scene` |
| `info` | произвольные данные |

### `toast` (game → relay → ghost)

```json
{ "t": "toast", "text": "Игрок потерял 20 HP", "level": "warn" }
```

`level` — `info`, `warn` или `good`.

### `pong`

Ответ на `ping`, возвращает тот же `ts`.

## 5. Команды

### `cmd` (ghost → relay → game)

```json
{
  "t": "cmd",
  "id": "c_17",
  "ability": "spawn_enemy",
  "args": { "kind": "runner", "x": 4.2, "z": -8.1, "behind": true, "distance": 6 },
  "ts": 1760000000000
}
```

| Поле | Описание |
| --- | --- |
| `id` | Уникальный ID команды (до 64 символов), по нему приходит `ack`. |
| `ability` | Один из фиксированных ID. |
| `args` | Параметры; неизвестные поля отбрасываются. |
| `ts` | Время отправки, мс. |

### `ack` (game → relay → ghost)

```json
{ "t": "ack", "id": "c_17", "ok": true, "energy": 37.4, "cooldown": 8 }
```

При ошибке:

```json
{ "t": "ack", "id": "c_17", "ok": false, "error": "cooldown" }
```

`cooldown` — длительность кулдауна в секундах при успехе.

### Аргументы `CmdArgs`

| Поле | Тип | Где используется | Смысл |
| --- | --- | --- | --- |
| `kind` | string | `spawn_enemy` | `grunt`, `runner`, `shooter`, `heavy`. В v1 — метка для UI. |
| `x`, `y`, `z` | number | точечные способности | Мировые координаты. Если `x/z` нет, мод ставит точку за игроком. |
| `targetId` | number | `telekinesis` | ID врага из снапшота; иначе ближайшее тело. |
| `power` | number | `telekinesis` | Сила импульса, 1–25 (по умолчанию 8). |
| `duration` | number | `poltergeist`, `manifest` | Секунды; ограничивается модом. |
| `text` | string | `whisper` | До 180 символов. |
| `behind` | boolean | `spawn_enemy` | Подсказка клиенту/моду. Если координаты не переданы, мод использует точку за игроком. |
| `distance` | number | `spawn_enemy` | Расстояние за игроком, 2–16 м (по умолчанию 6). |
| `fuse` | number | `throw_barrel` | Зарезервировано; в v1 задержка определяется игрой. |
| `mode` | string | — | Зарезервировано. |

### Способности

| ID | Название | Цена | Кулдаун | Мин. хаос | Наведение | Клавиша |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `spawn_enemy` | Спавн врага | 25 | 8 с | 0 | точка | 1 |
| `throw_barrel` | Взрывная бочка | 15 | 4 с | 0 | точка | 2 |
| `telekinesis` | Телекинез | 10 | 2 с | 0 | сущность | 3 |
| `poltergeist` | Полтергейст | 8 | 6 с | 0 | точка | 4 |
| `manifest` | Манифестация | 30 | 20 с | 15 | на себя | 5 |
| `whisper` | Шёпот | 5 | 10 с | 0 | нет | 6 |

### Прирост хаоса

| Действие | Хаос |
| --- | ---: |
| `spawn_enemy` | +2 |
| `throw_barrel` | +4 |
| `telekinesis` | +1 |
| `poltergeist` | +5 |
| `manifest` | +12 |
| `whisper` | +1 |

Хаос затухает на 1.5 единицы в секунду и ограничен диапазоном 0–100.

## 6. Камера, чат, ping

### `camera` (ghost → relay → game)

```json
{ "t": "camera", "pos": { "x": 1.2, "y": 0.1, "z": -9.4 }, "yaw": 1.57, "ts": 1760000000000 }
```

Клиент отправляет её при движении и примерно раз в 90 мс. Мод использует позицию для
манифестации и для `ghost.pos` в снапшоте.

### `chat` (any → relay → others)

```json
{ "t": "chat", "from": "ghost", "text": "Бу!", "ts": 1760000000000 }
```

Relay пересылает чат всем, кроме отправителя. Мод показывает сообщение призрака через
`PlayerTextOverlay` (как шёпот).

### `ping` / `pong`

```json
{ "t": "ping", "ts": 1760000000000 }
{ "t": "pong", "ts": 1760000000000 }
```

Мод отправляет `ping` раз в 5 секунд. Relay также делает WebSocket ping каждые 30 секунд.

## 7. Проверки и ошибки

### 7.1. Relay (мягкие проверки)

Relay хранит последний снапшот и по нему проверяет:

- `energy`: если энергии меньше стоимости + 0.5, команда отклоняется;
- `cooldown`: если по снапшоту осталось больше 250 мс, команда отклоняется;
- `chaos`: если хаоса меньше `minChaos` + 0.5, команда отклоняется;
- роль: `cmd` может отправлять только `ghost`;
- наличие игры в комнате;
- rate limit: 80 сообщений/с, burst 160;
- санитайзинг аргументов: числа в ±10 000, текст до 180 символов, имя до 24, чат до 240.

Relay отвечает `ack` с ошибкой, не пересылая команду игре.

### 7.2. Мод (жёсткие проверки)

Мод проверяет те же условия по своим значениям, а затем пытается выполнить действие.
Даже если relay пропустил команду, мод может ответить:

| `error` | Причина |
| --- | --- |
| `unknown_ability` | Способность не входит в набор v1. |
| `cooldown` | Кулдаун ещё не истёк. |
| `not_enough_energy` | Энергии меньше стоимости. |
| `low_chaos` | Недостаточно хаоса (манифестация). |
| `failed` | Игровой API не смог выполнить действие (нет префаба, объект исчез и т.п.). |

### 7.3. Коды ошибок handshake и соединения

| `code` | Когда |
| --- | --- |
| `bad_hello` | Первое сообщение не `hello` или не JSON-объект. |
| `protocol_mismatch` | Версия протокола не равна 1. |
| `bad_room` | Код комнаты не 4–8 символов `A–Z/0–9`. |
| `bad_token` | Игра не прислала или прислала неверный `RELAY_TOKEN`. |
| `room_full` | В комнате уже есть игра или два призрака. |
| `handshake_timeout` | `hello` не пришёл за 10 секунд. |
| `bad_message` | Сообщение не JSON-объект или без `t`. |
| `unknown_message` | Неизвестный `t`. |
| `rate_limited` | Превышен лимит сообщений. |
| `bad_role` | Призрак пытается делать то, что можно только игре, или наоборот. |
| `bad_id` | Пустой `cmd.id`. |
| `no_game` | В комнате нет игры. |

Коды закрытия WebSocket: `4000` handshake timeout, `4001` protocol mismatch, `4002` bad
room, `4003` bad token, `4004` room full.

## 8. Пример полного обмена

```
ghost → relay: hello(ghost, TEST)
relay → ghost: welcome
relay → ghost: map (из кэша)
relay → ghost: snapshot (из кэша)
ghost → relay: camera(pos, yaw)
ghost → relay: cmd(spawn_enemy, x=4, z=2)
relay → game: cmd(...)
game  → relay: ack(id, ok=true, energy=75, cooldown=8)
relay → ghost: ack(...)
game  → relay: event(enemy_spawned)
relay → ghost: event(...)
game  → relay: snapshot (10 Гц)
relay → ghost: snapshot
```

## 9. Совместимость и изменения

- Версия протокола — целое число. Несовпадение версий закрывает соединение.
- Новые необязательные поля можно добавлять без смены версии, если старые клиенты их
  игнорируют. Удаление/переименование полей требует версии `2`.
- Способности — закрытый набор. Новая способность требует обновления:
  1. `AbilityId` и `ABILITIES` в `shared/ts/protocol.ts`;
  2. `Abilities.All` в `shared/csharp/Protocol.cs`;
  3. обработчика в `GhostDirector.HandleCommand`;
  4. реализации в `GameBridge`;
  5. карточки/горячей клавиши в `ghost-app`;
  6. проверки в relay (если нужны особые правила).
- Баланс (цена/кулдаун/хаос) дублируется в TS и C#. При изменении проверяй оба файла.
