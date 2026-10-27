using System.Text.Json;
using BepInEx.Logging;
using HardMultiplayer.Protocol;
using UnityEngine;
using PVector3 = HardMultiplayer.Protocol.Vec3;
using PPing = HardMultiplayer.Protocol.Ping;

namespace HardMultiplayer;

/// <summary>
/// The main-thread half of the mod: owns authoritative energy/cooldowns,
/// turns ghost commands into game actions, mirrors ghost intent previews into
/// the world, and publishes snapshots at a fixed rate.
/// </summary>
public sealed class GhostDirector
{
    private Plugin _plugin = null!;
    private RelayClient _relay = null!;
    private GameBridge _game = null!;
    private bool _ready;

    private float _energy;
    private readonly Dictionary<string, float> _cooldowns = new();

    private int _seq;
    private float _lastSnapshotAt;
    private float _lastMapCheckAt;
    private float _lastPingAt;
    private string _lastScene = "";
    private float _sessionStart;

    private PVector3? _cameraPos;
    private float _cameraYaw;

    private bool _hadPlayer;
    private PVector3 _lastPlayerPos = new();
    private float _lastPlayerAt;
    private float _lastPlayerHp;
    private bool _playerWasAlive;
    private PVector3 _playerVelocity = new();

    private readonly HashSet<int> _seenEnemyIds = new();
    private int _kills;
    private int _scares;
    private int _spawns;
    private int _barrels;
    private bool _announcedRoom;

    internal void Initialize(Plugin plugin, RelayClient relay, GameBridge game)
    {
        _plugin = plugin;
        _relay = relay;
        _game = game;

        _energy = plugin.MaxEnergy.Value;
        _sessionStart = Time.time;
        _ready = true;

        _plugin.Log.LogInfo("GhostDirector готов. Жду подключения к relay.");
    }

    public void Tick()
    {
        if (!_ready) return;

        var now = Time.time;
        var dt = Mathf.Max(0.0001f, Time.deltaTime);

        ProcessInbound();

        _energy = Mathf.Min(_plugin.MaxEnergy.Value, _energy + _plugin.EnergyRegen.Value * dt);

        _game.UpdateEffects(now, out var manifestEnded);
        if (manifestEnded)
        {
            SendEvent("manifest_end");
        }

        if (now - _lastPingAt > 5f)
        {
            _lastPingAt = now;
            _relay.Send(new PPing { Ts = NowMs() });
        }

        if (!_relay.Connected)
        {
            _game.ClearPreview();
            return;
        }

        if (!_announcedRoom && _game.TryGetPlayer(out _))
        {
            if (_game.ShowOverlay($"Hard Multiplayer · комната {_relay.Room}"))
            {
                _announcedRoom = true;
                _plugin.Log.LogInfo($"Комната {_relay.Room} показана игроку.");
            }
        }

        if (now - _lastMapCheckAt > 2f)
        {
            _lastMapCheckAt = now;
            CheckScene(force: false);
        }

        var hz = Mathf.Clamp(_plugin.SnapshotHz.Value, 1f, 30f);
        if (now - _lastSnapshotAt >= 1f / hz)
        {
            _lastSnapshotAt = now;
            SendSnapshot(now);
        }
    }

    public void Shutdown()
    {
        _ready = false;
        try
        {
            _game?.Cleanup();
        }
        catch
        {
            // ignore
        }
    }

    // -----------------------------------------------------------------------
    // Inbound
    // -----------------------------------------------------------------------

    private void ProcessInbound()
    {
        while (_relay.TryDequeueInbound(out var json))
        {
            try
            {
                using var document = JsonDocument.Parse(json);
                var root = document.RootElement;

                if (!root.TryGetProperty("t", out var typeElement)) continue;
                var type = typeElement.GetString();

                switch (type)
                {
                    case "welcome":
                        HandleWelcome(json);
                        break;

                    case "cmd":
                        var command = JsonSerializer.Deserialize<Cmd>(json, RelayClient.JsonOptions);
                        if (command != null) HandleCommand(command);
                        break;

                    case "preview":
                        var preview = JsonSerializer.Deserialize<Preview>(json, RelayClient.JsonOptions);
                        if (preview != null)
                        {
                            // Never keep a stale hologram alive while the ability
                            // is on cooldown; the browser also stops sending it.
                            var onCooldown = preview.Active &&
                                             preview.Ability != null &&
                                             _cooldowns.TryGetValue(preview.Ability, out var previewUntil) &&
                                             previewUntil - Time.time > 0.05f;
                            if (onCooldown) _game.ClearPreview();
                            else _game.SetPreview(preview);
                        }
                        break;

                    case "error":
                        var error = JsonSerializer.Deserialize<ErrorMessage>(json, RelayClient.JsonOptions);
                        if (error != null)
                        {
                            _plugin.Log.LogWarning($"Relay: {error.Code}: {error.Message}");
                        }
                        break;

                    case "peer":
                        var peer = JsonSerializer.Deserialize<PeerEvent>(json, RelayClient.JsonOptions);
                        if (peer != null)
                        {
                            _plugin.Log.LogInfo($"Комната: {peer.Event} {peer.Role} {peer.Name ?? peer.PeerId}");
                        }
                        break;

                    case "camera":
                        var camera = JsonSerializer.Deserialize<CameraMsg>(json, RelayClient.JsonOptions);
                        if (camera?.Pos != null)
                        {
                            _cameraPos = camera.Pos;
                            _cameraYaw = camera.Yaw;
                            _game.SetGhostPosition(camera.Pos);
                        }
                        break;

                    case "chat":
                        var chat = JsonSerializer.Deserialize<Chat>(json, RelayClient.JsonOptions);
                        if (chat != null && chat.From == "ghost")
                        {
                            _game.ShowOverlay(chat.Text);
                        }
                        break;

                    case "pong":
                        break;
                }
            }
            catch (Exception ex)
            {
                _plugin.Log.LogWarning($"Не удалось обработать сообщение relay: {ex.Message}");
            }
        }
    }

    private void HandleWelcome(string json)
    {
        try
        {
            var welcome = JsonSerializer.Deserialize<Welcome>(json, RelayClient.JsonOptions);
            if (welcome == null) return;

            _plugin.Log.LogInfo(
                $"Relay приветствует: комната {welcome.Room}, я {welcome.PeerId}, участников {welcome.Peers.Count}.");

            _lastMapCheckAt = 0f;
            CheckScene(force: true);
        }
        catch (Exception ex)
        {
            _plugin.Log.LogWarning($"Некорректный welcome: {ex.Message}");
        }
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    private void HandleCommand(Cmd command)
    {
        if (string.IsNullOrEmpty(command.Id))
        {
            return;
        }

        if (!Abilities.All.TryGetValue(command.Ability, out var ability))
        {
            SendAck(command.Id, false, "unknown_ability");
            return;
        }

        var now = Time.time;

        if (_cooldowns.TryGetValue(command.Ability, out var until) && until - now > 0.05f)
        {
            SendAck(command.Id, false, "cooldown", until - now);
            return;
        }

        if (_energy + 0.01f < ability.Cost)
        {
            SendAck(command.Id, false, "not_enough_energy");
            return;
        }

        var args = command.Args ?? new CmdArgs();
        var position = ResolvePosition(args);
        var ok = false;

        switch (command.Ability)
        {
            case "spawn_enemy":
            {
                var kind = NormalizeKind(args.Kind);
                ok = _game.SpawnEnemy(position, kind);
                if (ok)
                {
                    _spawns++;
                    SendEvent("enemy_spawned", new Dictionary<string, object?>
                    {
                        ["kind"] = kind,
                        ["x"] = position.X,
                        ["z"] = position.Z,
                    });
                }
                break;
            }

            case "throw_barrel":
            {
                var dir = ResolveDirection(args);
                ok = _game.ThrowBarrel(position, dir, args.Power ?? 14f, args.Fuse);
                if (ok)
                {
                    _barrels++;
                    SendEvent("scare", new Dictionary<string, object?>
                    {
                        ["type"] = "barrel",
                        ["x"] = position.X,
                        ["z"] = position.Z,
                    });
                }
                break;
            }

            case "telekinesis":
                ok = _game.Telekinesis(position, args.TargetId, args.Power ?? 8f);
                if (ok)
                {
                    SendEvent("scare", new Dictionary<string, object?>
                    {
                        ["type"] = "telekinesis",
                        ["x"] = position.X,
                        ["z"] = position.Z,
                    });
                }
                break;

            case "poltergeist":
            {
                var lights = _game.Poltergeist(position, args.Duration ?? 3f);
                ok = true;
                _scares++;
                SendEvent("scare", new Dictionary<string, object?>
                {
                    ["type"] = "poltergeist",
                    ["lights"] = lights,
                    ["x"] = position.X,
                    ["z"] = position.Z,
                });
                break;
            }

            case "manifest":
            {
                // Manifestation is the only self-targeted ability: use the ghost's
                // current camera position instead of the "behind player" fallback.
                var manifestPosition = _cameraPos ?? position;
                _game.SetGhostPosition(manifestPosition);
                ok = _game.Manifest(manifestPosition, args.Duration ?? 6f);
                if (ok)
                {
                    _scares++;
                    SendEvent("manifest_start", new Dictionary<string, object?>
                    {
                        ["x"] = manifestPosition.X,
                        ["y"] = manifestPosition.Y,
                        ["z"] = manifestPosition.Z,
                    });
                }
                break;
            }
        }

        // Any cast consumes the intent hologram, even if the game API refused it.
        // Otherwise a failed spawn could leave the barrel arrow on screen.
        _game.ClearPreview();

        if (!ok)
        {
            SendAck(command.Id, false, "failed");
            return;
        }

        _energy = Mathf.Max(0f, _energy - ability.Cost);
        _cooldowns[command.Ability] = now + ability.Cooldown;
        SendAck(command.Id, true, null, ability.Cooldown);
    }

    private static string NormalizeKind(string? kind)
    {
        return kind switch
        {
            "runner" => "runner",
            "shooter" => "shooter",
            "heavy" => "heavy",
            _ => "grunt",
        };
    }

    private PVector3 ResolvePosition(CmdArgs args)
    {
        if (_game.TryGetPlayer(out var player))
        {
            var x = args.X ?? player.Pos.X;
            var z = args.Z ?? player.Pos.Z;
            var y = args.Y ?? player.Pos.Y;
            y = _game.SnapToGround(x, y, z);
            return new PVector3(x, y, z);
        }

        return new PVector3(args.X ?? 0f, args.Y ?? 0f, args.Z ?? 0f);
    }

    private PVector3 ResolveDirection(CmdArgs args)
    {
        var x = args.DirX ?? Mathf.Sin(_cameraYaw);
        var z = args.DirZ ?? Mathf.Cos(_cameraYaw);
        var length = Mathf.Sqrt(x * x + z * z);
        if (length < 0.0001f)
        {
            return new PVector3(Mathf.Sin(_cameraYaw), 0f, Mathf.Cos(_cameraYaw));
        }

        return new PVector3(x / length, 0f, z / length);
    }

    private void SendAck(string id, bool ok, string? error, float cooldown = 0f)
    {
        _relay.Send(new Ack
        {
            Id = id,
            Ok = ok,
            Error = error,
            Energy = _energy,
            Cooldown = cooldown,
        });
    }

    // -----------------------------------------------------------------------
    // Outbound state
    // -----------------------------------------------------------------------

    private void CheckScene(bool force)
    {
        var scene = _game.GetSceneName();
        if (string.IsNullOrEmpty(scene)) return;
        if (!force && scene == _lastScene) return;

        var changed = _lastScene.Length > 0 && scene != _lastScene;
        _lastScene = scene;

        if (!_game.TryGetPlayer(out var player))
        {
            player = new PlayerInfo();
        }

        var map = _game.ScanMap(player.Pos, scene);
        _relay.Send(map);

        _plugin.Log.LogInfo($"Карта отправлена: сцена '{scene}', стен {map.Walls.Count}.");

        if (changed)
        {
            // The old camera position belongs to the previous scene; start the
            // ghost from the player again until the browser sends a fresh one.
            _game.ClearPreview();
            _cameraPos = null;
            _cameraYaw = 0f;
            SendEvent("scene_changed", new Dictionary<string, object?> { ["scene"] = scene });
        }
    }

    private void SendSnapshot(float now)
    {
        var hasPlayer = _game.TryGetPlayer(out var player);
        var enemies = _game.GetEnemies(hasPlayer ? player : null);
        var props = _game.GetProps();

        var playerState = new PlayerState();
        if (hasPlayer)
        {
            var elapsed = Mathf.Max(0.001f, now - _lastPlayerAt);
            if (_hadPlayer)
            {
                var vx = (player.Pos.X - _lastPlayerPos.X) / elapsed;
                var vy = (player.Pos.Y - _lastPlayerPos.Y) / elapsed;
                var vz = (player.Pos.Z - _lastPlayerPos.Z) / elapsed;
                _playerVelocity = new PVector3(
                    Mathf.Lerp(_playerVelocity.X, vx, 0.35f),
                    Mathf.Lerp(_playerVelocity.Y, vy, 0.35f),
                    Mathf.Lerp(_playerVelocity.Z, vz, 0.35f));
            }

            playerState = new PlayerState
            {
                Pos = player.Pos,
                Yaw = player.Yaw,
                Vel = _playerVelocity,
                Hp = player.Hp,
                Alive = player.Alive,
            };

            if (_hadPlayer && player.Hp < _lastPlayerHp - 0.5f)
            {
                SendEvent("player_hit", new Dictionary<string, object?>
                {
                    ["damage"] = _lastPlayerHp - player.Hp,
                    ["hp"] = player.Hp,
                });
            }

            if (!player.Alive && _playerWasAlive)
            {
                SendEvent("player_died", new Dictionary<string, object?> { ["hp"] = player.Hp });
            }

            _lastPlayerPos = player.Pos;
            _lastPlayerAt = now;
            _lastPlayerHp = player.Hp;
            _playerWasAlive = player.Alive;
            _hadPlayer = true;
        }

        var aliveIds = new HashSet<int>();
        foreach (var enemy in enemies)
        {
            aliveIds.Add(enemy.Id);
        }

        if (_seenEnemyIds.Count > 0)
        {
            foreach (var id in _seenEnemyIds)
            {
                if (!aliveIds.Contains(id)) _kills++;
            }
        }

        _seenEnemyIds.Clear();
        foreach (var id in aliveIds) _seenEnemyIds.Add(id);

        if (enemies.Count > 60 && hasPlayer)
        {
            var px = player.Pos.X;
            var pz = player.Pos.Z;
            enemies.Sort((a, b) =>
            {
                var da = (a.Pos.X - px) * (a.Pos.X - px) + (a.Pos.Z - pz) * (a.Pos.Z - pz);
                var db = (b.Pos.X - px) * (b.Pos.X - px) + (b.Pos.Z - pz) * (b.Pos.Z - pz);
                return da.CompareTo(db);
            });
            enemies.RemoveRange(60, enemies.Count - 60);
        }

        var ghostPos = _cameraPos;
        var ghostYaw = _cameraYaw;
        if (ghostPos == null && hasPlayer)
        {
            // The player's forward vector is not always populated (for example
            // in the intro scene), so fall back to the player's yaw.
            var fx = player.Forward.X;
            var fz = player.Forward.Z;
            var forwardLength = Mathf.Sqrt(fx * fx + fz * fz);
            if (forwardLength < 0.01f)
            {
                fx = Mathf.Sin(player.Yaw);
                fz = Mathf.Cos(player.Yaw);
            }
            else
            {
                fx /= forwardLength;
                fz /= forwardLength;
            }

            ghostPos = new PVector3(
                player.Pos.X - fx * 3f,
                player.Pos.Y + 1.6f,
                player.Pos.Z - fz * 3f);
            ghostYaw = player.Yaw;
        }

        var cooldowns = new Dictionary<string, float>();
        foreach (var pair in _cooldowns)
        {
            var remaining = pair.Value - now;
            if (remaining > 0f) cooldowns[pair.Key] = remaining;
        }

        var snapshot = new Snapshot
        {
            Seq = ++_seq,
            Ts = NowMs(),
            Scene = _lastScene,
            Player = playerState,
            Ghost = new GhostState
            {
                Pos = ghostPos ?? new PVector3(),
                Yaw = ghostYaw,
                Manifested = _game.IsManifested,
                Stunned = false,
            },
            Enemies = enemies,
            Props = props,
            Energy = _energy,
            MaxEnergy = _plugin.MaxEnergy.Value,
            Cooldowns = cooldowns,
            Stats = new Stats
            {
                Scares = _scares,
                Kills = _kills,
                Spawns = _spawns,
                Barrels = _barrels,
                SessionTime = now - _sessionStart,
            },
        };

        _relay.Send(snapshot);
    }

    private void SendEvent(string kind, Dictionary<string, object?>? data = null)
    {
        _relay.Send(new GameEvent
        {
            Kind = kind,
            Data = data,
            Ts = NowMs(),
        });
    }

    private static long NowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
