using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using BepInEx.Logging;
using HardMultiplayer.Protocol;

namespace HardMultiplayer;

/// <summary>
/// Owns the outbound WebSocket connection to the relay and moves JSON in/out of
/// the Unity main thread. Network work never touches Unity objects.
/// </summary>
internal sealed class RelayClient : IDisposable
{
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    private const int MaxInbound = 200;
    private const int MaxOutbound = 256;
    private const int MaxMessageBytes = 4 * 1024 * 1024;

    private readonly ManualLogSource _log;
    private readonly Uri _uri;
    private readonly string _room;
    private readonly string _token;
    private readonly string _name;

    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentQueue<string> _inbound = new();
    private readonly ConcurrentQueue<object> _outbound = new();
    private readonly SemaphoreSlim _sendSignal = new(0, int.MaxValue);

    private Task? _runTask;
    private volatile bool _connected;

    public RelayClient(ManualLogSource log, Uri uri, string room, string token, string name)
    {
        _log = log;
        _uri = uri;
        _room = room;
        _token = token;
        _name = name;
    }

    public bool Connected => _connected;

    public string Room => _room;

    public void Start()
    {
        _runTask = Task.Run(() => RunAsync(_cts.Token));
    }

    public bool TryDequeueInbound(out string json)
    {
        return _inbound.TryDequeue(out json!);
    }

    /// <summary>Queue a protocol message. Safe to call from the Unity main thread.</summary>
    public void Send(object message)
    {
        if (_outbound.Count >= MaxOutbound)
        {
            _outbound.TryDequeue(out _);
        }

        _outbound.Enqueue(message);
        try
        {
            _sendSignal.Release();
        }
        catch (SemaphoreFullException)
        {
            // The queue is capped anyway; nothing useful to do here.
        }
    }

    public void Stop()
    {
        try
        {
            _cts.Cancel();
        }
        catch
        {
            // ignore
        }

        try
        {
            _runTask?.Wait(TimeSpan.FromSeconds(3));
        }
        catch
        {
            // ignore
        }
    }

    public void Dispose()
    {
        Stop();
        _cts.Dispose();
        _sendSignal.Dispose();
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var delay = TimeSpan.FromSeconds(1);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var socket = new ClientWebSocket();
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

                await socket.ConnectAsync(_uri, ct).ConfigureAwait(false);

                var hello = new Hello
                {
                    Protocol = ProtocolVersion.Current,
                    Room = _room,
                    Role = "game",
                    Token = string.IsNullOrEmpty(_token) ? null : _token,
                    Name = _name,
                };

                await SendTextAsync(socket, JsonSerializer.Serialize(hello, JsonOptions), ct).ConfigureAwait(false);

                DrainOutbound();
                _connected = true;
                delay = TimeSpan.FromSeconds(1);
                _log.LogInfo($"Relay подключён: {_uri} (комната {_room}).");

                await PumpAsync(socket, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.LogWarning($"Relay недоступен: {ex.Message}. Повтор через {delay.TotalSeconds:0} с.");
            }
            finally
            {
                _connected = false;
            }

            if (ct.IsCancellationRequested) break;

            try
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            delay = TimeSpan.FromSeconds(Math.Min(15, delay.TotalSeconds * 2));
        }

        _connected = false;
    }

    private async Task PumpAsync(ClientWebSocket socket, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var receive = ReceiveLoopAsync(socket, linked.Token);
        var send = SendLoopAsync(socket, linked.Token);

        var finished = await Task.WhenAny(receive, send).ConfigureAwait(false);
        linked.Cancel();

        try
        {
            await Task.WhenAll(receive, send).ConfigureAwait(false);
        }
        catch
        {
            // The first failure is rethrown below.
        }

        await finished.ConfigureAwait(false);
    }

    private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[32 * 1024];
        using var message = new MemoryStream(64 * 1024);

        while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;

            do
            {
                result = await socket
                    .ReceiveAsync(new ArraySegment<byte>(buffer), ct)
                    .ConfigureAwait(false);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    _log.LogInfo($"Relay закрыл соединение: {result.CloseStatus} {result.CloseStatusDescription}");
                    try
                    {
                        await socket
                            .CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None)
                            .ConfigureAwait(false);
                    }
                    catch
                    {
                        // ignore
                    }
                    return;
                }

                message.Write(buffer, 0, result.Count);
                if (message.Length > MaxMessageBytes)
                {
                    throw new InvalidOperationException("Сообщение relay слишком большое.");
                }
            }
            while (!result.EndOfMessage);

            var json = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            if (_inbound.Count >= MaxInbound)
            {
                _inbound.TryDequeue(out _);
            }
            _inbound.Enqueue(json);
        }
    }

    private async Task SendLoopAsync(ClientWebSocket socket, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            await _sendSignal.WaitAsync(ct).ConfigureAwait(false);

            if (!_outbound.TryDequeue(out var message)) continue;

            var json = message as string ?? JsonSerializer.Serialize(message, JsonOptions);
            await SendTextAsync(socket, json, ct).ConfigureAwait(false);
        }
    }

    private static Task SendTextAsync(ClientWebSocket socket, string json, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        return socket.SendAsync(
            new ArraySegment<byte>(bytes),
            WebSocketMessageType.Text,
            true,
            ct);
    }

    private void DrainOutbound()
    {
        while (_outbound.TryDequeue(out _))
        {
            // drop stale messages from the previous connection
        }
    }
}
