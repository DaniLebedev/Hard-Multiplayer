import {
  PROTOCOL_VERSION,
  type AbilityId,
  type Ack,
  type CameraMsg,
  type Chat,
  type ClientMessage,
  type Cmd,
  type CmdArgs,
  type ErrorMessage,
  type GameEvent,
  type MapData,
  type PeerEvent,
  type Pong,
  type Preview,
  type Snapshot,
  type Toast,
  type Vec3,
  type Welcome,
} from "@hm/protocol";
import type { Store } from "./state";

const MAX_QUEUED_CMDS = 24;
const PING_INTERVAL_MS = 2000;
const HANDSHAKE_TIMEOUT_MS = 9000;

function relayUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("relay") ?? import.meta.env.VITE_RELAY_URL;
  if (explicit) return explicit;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class Net {
  onGameEvent: ((event: GameEvent) => void) | null = null;
  onPeerEvent: ((event: PeerEvent) => void) | null = null;

  private ws: WebSocket | null = null;
  private room = "";
  private name = "";
  private token = "";
  private manual = false;
  private retry = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private queuedCmds: Cmd[] = [];
  private pendingCamera: CameraMsg | null = null;
  private pendingPreview: Preview | null = null;

  constructor(private readonly store: Store) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(room: string, name: string, token = ""): void {
    this.teardown();
    this.manual = false;
    this.room = room;
    this.name = name;
    this.token = token;
    this.store.room = room;
    this.store.playerName = name;
    this.store.setStatus("connecting");
    this.open();
  }

  disconnect(): void {
    this.manual = true;
    this.teardown();
    this.store.peerId = null;
    this.store.setStatus("offline");
  }

  private teardown(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.handshakeTimer !== null) {
      window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, "client teardown");
      } catch {
        // ignore
      }
    }
  }

  private open(): void {
    const url = relayUrl();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.store.addLog("bad", `Не удалось открыть WebSocket: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      const hello: ClientMessage = {
        t: "hello",
        protocol: PROTOCOL_VERSION,
        room: this.room,
        role: "ghost",
        token: this.token || undefined,
        name: this.name || undefined,
      };
      socket.send(JSON.stringify(hello));

      if (this.handshakeTimer !== null) window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = window.setTimeout(() => {
        if (this.ws === socket && this.store.status !== "online") {
          this.store.addLog("bad", "Relay не ответил на hello.");
          socket.close(4000, "handshake timeout");
        }
      }, HANDSHAKE_TIMEOUT_MS);
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        this.store.addLog("warn", "Relay прислал не-JSON сообщение.");
        return;
      }
      if (isRecord(message) && typeof message.t === "string") {
        this.handle(message as unknown as ClientMessage);
      }
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.stopPing();
      if (this.handshakeTimer !== null) {
        window.clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.store.peerId = null;

      if (this.manual) {
        this.store.setStatus("offline");
        return;
      }

      if (this.store.status !== "reconnecting") {
        this.store.addLog(
          "warn",
          `Соединение закрыто (${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
        );
      }
      this.store.setStatus("reconnecting");
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      this.store.addLog("warn", "Ошибка WebSocket. Проверь адрес relay.");
    };
  }

  private scheduleReconnect(): void {
    if (this.manual || this.reconnectTimer !== null) return;
    const delay = Math.min(8000, 500 * 2 ** this.retry) + Math.floor(Math.random() * 250);
    this.retry = Math.min(this.retry + 1, 5);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manual) this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => {
      if (!this.connected) return;
      this.send({ t: "ping", ts: Date.now() });
    };
    ping();
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handle(message: ClientMessage): void {
    switch (message.t) {
      case "welcome": {
        this.handleWelcome(message);
        return;
      }
      case "snapshot": {
        this.store.setSnapshot(message);
        return;
      }
      case "map": {
        this.store.setMap(message);
        this.store.addLog("info", `Карта получена: ${message.scene || "без названия"}.`);
        return;
      }
      case "event": {
        this.handleGameEvent(message);
        return;
      }
      case "toast": {
        this.store.notifyFromServer(message);
        return;
      }
      case "ack": {
        this.handleAck(message);
        return;
      }
      case "peer": {
        this.handlePeer(message);
        return;
      }
      case "error": {
        this.handleError(message);
        return;
      }
      case "pong": {
        this.store.latency = Math.max(0, Date.now() - message.ts);
        this.store.emit();
        return;
      }
      case "chat": {
        this.handleChat(message);
        return;
      }
      default:
        return;
    }
  }

  private handleWelcome(message: Welcome): void {
    if (this.handshakeTimer !== null) {
      window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.retry = 0;
    this.store.peerId = message.peerId;
    this.store.peers = message.peers;
    this.store.setStatus("online", "В СЕТИ");
    this.store.addLog("good", `Подключено к комнате ${message.room}.`);
    this.startPing();
    this.flushQueue();
  }

  private handleAck(message: Ack): void {
    this.store.resolvePending(message.id, message.ok);
    if (message.energy !== undefined && message.energy !== null) {
      this.store.localEnergy = message.energy;
    }
    if (!message.ok) {
      const text = ackErrorText(message.error);
      this.store.addLog("bad", `Отказ: ${text}.`);
      this.store.notifyToast(text, "warn");
    }
  }

  private handleGameEvent(message: GameEvent): void {
    const text = eventText(message);
    const kind = eventLogKind(message.kind);
    this.store.addLog(kind, text);
    this.onGameEvent?.(message);
  }

  private handlePeer(message: PeerEvent): void {
    if (message.peerId === this.store.peerId) return;
    const label =
      message.role === "game" ? "Игра" : message.name ? `Призрак «${message.name}»` : "Призрак";
    if (message.event === "joined") {
      this.store.addLog("good", `${label} подключилась.`);
      this.store.notifyToast(`${label} на связи.`, "good");
    } else {
      this.store.addLog("warn", `${label} отключилась.`);
      this.store.notifyToast(`${label} отключилась.`, "warn");
    }
    this.store.peers = this.store.peers.filter((peer) => peer.id !== message.peerId);
    if (message.event === "joined") {
      this.store.peers.push({ id: message.peerId, role: message.role, name: message.name });
    }
    this.onPeerEvent?.(message);
    this.store.emit();
  }

  private handleError(message: ErrorMessage): void {
    this.store.addLog("bad", `Ошибка relay: ${message.message}`);
    this.store.notifyToast(message.message, "warn");
  }

  private handleChat(message: Chat): void {
    const who = message.from === "game" ? "Игрок" : "Призрак";
    this.store.addLog("info", `${who}: ${message.text}`);
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }

    if (message.t === "cmd") {
      this.queuedCmds.push(message);
      if (this.queuedCmds.length > MAX_QUEUED_CMDS) this.queuedCmds.shift();
    } else if (message.t === "camera") {
      this.pendingCamera = message;
    } else if (message.t === "preview") {
      this.pendingPreview = message;
    }
  }

  private flushQueue(): void {
    if (this.pendingPreview) {
      const preview = this.pendingPreview;
      this.pendingPreview = null;
      this.send(preview);
    }
    if (this.pendingCamera) {
      const camera = this.pendingCamera;
      this.pendingCamera = null;
      this.send(camera);
    }
    const cmds = this.queuedCmds.splice(0);
    for (const cmd of cmds) this.send(cmd);
  }

  sendCmd(ability: AbilityId, args: CmdArgs): string {
    const id = crypto.randomUUID();
    const cmd: Cmd = { t: "cmd", id, ability, args, ts: Date.now() };
    this.store.markPending(id, ability);
    this.send(cmd);
    return id;
  }

  sendCamera(pos: Vec3, yaw: number, pitch: number): void {
    this.send({ t: "camera", pos, yaw, pitch, ts: Date.now() });
  }

  sendPreview(
    active: boolean,
    ability: AbilityId | null,
    pos: Vec3,
    dir?: Vec3,
    kind?: string,
  ): void {
    this.send({
      t: "preview",
      active,
      ability,
      pos,
      dir,
      kind: kind as Preview["kind"],
      ts: Date.now(),
    });
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.send({ t: "chat", from: "ghost", text: trimmed.slice(0, 240), ts: Date.now() });
  }
}

function ackErrorText(code?: string): string {
  switch (code) {
    case "no_game":
      return "Игра ещё не подключилась";
    case "not_enough_energy":
      return "Не хватает энергии";
    case "cooldown":
      return "Способность ещё перезаряжается";
    case "unknown_ability":
      return "Неизвестная способность";
    case "bad_id":
      return "Некорректный запрос";
    case "rate_limited":
      return "Слишком часто";
    default:
      return code ?? "неизвестная ошибка";
  }
}

function eventText(event: GameEvent): string {
  const data = event.data ?? {};
  const scene = typeof data.scene === "string" ? data.scene : "";
  const text = typeof data.text === "string" ? data.text : "";
  switch (event.kind) {
    case "enemy_spawned":
      return text || "Враг материализовался.";
    case "barrel_exploded":
      return text || "Бочка взорвалась.";
    case "player_hit":
      return text || "Игрок получил урон.";
    case "player_died":
      return text || "Игрок погиб.";
    case "ghost_stunned":
      return text || "Призрак оглушён.";
    case "manifest_start":
      return text || "Манифестация началась.";
    case "manifest_end":
      return text || "Манифестация закончилась.";
    case "scare":
      return text || "Игрок испугался.";
    case "scene_changed":
      return text || `Новая сцена${scene ? `: ${scene}` : ""}.`;
    case "info":
    default:
      return text || "Событие.";
  }
}

function eventLogKind(kind: GameEvent["kind"]): "info" | "good" | "warn" | "bad" {
  switch (kind) {
    case "player_died":
    case "player_hit":
    case "enemy_spawned":
    case "ghost_stunned":
      return "bad";
    case "barrel_exploded":
    case "scare":
    case "manifest_start":
      return "good";
    case "manifest_end":
    case "scene_changed":
    case "info":
      return "info";
    default:
      return "warn";
  }
}
