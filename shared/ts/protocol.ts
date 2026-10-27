/**
 * Hard Multiplayer wire protocol (v1).
 *
 * Source of truth for both the browser client and the BepInEx mod.
 * Keep `shared/csharp/Protocol.cs` in sync when changing messages.
 */

export const PROTOCOL_VERSION = 1;

export type Role = "game" | "ghost";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type AbilityId =
  | "spawn_enemy"
  | "throw_barrel"
  | "telekinesis"
  | "poltergeist"
  | "manifest"
  | "whisper";

export type EnemyKind = "grunt" | "runner" | "shooter" | "heavy";

export interface AbilityDef {
  id: AbilityId;
  name: string;
  short: string;
  cost: number;
  cooldown: number;
  hotkey: string;
  targeting: "point" | "entity" | "self" | "none";
  minChaos: number;
  description: string;
  color: string;
}

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  spawn_enemy: {
    id: "spawn_enemy",
    name: "Спавн врага",
    short: "ВРАГ",
    cost: 25,
    cooldown: 8,
    hotkey: "1",
    targeting: "point",
    minChaos: 0,
    description:
      "Создать врага в точке. Если включён режим «за спиной», точка смещается за игрока.",
    color: "#ff5d5d",
  },
  throw_barrel: {
    id: "throw_barrel",
    name: "Взрывная бочка",
    short: "БОЧКА",
    cost: 15,
    cooldown: 4,
    hotkey: "2",
    targeting: "point",
    minChaos: 0,
    description: "Уронить горящую бочку в точку. Взрывается через несколько секунд.",
    color: "#ffb347",
  },
  telekinesis: {
    id: "telekinesis",
    name: "Телекинез",
    short: "ТК",
    cost: 10,
    cooldown: 2,
    hotkey: "3",
    targeting: "entity",
    minChaos: 0,
    description: "Дёрнуть ближайший предмет или врага в сторону игрока.",
    color: "#7dd3fc",
  },
  poltergeist: {
    id: "poltergeist",
    name: "Полтергейст",
    short: "ШУМ",
    cost: 8,
    cooldown: 6,
    hotkey: "4",
    targeting: "point",
    minChaos: 0,
    description: "Мигание света, хлопанье дверью, падающие предметы. Отвлекает и пугает.",
    color: "#c084fc",
  },
  manifest: {
    id: "manifest",
    name: "Манифестация",
    short: "ЯВЬ",
    cost: 30,
    cooldown: 20,
    hotkey: "5",
    targeting: "self",
    minChaos: 15,
    description:
      "Стать видимым на несколько секунд. Сильный страх, но игрок может заметить и атаковать призрака.",
    color: "#f472b6",
  },
  whisper: {
    id: "whisper",
    name: "Шёпот",
    short: "ШЁПОТ",
    cost: 5,
    cooldown: 10,
    hotkey: "6",
    targeting: "none",
    minChaos: 0,
    description: "Прошептать фразу игроку. Голос звучит пространственно рядом с ним.",
    color: "#a3e635",
  },
};

export const ENEMY_KINDS: { id: EnemyKind; name: string; note: string }[] = [
  { id: "grunt", name: "Ближний", note: "Обычный враг с оружием ближнего боя" },
  { id: "runner", name: "Быстрый", note: "Быстрый и хрупкий" },
  { id: "shooter", name: "Стрелок", note: "Держит дистанцию и стреляет" },
  { id: "heavy", name: "Тяжёлый", note: "Много здоровья, медленный" },
];

// ---------------------------------------------------------------------------
// Envelope / handshake
// ---------------------------------------------------------------------------

export interface Hello {
  t: "hello";
  protocol: number;
  room: string;
  role: Role;
  token?: string;
  name?: string;
}

export interface PeerInfo {
  id: string;
  role: Role;
  name?: string;
}

export interface Welcome {
  t: "welcome";
  protocol: number;
  room: string;
  peerId: string;
  peers: PeerInfo[];
  serverTime: number;
}

export interface PeerEvent {
  t: "peer";
  event: "joined" | "left";
  peerId: string;
  role: Role;
  name?: string;
}

export interface ErrorMessage {
  t: "error";
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Game -> ghost
// ---------------------------------------------------------------------------

export interface PlayerState {
  pos: Vec3;
  yaw: number;
  vel: Vec3;
  hp: number;
  alive: boolean;
}

export interface GhostState {
  pos: Vec3;
  yaw: number;
  manifested: boolean;
  stunned: boolean;
}

export interface EnemyState {
  id: number;
  kind: string;
  pos: Vec3;
  hp: number;
  state: "idle" | "chase" | "attack" | "dead";
  ghost: boolean;
}

export interface PropState {
  id: number;
  kind: string;
  pos: Vec3;
  mass: number;
}

export interface Stats {
  scares: number;
  kills: number;
  spawns: number;
  barrels: number;
  sessionTime: number;
}

export interface Snapshot {
  t: "snapshot";
  seq: number;
  ts: number;
  scene: string;
  player: PlayerState;
  ghost: GhostState;
  enemies: EnemyState[];
  props: PropState[];
  energy: number;
  maxEnergy: number;
  chaos: number;
  cooldowns: Record<string, number>;
  stats: Stats;
}

export interface MapBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface MapWall {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface MapImage {
  mime: string;
  data: string;
  width: number;
  height: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface MapData {
  t: "map";
  scene: string;
  bounds: MapBounds;
  walls: MapWall[];
  image?: MapImage;
}

export type EventKind =
  | "enemy_spawned"
  | "barrel_exploded"
  | "player_hit"
  | "player_died"
  | "ghost_stunned"
  | "manifest_start"
  | "manifest_end"
  | "scare"
  | "scene_changed"
  | "info";

export interface GameEvent {
  t: "event";
  kind: EventKind;
  data?: Record<string, unknown>;
  ts: number;
}

export interface Toast {
  t: "toast";
  text: string;
  level?: "info" | "warn" | "good";
}

export interface Pong {
  t: "pong";
  ts: number;
}

// ---------------------------------------------------------------------------
// Ghost -> game
// ---------------------------------------------------------------------------

export interface CmdArgs {
  kind?: string;
  x?: number;
  y?: number;
  z?: number;
  targetId?: number;
  power?: number;
  duration?: number;
  text?: string;
  behind?: boolean;
  distance?: number;
  fuse?: number;
  mode?: string;
}

export interface Cmd {
  t: "cmd";
  id: string;
  ability: AbilityId;
  args: CmdArgs;
  ts: number;
}

export interface Ack {
  t: "ack";
  id: string;
  ok: boolean;
  error?: string;
  energy?: number;
  cooldown?: number;
}

export interface CameraMsg {
  t: "camera";
  pos: Vec3;
  yaw: number;
  ts: number;
}

export interface Ping {
  t: "ping";
  ts: number;
}

export interface Chat {
  t: "chat";
  from: Role;
  text: string;
  ts: number;
}

export type ClientMessage = Hello | Cmd | CameraMsg | Ping | Chat | Snapshot | MapData | GameEvent | Toast | Ack | Pong | Welcome | PeerEvent | ErrorMessage;

export function isAbilityId(value: string): value is AbilityId {
  return value in ABILITIES;
}

export function roomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
