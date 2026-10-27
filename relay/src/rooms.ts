import type { RawData, WebSocket } from "ws";
import {
  ABILITIES,
  PROTOCOL_VERSION,
  isAbilityId,
  type Ack,
  type AbilityId,
  type Chat,
  type Cmd,
  type CmdArgs,
  type ErrorMessage,
  type GameEvent,
  type Hello,
  type MapData,
  type PeerEvent,
  type PeerInfo,
  type Ping,
  type Pong,
  type Preview,
  type Role,
  type Snapshot,
  type Toast,
  type Welcome,
} from "@hm/protocol";
import { logger } from "./log.js";

const MAX_GAME_PEERS = 1;
const MAX_GHOST_PEERS = 2;
const MAX_NAME = 24;
const MAX_CHAT = 240;
const MAX_CMD_ID = 64;
const RATE_PER_SECOND = 80;
const RATE_BURST = 160;
const COOLDOWN_TOLERANCE_MS = 250;

export interface Peer {
  id: string;
  role: Role;
  name?: string;
  ws: WebSocket;
  room: Room;
  alive: boolean;
  lastSeen: number;
  rateTokens: number;
  rateRefilledAt: number;
}

export interface JoinRequest {
  ws: WebSocket;
  role: Role;
  room: string;
  name?: string;
}

export type JoinResult =
  | { ok: true; peer: Peer; room: Room }
  | { ok: false; code: string; message: string };

export interface RoomSummary {
  code: string;
  game: boolean;
  ghosts: number;
  peers: number;
}

function randomId(): string {
  return `p_${Math.random().toString(16).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

export function normalizeRoom(value: string): string | null {
  const room = value.trim().toUpperCase();
  return /^[A-Z0-9]{4,8}$/.test(room) ? room : null;
}

function sanitizeArgs(input: unknown): CmdArgs {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const args: CmdArgs = {};

  const kind = cleanText(raw.kind, 24);
  if (kind) args.kind = kind;

  for (const key of ["x", "y", "z", "dirX", "dirZ", "power", "duration", "fuse"] as const) {
    const value = finite(raw[key]);
    if (value !== undefined) args[key] = clamp(value, -10_000, 10_000);
  }

  const targetId = finite(raw.targetId);
  if (targetId !== undefined) args.targetId = Math.trunc(targetId);

  const mode = cleanText(raw.mode, 24);
  if (mode) args.mode = mode;

  return args;
}

function parseJson(raw: RawData): unknown {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class Room {
  readonly code: string;
  readonly peers = new Map<string, Peer>();
  readonly createdAt = Date.now();
  emptySince: number | null = Date.now();

  /** Last known authoritative-ish state, used for soft command validation. */
  lastSnapshotAt = 0;
  energy: number | null = null;
  maxEnergy = 100;
  readonly cooldownUntil = new Map<string, number>();

  /** Cache for late joiners / reconnects. */
  lastMap: MapData | null = null;
  lastSnapshot: Snapshot | null = null;

  constructor(code: string) {
    this.code = code;
  }

  get gamePeer(): Peer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.role === "game") return peer;
    }
    return undefined;
  }

  get ghostPeers(): Peer[] {
    return [...this.peers.values()].filter((peer) => peer.role === "ghost");
  }

  peerInfos(exceptId?: string): PeerInfo[] {
    return [...this.peers.values()]
      .filter((peer) => peer.id !== exceptId)
      .map((peer) => ({ id: peer.id, role: peer.role, name: peer.name }));
  }

  canJoin(role: Role): boolean {
    if (role === "game") return !this.gamePeer;
    return this.ghostPeers.length < MAX_GHOST_PEERS;
  }

  add(peer: Peer): void {
    this.peers.set(peer.id, peer);
    this.emptySince = null;
  }

  remove(peer: Peer): void {
    this.peers.delete(peer.id);
    if (this.peers.size === 0) this.emptySince = Date.now();
  }

  send(peer: Peer, message: unknown): void {
    if (peer.ws.readyState !== peer.ws.OPEN) return;
    try {
      peer.ws.send(JSON.stringify(message));
    } catch (error) {
      logger.warn("room", `send to ${peer.id} failed: ${String(error)}`);
    }
  }

  broadcast(message: unknown, exceptId?: string): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      if (peer.id === exceptId) continue;
      if (peer.ws.readyState !== peer.ws.OPEN) continue;
      try {
        peer.ws.send(payload);
      } catch (error) {
        logger.warn("room", `broadcast to ${peer.id} failed: ${String(error)}`);
      }
    }
  }

  broadcastToRole(role: Role, message: unknown): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      if (peer.role !== role || peer.ws.readyState !== peer.ws.OPEN) continue;
      try {
        peer.ws.send(payload);
      } catch (error) {
        logger.warn("room", `broadcast to ${peer.id} failed: ${String(error)}`);
      }
    }
  }

  peerJoined(peer: Peer): PeerEvent {
    return { t: "peer", event: "joined", peerId: peer.id, role: peer.role, name: peer.name };
  }

  peerLeft(peer: Peer): PeerEvent {
    return { t: "peer", event: "left", peerId: peer.id, role: peer.role, name: peer.name };
  }

  welcome(peer: Peer): Welcome {
    return {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      room: this.code,
      peerId: peer.id,
      peers: this.peerInfos(peer.id),
      serverTime: Date.now(),
    };
  }

  /** Replay the last map/snapshot so a late ghost does not stare at a blank map. */
  sendCache(peer: Peer): void {
    if (peer.role !== "ghost") return;
    if (this.lastMap) this.send(peer, this.lastMap);
    if (this.lastSnapshot) this.send(peer, this.lastSnapshot);
  }

  private consumeRate(peer: Peer, now: number): boolean {
    const elapsed = Math.max(0, now - peer.rateRefilledAt);
    peer.rateTokens = Math.min(RATE_BURST, peer.rateTokens + (elapsed / 1000) * RATE_PER_SECOND);
    peer.rateRefilledAt = now;
    if (peer.rateTokens < 1) return false;
    peer.rateTokens -= 1;
    return true;
  }

  handleRaw(peer: Peer, raw: RawData): void {
    const now = Date.now();
    peer.lastSeen = now;

    if (!this.consumeRate(peer, now)) {
      this.send(peer, {
        t: "error",
        code: "rate_limited",
        message: "Слишком много сообщений. Притормози.",
      } satisfies ErrorMessage);
      return;
    }

    const message = parseJson(raw);
    if (!isRecord(message) || typeof message.t !== "string") {
      this.send(peer, {
        t: "error",
        code: "bad_message",
        message: "Ожидался JSON-объект с полем t.",
      } satisfies ErrorMessage);
      return;
    }

    switch (message.t) {
      case "ping": {
        const ts = finite(message.ts) ?? now;
        this.send(peer, { t: "pong", ts } satisfies Pong);
        return;
      }
      case "cmd":
        this.handleCmd(peer, message);
        return;
      case "preview":
        this.handlePreview(peer, message);
        return;
      case "camera":
        this.handleCamera(peer, message);
        return;
      case "chat":
        this.handleChat(peer, message);
        return;
      case "snapshot":
        if (peer.role === "game") this.handleSnapshot(message);
        return;
      case "map":
        if (peer.role === "game") {
          this.lastMap = message as unknown as MapData;
          this.broadcastToRole("ghost", this.lastMap);
        }
        return;
      case "event":
        if (peer.role === "game") this.broadcastToRole("ghost", message as unknown as GameEvent);
        return;
      case "toast":
        if (peer.role === "game") this.broadcastToRole("ghost", message as unknown as Toast);
        return;
      case "ack":
        if (peer.role === "game") this.broadcastToRole("ghost", message as unknown as Ack);
        return;
      default:
        this.send(peer, {
          t: "error",
          code: "unknown_message",
          message: `Неизвестный тип сообщения: ${message.t}`,
        } satisfies ErrorMessage);
    }
  }

  private handleSnapshot(message: Record<string, unknown>): void {
    const now = Date.now();
    const snapshot = message as unknown as Snapshot;
    this.lastSnapshot = snapshot;
    this.lastSnapshotAt = now;
    if (typeof snapshot.energy === "number" && Number.isFinite(snapshot.energy)) {
      this.energy = snapshot.energy;
    }
    if (typeof snapshot.maxEnergy === "number" && Number.isFinite(snapshot.maxEnergy)) {
      this.maxEnergy = snapshot.maxEnergy;
    }
    if (isRecord(snapshot.cooldowns)) {
      this.cooldownUntil.clear();
      for (const [ability, remaining] of Object.entries(snapshot.cooldowns)) {
        if (typeof remaining === "number" && Number.isFinite(remaining) && remaining > 0) {
          this.cooldownUntil.set(ability, now + remaining * 1000);
        }
      }
    }
    this.broadcastToRole("ghost", message);
  }

  private handleCmd(peer: Peer, message: Record<string, unknown>): void {
    if (peer.role !== "ghost") {
      this.send(peer, {
        t: "error",
        code: "bad_role",
        message: "Команды может отправлять только призрак.",
      } satisfies ErrorMessage);
      return;
    }

    const id = typeof message.id === "string" ? message.id.slice(0, MAX_CMD_ID) : "";
    if (!id) {
      this.send(peer, this.ack("", false, "bad_id"));
      return;
    }

    const ability = typeof message.ability === "string" ? message.ability : "";
    if (!isAbilityId(ability)) {
      this.send(peer, this.ack(id, false, "unknown_ability"));
      return;
    }

    const game = this.gamePeer;
    if (!game) {
      this.send(peer, this.ack(id, false, "no_game"));
      return;
    }

    const def = ABILITIES[ability];
    const now = Date.now();

    if (this.energy !== null && def.cost > this.energy + 0.5) {
      this.send(peer, this.ack(id, false, "not_enough_energy"));
      return;
    }

    const until = this.cooldownUntil.get(ability) ?? 0;
    if (until - now > COOLDOWN_TOLERANCE_MS) {
      this.send(peer, this.ack(id, false, "cooldown"));
      return;
    }

    const cmd: Cmd = {
      t: "cmd",
      id,
      ability: ability as AbilityId,
      args: sanitizeArgs(message.args),
      ts: now,
    };

    this.send(game, cmd);
    logger.debug("room", `${this.code} cmd ${ability} ${id} -> game`);
  }

  private handlePreview(peer: Peer, message: Record<string, unknown>): void {
    if (peer.role !== "ghost") return;
    const game = this.gamePeer;
    if (!game) return;

    const ability =
      typeof message.ability === "string" && isAbilityId(message.ability) ? message.ability : null;
    const active = message.active === true && ability !== null;

    if (!active || ability === null) {
      this.send(game, {
        t: "preview",
        active: false,
        ability: null,
        pos: { x: 0, y: 0, z: 0 },
        ts: Date.now(),
      } satisfies Preview);
      return;
    }

    const pos = isRecord(message.pos) ? message.pos : {};
    const x = finite(pos.x);
    const y = finite(pos.y);
    const z = finite(pos.z);
    if (x === undefined || y === undefined || z === undefined) return;

    let dir: { x: number; y: number; z: number } | undefined;
    if (isRecord(message.dir)) {
      const dx = finite(message.dir.x);
      const dz = finite(message.dir.z);
      if (dx !== undefined && dz !== undefined) {
        const length = Math.hypot(dx, dz);
        if (length > 0.0001) {
          dir = { x: dx / length, y: 0, z: dz / length };
        }
      }
    }

    const kind = cleanText(message.kind, 24);
    const enemyKind =
      kind === "grunt" || kind === "runner" || kind === "shooter" || kind === "heavy"
        ? kind
        : undefined;

    this.send(game, {
      t: "preview",
      active: true,
      ability,
      pos: {
        x: clamp(x, -10_000, 10_000),
        y: clamp(y, -10_000, 10_000),
        z: clamp(z, -10_000, 10_000),
      },
      dir,
      kind: enemyKind,
      ts: Date.now(),
    } satisfies Preview);
  }

  private handleCamera(peer: Peer, message: Record<string, unknown>): void {
    if (peer.role !== "ghost") return;
    const game = this.gamePeer;
    if (!game) return;

    const pos = isRecord(message.pos) ? message.pos : {};
    const x = finite(pos.x);
    const y = finite(pos.y);
    const z = finite(pos.z);
    const yaw = finite(message.yaw);
    const pitch = finite(message.pitch);
    if (x === undefined || z === undefined) return;

    this.send(game, {
      t: "camera",
      pos: { x: clamp(x, -10_000, 10_000), y: clamp(y ?? 0, -10_000, 10_000), z: clamp(z, -10_000, 10_000) },
      yaw: yaw ?? 0,
      pitch: pitch ?? 0,
      ts: Date.now(),
    });
  }

  private handleChat(peer: Peer, message: Record<string, unknown>): void {
    const text = cleanText(message.text, MAX_CHAT);
    if (!text) return;
    const chat: Chat = { t: "chat", from: peer.role, text, ts: Date.now() };
    this.broadcast(chat, peer.id);
  }

  private ack(id: string, ok: boolean, error?: string): Ack {
    return {
      t: "ack",
      id,
      ok,
      error,
      energy: this.energy ?? undefined,
      cooldown: 0,
    };
  }
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly emptyTtlMs: number;

  constructor(emptyTtlMinutes = 15) {
    this.emptyTtlMs = emptyTtlMinutes * 60_000;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  summary(code: string): RoomSummary | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    return {
      code: room.code,
      game: Boolean(room.gamePeer),
      ghosts: room.ghostPeers.length,
      peers: room.peers.size,
    };
  }

  join(request: JoinRequest): JoinResult {
    const room = this.rooms.get(request.room) ?? new Room(request.room);
    if (!room.canJoin(request.role)) {
      return {
        ok: false,
        code: "room_full",
        message:
          request.role === "game"
            ? "В этой комнате уже есть игра. Используй другой код."
            : "В этой комнате уже максимум призраков.",
      };
    }

    const peer: Peer = {
      id: randomId(),
      role: request.role,
      name: cleanText(request.name, MAX_NAME),
      ws: request.ws,
      room,
      alive: true,
      lastSeen: Date.now(),
      rateTokens: RATE_BURST,
      rateRefilledAt: Date.now(),
    };

    room.add(peer);
    this.rooms.set(room.code, room);
    return { ok: true, peer, room };
  }

  leave(peer: Peer): void {
    peer.room.remove(peer);
    peer.room.broadcast(peer.room.peerLeft(peer));
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (room.peers.size > 0) continue;
      if (room.emptySince !== null && now - room.emptySince < this.emptyTtlMs) continue;
      this.rooms.delete(code);
      removed += 1;
    }
    return removed;
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      for (const peer of room.peers.values()) {
        try {
          peer.ws.close(1001, "server shutdown");
        } catch {
          // ignore
        }
      }
    }
    this.rooms.clear();
  }
}

export function parseHello(raw: RawData): Hello | null {
  const value = parseJson(raw);
  if (!isRecord(value)) return null;
  if (value.t !== "hello") return null;
  if (typeof value.protocol !== "number" || !Number.isFinite(value.protocol)) return null;
  if (typeof value.room !== "string") return null;
  if (value.role !== "game" && value.role !== "ghost") return null;
  return {
    t: "hello",
    protocol: value.protocol,
    room: value.room,
    role: value.role,
    token: typeof value.token === "string" ? value.token : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}

export { MAX_GAME_PEERS, MAX_GHOST_PEERS };
