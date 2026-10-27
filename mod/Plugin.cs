using System.Security.Cryptography;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;

namespace HardMultiplayer;

[BepInPlugin(Guid, "Hard Multiplayer", "0.1.0")]
public sealed class Plugin : BasePlugin
{
    public const string Guid = "hardmultiplayer.ghost";

    private const string RoomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    internal static Plugin Instance { get; private set; } = null!;

    public ConfigEntry<bool> Enabled = null!;
    public ConfigEntry<string> RelayUrl = null!;
    public ConfigEntry<string> Room = null!;
    public ConfigEntry<string> Token = null!;
    public ConfigEntry<string> GhostName = null!;
    public ConfigEntry<float> SnapshotHz = null!;
    public ConfigEntry<float> MaxEnergy = null!;
    public ConfigEntry<float> EnergyRegen = null!;
    public ConfigEntry<float> ChaosDecay = null!;

    private RelayClient? _relay;

    public override void Load()
    {
        Instance = this;

        Enabled = Config.Bind(
            "General",
            "Enabled",
            true,
            "Включить мост Hard Multiplayer. Если выключено, мод только пишет сообщение в лог.");

        RelayUrl = Config.Bind(
            "Relay",
            "Url",
            "ws://127.0.0.1:8080/ws",
            "WebSocket-адрес relay-сервера. Для игры через интернет укажи публичный адрес, например wss://ghost.example.com/ws.");

        Room = Config.Bind(
            "Relay",
            "Room",
            "TEST",
            "Код комнаты (4-8 символов A-Z/0-9). Друг вводит этот же код в браузере.");

        Token = Config.Bind(
            "Relay",
            "Token",
            "",
            "Необязательный токен игры. Должен совпадать с RELAY_TOKEN на relay-сервере.");

        GhostName = Config.Bind(
            "Relay",
            "Name",
            "Призрак",
            "Имя, которое игра показывает остальным участникам комнаты.");

        SnapshotHz = Config.Bind(
            "Tuning",
            "SnapshotHz",
            10f,
            new ConfigDescription(
                "Сколько раз в секунду игра отправляет состояние призраку.",
                new AcceptableValueRange<float>(1f, 30f)));

        MaxEnergy = Config.Bind(
            "Tuning",
            "MaxEnergy",
            100f,
            new ConfigDescription(
                "Максимальный запас энергии призрака.",
                new AcceptableValueRange<float>(20f, 500f)));

        EnergyRegen = Config.Bind(
            "Tuning",
            "EnergyRegen",
            6f,
            new ConfigDescription(
                "Сколько энергии восстанавливается в секунду.",
                new AcceptableValueRange<float>(0f, 50f)));

        ChaosDecay = Config.Bind(
            "Tuning",
            "ChaosDecay",
            1.5f,
            new ConfigDescription(
                "Насколько быстро успокаивается хаос (единиц в секунду).",
                new AcceptableValueRange<float>(0f, 20f)));

        if (!Enabled.Value)
        {
            Log.LogInfo("Hard Multiplayer выключен в конфиге.");
            return;
        }

        if (!Uri.TryCreate(RelayUrl.Value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != "ws" && uri.Scheme != "wss"))
        {
            Log.LogError($"Некорректный Relay.Url: '{RelayUrl.Value}'. Ожидался ws:// или wss:// адрес.");
            return;
        }

        var room = NormalizeRoom(Room.Value);
        if (room is null)
        {
            room = RandomRoomCode();
            Log.LogWarning($"Код комнаты '{Room.Value}' некорректен. Использую случайный: {room}");
        }

        var name = string.IsNullOrWhiteSpace(GhostName.Value) ? "Призрак" : GhostName.Value.Trim();
        _relay = new RelayClient(Log, uri, room, Token.Value.Trim(), name);

        try
        {
            var bridge = new GameBridge(Log);
            var director = AddComponent<GhostDirector>();
            director.Initialize(this, _relay, bridge);
            _relay.Start();

            Log.LogInfo("Hard Multiplayer загружен.");
            Log.LogInfo($"Комната: {room}. Relay: {uri}");
            Log.LogInfo($"Передай другу код {room} и адрес браузерного клиента.");
        }
        catch (Exception ex)
        {
            Log.LogError($"Не удалось запустить Hard Multiplayer: {ex}");
            _relay = null;
        }
    }

    public override bool Unload()
    {
        _relay?.Stop();
        _relay = null;
        return true;
    }

    private static string? NormalizeRoom(string value)
    {
        var room = (value ?? string.Empty).Trim().ToUpperInvariant();
        if (room.Length < 4 || room.Length > 8) return null;
        foreach (var ch in room)
        {
            if (!(ch >= 'A' && ch <= 'Z') && !(ch >= '0' && ch <= '9')) return null;
        }
        return room;
    }

    private static string RandomRoomCode()
    {
        Span<char> chars = stackalloc char[4];
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = RoomAlphabet[RandomNumberGenerator.GetInt32(RoomAlphabet.Length)];
        }
        return new string(chars);
    }
}
