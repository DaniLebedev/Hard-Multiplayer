using BepInEx.Logging;
using HardMultiplayer.Protocol;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;
using PVector3 = HardMultiplayer.Protocol.Vec3;
using UVector3 = UnityEngine.Vector3;

namespace HardMultiplayer;

internal sealed class PlayerInfo
{
    public PVector3 Pos { get; init; } = new();
    public PVector3 Forward { get; init; } = new(0f, 0f, 1f);
    public float Yaw { get; init; }
    public float Hp { get; init; }
    public bool Alive { get; init; }
}

internal sealed class PendingKind
{
    public UVector3 Position;
    public string Kind = "grunt";
    public float ExpiresAt;
}

internal sealed class FlickerEffect
{
    public Light[] Lights = Array.Empty<Light>();
    public float[] Intensities = Array.Empty<float>();
    public bool[] WasEnabled = Array.Empty<bool>();
    public float EndsAt;
    public float NextToggle;
}

/// <summary>
/// Thin, defensive wrapper around the game's IL2CPP types. Every Unity call is
/// made from the Unity main thread (GhostDirector.Update).
/// </summary>
internal sealed class GameBridge
{
    private readonly ManualLogSource _log;

    private readonly Dictionary<IntPtr, int> _enemyIds = new();
    private readonly Dictionary<IntPtr, string> _enemyKinds = new();
    private readonly List<PendingKind> _pendingKinds = new();

    private readonly Dictionary<IntPtr, int> _propIds = new();
    private readonly List<FlickerEffect> _flickers = new();

    private int _nextEnemyId = 1;
    private int _nextPropId = 1;

    private GameObject? _manifestGo;
    private float _manifestEndsAt;
    private PVector3? _ghostPos;
    private float _overlayClearAt;

    private float _lastErrorAt;
    private string _lastError = "";

    public GameBridge(ManualLogSource log)
    {
        _log = log;
    }

    public bool IsManifested => _manifestGo != null;

    public void SetGhostPosition(PVector3 pos)
    {
        _ghostPos = pos;
    }

    // -----------------------------------------------------------------------
    // Player
    // -----------------------------------------------------------------------

    public bool TryGetPlayer(out PlayerInfo info)
    {
        info = new PlayerInfo();
        try
        {
            if (!PlayerRoot.IsInitialized) return false;

            var root = PlayerRoot.Instance;
            if (root == null) return false;

            var foot = PlayerRoot.PlayerFoot;
            var head = PlayerRoot.PlayerHead;
            var direction = PlayerRoot.PlayerDirection;

            var pos = foot != null ? foot.position : root.transform.position;
            var forward = direction != null
                ? direction.forward
                : head != null
                    ? head.forward
                    : root.transform.forward;

            forward.y = 0f;
            if (forward.sqrMagnitude < 0.0001f) forward = UVector3.forward;
            forward.Normalize();

            var yaw = Mathf.Atan2(forward.x, forward.z);

            var health = PlayerRoot.HealthContainer;
            var hp = 100f;
            var alive = true;
            if (health != null)
            {
                hp = health.CurrentHealth;
                alive = !health.IsHealthContainerEmpty;
            }

            info = new PlayerInfo
            {
                Pos = ToProtocol(pos),
                Forward = ToProtocol(forward),
                Yaw = yaw,
                Hp = hp,
                Alive = alive,
            };
            return true;
        }
        catch (Exception ex)
        {
            LogThrottled("player", ex);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Enemies / props
    // -----------------------------------------------------------------------

    public List<EnemyState> GetEnemies(PlayerInfo? player)
    {
        var result = new List<EnemyState>();
        var seen = new HashSet<IntPtr>();

        try
        {
            var enemies = Object.FindObjectsOfType<EnemyRoot>();
            for (var i = 0; i < enemies.Length; i++)
            {
                var enemy = enemies[i];
                if (enemy == null) continue;

                var ptr = enemy.Pointer;
                if (!_enemyIds.TryGetValue(ptr, out var id))
                {
                    id = _nextEnemyId++;
                    _enemyIds[ptr] = id;
                }

                seen.Add(ptr);

                var health = enemy.HealthContainer;
                if (health != null && health.IsHealthContainerEmpty) continue;

                var transform = enemy.transform;
                if (transform == null) continue;

                var pos = transform.position;
                var kind = ResolveKind(ptr, pos);
                var hp = health != null ? health.CurrentHealth : 1f;

                var state = "idle";
                if (player != null)
                {
                    var dx = pos.x - player.Pos.X;
                    var dz = pos.z - player.Pos.Z;
                    var distance = Mathf.Sqrt(dx * dx + dz * dz);
                    state = distance < 2.4f ? "attack" : distance < 35f ? "chase" : "idle";
                }

                result.Add(new EnemyState
                {
                    Id = id,
                    Kind = kind,
                    Pos = ToProtocol(pos),
                    Hp = hp,
                    State = state,
                    Ghost = false,
                });
            }
        }
        catch (Exception ex)
        {
            LogThrottled("enemies", ex);
        }

        foreach (var ptr in _enemyIds.Keys.ToArray())
        {
            if (!seen.Contains(ptr)) _enemyIds.Remove(ptr);
        }
        foreach (var ptr in _enemyKinds.Keys.ToArray())
        {
            if (!seen.Contains(ptr)) _enemyKinds.Remove(ptr);
        }

        _pendingKinds.RemoveAll(p => Time.time > p.ExpiresAt);
        return result;
    }

    private string ResolveKind(IntPtr ptr, UVector3 position)
    {
        if (_enemyKinds.TryGetValue(ptr, out var known)) return known;

        for (var i = 0; i < _pendingKinds.Count; i++)
        {
            var pending = _pendingKinds[i];
            var dx = position.x - pending.Position.x;
            var dz = position.z - pending.Position.z;
            if (dx * dx + dz * dz > 9f) continue;

            _pendingKinds.RemoveAt(i);
            _enemyKinds[ptr] = pending.Kind;
            return pending.Kind;
        }

        return "grunt";
    }

    public List<PropState> GetProps()
    {
        var result = new List<PropState>();
        var seen = new HashSet<IntPtr>();

        try
        {
            var barrels = Object.FindObjectsOfType<ExplodingBarrel>();
            for (var i = 0; i < barrels.Length && result.Count < 30; i++)
            {
                var barrel = barrels[i];
                if (barrel == null) continue;

                var ptr = barrel.Pointer;
                if (!_propIds.TryGetValue(ptr, out var id))
                {
                    id = _nextPropId++;
                    _propIds[ptr] = id;
                }
                seen.Add(ptr);

                var transform = barrel.transform;
                if (transform == null) continue;

                var body = barrel.GetComponent<Rigidbody>();
                var mass = body != null ? body.mass : 20f;

                result.Add(new PropState
                {
                    Id = id,
                    Kind = "barrel",
                    Pos = ToProtocol(transform.position),
                    Mass = mass,
                });
            }
        }
        catch (Exception ex)
        {
            LogThrottled("props", ex);
        }

        foreach (var ptr in _propIds.Keys.ToArray())
        {
            if (!seen.Contains(ptr)) _propIds.Remove(ptr);
        }

        return result;
    }

    // -----------------------------------------------------------------------
    // Abilities
    // -----------------------------------------------------------------------

    public bool SpawnEnemy(PVector3 position, string kind)
    {
        try
        {
            var factory = EnemyFactory.Factory;
            if (factory == null) return false;

            var pos = ToVector3(position);
            var rotation = Quaternion.identity;

            if (TryGetPlayer(out var player))
            {
                var dx = player.Pos.X - pos.x;
                var dz = player.Pos.Z - pos.z;
                if (dx * dx + dz * dz > 0.01f)
                {
                    rotation = Quaternion.LookRotation(new UVector3(dx, 0f, dz), UVector3.up);
                }
            }

            IProduct<EnemyRoot>? product;
            try
            {
                product = factory.GetProduct(pos, rotation, 1f, true, true);
            }
            catch (Exception ex)
            {
                _log.LogWarning($"EnemyFactory.GetProduct не сработал: {ex.Message}");
                return false;
            }

            EnemyRoot? enemy = null;
            try
            {
                enemy = product?.Product;
            }
            catch (Exception ex)
            {
                _log.LogDebug($"Продукт ещё не инициализирован: {ex.Message}");
            }

            if (enemy != null)
            {
                _enemyKinds[enemy.Pointer] = kind;
            }
            else
            {
                _pendingKinds.Add(new PendingKind
                {
                    Position = pos,
                    Kind = kind,
                    ExpiresAt = Time.time + 4f,
                });
            }

            return product != null;
        }
        catch (Exception ex)
        {
            LogThrottled("spawn", ex);
            return false;
        }
    }

    public bool ThrowBarrel(PVector3 position, float? fuse)
    {
        try
        {
            var barrels = Object.FindObjectsOfType<ExplodingBarrel>();
            ExplodingBarrel? prefab = null;
            for (var i = 0; i < barrels.Length; i++)
            {
                if (barrels[i] != null)
                {
                    prefab = barrels[i];
                    break;
                }
            }

            if (prefab == null) return false;

            var pos = ToVector3(position);

            try
            {
                var clone = Object.Instantiate(prefab, pos, Quaternion.identity);
                if (clone != null)
                {
                    clone.transform.position = pos;
                    var body = clone.GetComponent<Rigidbody>();
                    if (body != null && !body.isKinematic)
                    {
                        body.linearVelocity = new UVector3(0f, -1f, 0f);
                    }
                    clone.Trigger();
                    return true;
                }
            }
            catch (Exception ex)
            {
                _log.LogDebug($"Не удалось клонировать бочку, двигаю существующую: {ex.Message}");
            }

            prefab.transform.position = pos;
            prefab.Trigger();
            return true;
        }
        catch (Exception ex)
        {
            LogThrottled("barrel", ex);
            return false;
        }
    }

    public bool Telekinesis(PVector3 point, int? targetId, float power)
    {
        try
        {
            Rigidbody? target = targetId.HasValue ? FindEnemyBody(targetId.Value) : null;
            target ??= FindNearestBody(point, 9f);
            if (target == null) return false;

            var from = target.transform.position;
            var player = TryGetPlayer(out var info)
                ? new UVector3(info.Pos.X, info.Pos.Y, info.Pos.Z)
                : from + UVector3.forward;

            var direction = player - from;
            direction.y = 0f;
            if (direction.sqrMagnitude < 0.01f) direction = UVector3.forward;
            direction.Normalize();

            var force = direction * Mathf.Clamp(power, 1f, 25f) + UVector3.up * 2.5f;
            target.AddForce(force, ForceMode.Impulse);
            return true;
        }
        catch (Exception ex)
        {
            LogThrottled("telekinesis", ex);
            return false;
        }
    }

    private Rigidbody? FindEnemyBody(int enemyId)
    {
        var enemies = Object.FindObjectsOfType<EnemyRoot>();
        for (var i = 0; i < enemies.Length; i++)
        {
            var enemy = enemies[i];
            if (enemy == null) continue;
            if (!_enemyIds.TryGetValue(enemy.Pointer, out var id) || id != enemyId) continue;

            var body = enemy.GetComponent<Rigidbody>();
            return body != null ? body : enemy.GetComponentInChildren<Rigidbody>();
        }

        return null;
    }

    private Rigidbody? FindNearestBody(PVector3 point, float radius)
    {
        var origin = ToVector3(point);
        var best = (Rigidbody?)null;
        var bestDistance = radius * radius;

        var playerRoot = PlayerRoot.IsInitialized ? PlayerRoot.Instance : null;
        var playerTransform = playerRoot != null ? playerRoot.transform : null;

        var bodies = Object.FindObjectsOfType<Rigidbody>();
        for (var i = 0; i < bodies.Length; i++)
        {
            var body = bodies[i];
            if (body == null || body.isKinematic) continue;

            var transform = body.transform;
            if (transform == null) continue;
            if (playerTransform != null && transform.IsChildOf(playerTransform)) continue;

            var distance = (transform.position - origin).sqrMagnitude;
            if (distance >= bestDistance) continue;

            bestDistance = distance;
            best = body;
        }

        return best;
    }

    public int Poltergeist(PVector3 point, float duration)
    {
        var affected = 0;
        var origin = ToVector3(point);

        try
        {
            var lights = Object.FindObjectsOfType<Light>();
            var chosen = new List<Light>();

            for (var i = 0; i < lights.Length; i++)
            {
                var light = lights[i];
                if (light == null) continue;

                var transform = light.transform;
                if (transform == null) continue;
                if ((transform.position - origin).sqrMagnitude > 225f) continue;

                chosen.Add(light);
                if (chosen.Count >= 12) break;
            }

            if (chosen.Count > 0)
            {
                var effect = new FlickerEffect
                {
                    Lights = chosen.ToArray(),
                    Intensities = new float[chosen.Count],
                    WasEnabled = new bool[chosen.Count],
                    EndsAt = Time.time + Mathf.Clamp(duration, 1f, 10f),
                    NextToggle = 0f,
                };

                for (var i = 0; i < chosen.Count; i++)
                {
                    effect.Intensities[i] = chosen[i].intensity;
                    effect.WasEnabled[i] = chosen[i].enabled;
                }

                _flickers.Add(effect);
                affected += chosen.Count;
            }
        }
        catch (Exception ex)
        {
            LogThrottled("poltergeist-lights", ex);
        }

        try
        {
            var bodies = Object.FindObjectsOfType<Rigidbody>();
            var pushed = 0;

            for (var i = 0; i < bodies.Length && pushed < 8; i++)
            {
                var body = bodies[i];
                if (body == null || body.isKinematic) continue;

                var transform = body.transform;
                if (transform == null) continue;
                if ((transform.position - origin).sqrMagnitude > 64f) continue;

                var force = new UVector3(
                    UnityEngine.Random.Range(-1.5f, 1.5f),
                    UnityEngine.Random.Range(1f, 3f),
                    UnityEngine.Random.Range(-1.5f, 1.5f));

                body.AddForce(force, ForceMode.Impulse);
                pushed++;
            }

            affected += pushed;
        }
        catch (Exception ex)
        {
            LogThrottled("poltergeist-bodies", ex);
        }

        return affected;
    }

    public bool Whisper(string text)
    {
        try
        {
            var value = string.IsNullOrWhiteSpace(text) ? "…" : text.Trim();
            PlayerTextOverlay.SetText(value);
            _overlayClearAt = Time.time + 4f;
            return true;
        }
        catch (Exception ex)
        {
            LogThrottled("whisper", ex);
            return false;
        }
    }

    public bool Manifest(PVector3 position, float duration)
    {
        if (_manifestGo != null) return false;

        try
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            go.name = "HardMultiplayer_Ghost";
            go.transform.position = ToVector3(position) + UVector3.up * 1.2f;
            go.transform.localScale = UVector3.one * 0.7f;

            var renderer = go.GetComponent<MeshRenderer>();
            if (renderer != null)
            {
                renderer.material.color = new Color(0.78f, 0.9f, 1f, 1f);
            }

            var light = go.AddComponent<Light>();
            light.type = LightType.Point;
            light.color = new Color(0.55f, 0.75f, 1f, 1f);
            light.range = 9f;
            light.intensity = 2.4f;

            _manifestGo = go;
            _manifestEndsAt = Time.time + Mathf.Clamp(duration, 2f, 20f);
            return true;
        }
        catch (Exception ex)
        {
            LogThrottled("manifest", ex);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Timed effects
    // -----------------------------------------------------------------------

    public void UpdateEffects(float now, out bool manifestEnded)
    {
        manifestEnded = false;

        if (_overlayClearAt > 0f && now >= _overlayClearAt)
        {
            _overlayClearAt = 0f;
            try
            {
                PlayerTextOverlay.ClearText();
            }
            catch (Exception ex)
            {
                LogThrottled("overlay", ex);
            }
        }

        for (var i = _flickers.Count - 1; i >= 0; i--)
        {
            var effect = _flickers[i];
            if (now >= effect.EndsAt)
            {
                for (var j = 0; j < effect.Lights.Length; j++)
                {
                    var light = effect.Lights[j];
                    if (light == null) continue;
                    light.enabled = effect.WasEnabled[j];
                    light.intensity = effect.Intensities[j];
                }
                _flickers.RemoveAt(i);
                continue;
            }

            if (now < effect.NextToggle) continue;
            effect.NextToggle = now + UnityEngine.Random.Range(0.04f, 0.16f);

            for (var j = 0; j < effect.Lights.Length; j++)
            {
                var light = effect.Lights[j];
                if (light == null) continue;

                var on = UnityEngine.Random.value > 0.35f;
                light.enabled = on;
                light.intensity = on ? effect.Intensities[j] * UnityEngine.Random.Range(0.4f, 1.3f) : 0f;
            }
        }

        if (_manifestGo != null)
        {
            if (now >= _manifestEndsAt)
            {
                Object.Destroy(_manifestGo);
                _manifestGo = null;
                manifestEnded = true;
            }
            else if (_ghostPos is { } ghost)
            {
                _manifestGo.transform.position = ToVector3(ghost) + UVector3.up * 1.2f;
            }
        }
    }

    public void Cleanup()
    {
        if (_manifestGo != null)
        {
            try
            {
                Object.Destroy(_manifestGo);
            }
            catch
            {
                // ignore
            }
            _manifestGo = null;
        }

        foreach (var effect in _flickers)
        {
            for (var i = 0; i < effect.Lights.Length; i++)
            {
                var light = effect.Lights[i];
                if (light == null) continue;
                light.enabled = effect.WasEnabled[i];
                light.intensity = effect.Intensities[i];
            }
        }
        _flickers.Clear();

        try
        {
            PlayerTextOverlay.ClearText();
        }
        catch
        {
            // ignore
        }
    }

    // -----------------------------------------------------------------------
    // World helpers
    // -----------------------------------------------------------------------

    public float SnapToGround(float x, float y, float z)
    {
        try
        {
            var origin = new UVector3(x, y + 25f, z);
            if (Physics.Raycast(origin, UVector3.down, out var hit, 60f, ~0, QueryTriggerInteraction.Ignore))
            {
                return hit.point.y + 0.05f;
            }
        }
        catch (Exception ex)
        {
            LogThrottled("ground", ex);
        }

        return y;
    }

    public string GetSceneName()
    {
        try
        {
            return SceneManager.GetActiveScene().name;
        }
        catch
        {
            return "";
        }
    }

    public MapData ScanMap(PVector3 playerPos, string scene)
    {
        var walls = new List<MapWall>();
        var minX = playerPos.X - 20f;
        var maxX = playerPos.X + 20f;
        var minZ = playerPos.Z - 20f;
        var maxZ = playerPos.Z + 20f;

        try
        {
            var boxes = Object.FindObjectsOfType<BoxCollider>();
            for (var i = 0; i < boxes.Length && walls.Count < 700; i++)
            {
                var box = boxes[i];
                if (box == null || box.isTrigger) continue;

                var layer = box.gameObject.layer;
                if (layer == 2) continue;

                var layerName = LayerMask.LayerToName(layer);
                if (layerName.Contains("Player", StringComparison.OrdinalIgnoreCase) ||
                    layerName.Contains("Enemy", StringComparison.OrdinalIgnoreCase) ||
                    layerName.Contains("Water", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var bounds = box.bounds;
                var size = bounds.size;

                if (size.y < 1.2f) continue;
                if (size.x < 0.25f || size.z < 0.25f) continue;
                if (size.x > 80f || size.z > 80f) continue;

                var center = bounds.center;
                if (center.y > playerPos.Y + 15f || center.y < playerPos.Y - 15f) continue;

                walls.Add(new MapWall
                {
                    X = center.x,
                    Z = center.z,
                    W = size.x,
                    D = size.z,
                    H = size.y,
                });

                minX = Mathf.Min(minX, center.x - size.x * 0.5f);
                maxX = Mathf.Max(maxX, center.x + size.x * 0.5f);
                minZ = Mathf.Min(minZ, center.z - size.z * 0.5f);
                maxZ = Mathf.Max(maxZ, center.z + size.z * 0.5f);
            }
        }
        catch (Exception ex)
        {
            LogThrottled("map", ex);
        }

        return new MapData
        {
            Scene = scene,
            Bounds = new MapBounds
            {
                MinX = minX - 4f,
                MinZ = minZ - 4f,
                MaxX = maxX + 4f,
                MaxZ = maxZ + 4f,
            },
            Walls = walls,
            Image = null,
        };
    }

    private void LogThrottled(string area, Exception ex)
    {
        var now = Time.time;
        var text = $"{area}: {ex.GetType().Name}: {ex.Message}";
        if (text == _lastError && now - _lastErrorAt < 10f) return;

        _lastError = text;
        _lastErrorAt = now;
        _log.LogWarning($"Hard Multiplayer API error ({text})");
    }

    public static UVector3 ToVector3(PVector3 value)
    {
        return new UVector3(value.X, value.Y, value.Z);
    }

    public static PVector3 ToProtocol(UVector3 value)
    {
        return new PVector3(value.x, value.y, value.z);
    }
}
