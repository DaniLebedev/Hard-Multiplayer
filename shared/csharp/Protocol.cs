using System.Collections.Generic;

namespace HardMultiplayer.Protocol;

// Wire protocol v1. Mirrors shared/ts/protocol.ts.
// Serialized with JsonNamingPolicy.CamelCase and null values ignored.

public static class ProtocolVersion
{
    public const int Current = 1;
}

public sealed class Vec3
{
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }

    public Vec3() { }
    public Vec3(float x, float y, float z) { X = x; Y = y; Z = z; }

    public static Vec3 Zero => new(0f, 0f, 0f);
}

public sealed class Hello
{
    public string T { get; set; } = "hello";
    public int Protocol { get; set; } = ProtocolVersion.Current;
    public string Room { get; set; } = "";
    public string Role { get; set; } = "";
    public string? Token { get; set; }
    public string? Name { get; set; }
}

public sealed class PeerInfo
{
    public string Id { get; set; } = "";
    public string Role { get; set; } = "";
    public string? Name { get; set; }
}

public sealed class Welcome
{
    public string T { get; set; } = "welcome";
    public int Protocol { get; set; }
    public string Room { get; set; } = "";
    public string PeerId { get; set; } = "";
    public List<PeerInfo> Peers { get; set; } = new();
    public long ServerTime { get; set; }
}

public sealed class PeerEvent
{
    public string T { get; set; } = "peer";
    public string Event { get; set; } = "";
    public string PeerId { get; set; } = "";
    public string Role { get; set; } = "";
    public string? Name { get; set; }
}

public sealed class ErrorMessage
{
    public string T { get; set; } = "error";
    public string Code { get; set; } = "";
    public string Message { get; set; } = "";
}

public sealed class PlayerState
{
    public Vec3 Pos { get; set; } = Vec3.Zero;
    public float Yaw { get; set; }
    public Vec3 Vel { get; set; } = Vec3.Zero;
    public float Hp { get; set; }
    public bool Alive { get; set; }
}

public sealed class GhostState
{
    public Vec3 Pos { get; set; } = Vec3.Zero;
    public float Yaw { get; set; }
    public bool Manifested { get; set; }
    public bool Stunned { get; set; }
}

public sealed class EnemyState
{
    public int Id { get; set; }
    public string Kind { get; set; } = "grunt";
    public Vec3 Pos { get; set; } = Vec3.Zero;
    public float Hp { get; set; }
    public string State { get; set; } = "idle";
    public bool Ghost { get; set; }
}

public sealed class PropState
{
    public int Id { get; set; }
    public string Kind { get; set; } = "prop";
    public Vec3 Pos { get; set; } = Vec3.Zero;
    public float Mass { get; set; }
}

public sealed class Stats
{
    public int Scares { get; set; }
    public int Kills { get; set; }
    public int Spawns { get; set; }
    public int Barrels { get; set; }
    public float SessionTime { get; set; }
}

public sealed class Snapshot
{
    public string T { get; set; } = "snapshot";
    public int Seq { get; set; }
    public long Ts { get; set; }
    public string Scene { get; set; } = "";
    public PlayerState Player { get; set; } = new();
    public GhostState Ghost { get; set; } = new();
    public List<EnemyState> Enemies { get; set; } = new();
    public List<PropState> Props { get; set; } = new();
    public float Energy { get; set; }
    public float MaxEnergy { get; set; } = 100f;
    public float Chaos { get; set; }
    public Dictionary<string, float> Cooldowns { get; set; } = new();
    public Stats Stats { get; set; } = new();
}

public sealed class MapBounds
{
    public float MinX { get; set; }
    public float MinZ { get; set; }
    public float MaxX { get; set; }
    public float MaxZ { get; set; }
}

public sealed class MapWall
{
    public float X { get; set; }
    public float Z { get; set; }
    public float W { get; set; }
    public float D { get; set; }
    public float H { get; set; }
}

public sealed class MapImage
{
    public string Mime { get; set; } = "image/jpeg";
    public string Data { get; set; } = "";
    public int Width { get; set; }
    public int Height { get; set; }
    public float MinX { get; set; }
    public float MinZ { get; set; }
    public float MaxX { get; set; }
    public float MaxZ { get; set; }
}

public sealed class MapData
{
    public string T { get; set; } = "map";
    public string Scene { get; set; } = "";
    public MapBounds Bounds { get; set; } = new();
    public List<MapWall> Walls { get; set; } = new();
    public MapImage? Image { get; set; }
}

public sealed class GameEvent
{
    public string T { get; set; } = "event";
    public string Kind { get; set; } = "info";
    public Dictionary<string, object?>? Data { get; set; }
    public long Ts { get; set; }
}

public sealed class Toast
{
    public string T { get; set; } = "toast";
    public string Text { get; set; } = "";
    public string? Level { get; set; }
}

public sealed class Pong
{
    public string T { get; set; } = "pong";
    public long Ts { get; set; }
}

public sealed class CmdArgs
{
    public string? Kind { get; set; }
    public float? X { get; set; }
    public float? Y { get; set; }
    public float? Z { get; set; }
    public int? TargetId { get; set; }
    public float? Power { get; set; }
    public float? Duration { get; set; }
    public string? Text { get; set; }
    public bool? Behind { get; set; }
    public float? Distance { get; set; }
    public float? Fuse { get; set; }
    public string? Mode { get; set; }
}

public sealed class Cmd
{
    public string T { get; set; } = "cmd";
    public string Id { get; set; } = "";
    public string Ability { get; set; } = "";
    public CmdArgs Args { get; set; } = new();
    public long Ts { get; set; }
}

public sealed class Ack
{
    public string T { get; set; } = "ack";
    public string Id { get; set; } = "";
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public float? Energy { get; set; }
    public float? Cooldown { get; set; }
}

public sealed class CameraMsg
{
    public string T { get; set; } = "camera";
    public Vec3 Pos { get; set; } = Vec3.Zero;
    public float Yaw { get; set; }
    public long Ts { get; set; }
}

public sealed class Ping
{
    public string T { get; set; } = "ping";
    public long Ts { get; set; }
}

public sealed class Chat
{
    public string T { get; set; } = "chat";
    public string From { get; set; } = "";
    public string Text { get; set; } = "";
    public long Ts { get; set; }
}

public sealed class AbilityDef
{
    public string Id { get; init; } = "";
    public float Cost { get; init; }
    public float Cooldown { get; init; }
    public float MinChaos { get; init; }
}

public static class Abilities
{
    public static readonly IReadOnlyDictionary<string, AbilityDef> All = new Dictionary<string, AbilityDef>
    {
        ["spawn_enemy"] = new() { Id = "spawn_enemy", Cost = 25f, Cooldown = 8f, MinChaos = 0f },
        ["throw_barrel"] = new() { Id = "throw_barrel", Cost = 15f, Cooldown = 4f, MinChaos = 0f },
        ["telekinesis"] = new() { Id = "telekinesis", Cost = 10f, Cooldown = 2f, MinChaos = 0f },
        ["poltergeist"] = new() { Id = "poltergeist", Cost = 8f, Cooldown = 6f, MinChaos = 0f },
        ["manifest"] = new() { Id = "manifest", Cost = 30f, Cooldown = 20f, MinChaos = 15f },
        ["whisper"] = new() { Id = "whisper", Cost = 5f, Cooldown = 10f, MinChaos = 0f },
    };
}
