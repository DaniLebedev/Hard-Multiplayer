/**
 * Hard Multiplayer wire protocol (v2).
 *
 * Source of truth for both the browser client and the BepInEx mod.
 * Keep `shared/csharp/Protocol.cs` in sync when changing messages.
 *
 * v2 changes:
 *  - ghost flies in 3D (camera carries pitch, map carries Y and floor level);
 *  - abilities announce an intent via `preview` before they are cast;
 *  - barrels fly along an explicit direction;
 *  - chaos meter and whisper ability were removed.
 */

export const PROTOCOL_VERSION = 2;

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
  | "manifest";

export type EnemyKind = "grunt" | "runner" | "shooter" | "heavy";

export interface AbilityDef {
  id: AbilityId;
  name: string;
  short: string;
  cost: number;
  cooldown: number;
  hotkey: string;
  targeting: "point" | "entity" | "self" | "none";
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
    description:
      "Поставить голограмму врага. Пока голограмма горит, игрок видит, где появится враг. ЛКМ — материализовать.",
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
    description:
      "Поставить голограмму бочки. Стрелка показывает, куда она полетит. ЛКМ — бросить.",
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
    description:
      "Стать видимым на несколько секунд. Игрок может заметить и атаковать призрака.",
    color: "#f472b6",
  },
};

/** Abilities that show a hologram of the future action. */
export const PREVIEW_ABILITIES: AbilityId[] = [
  "spawn_enemy",
  "throw_barrel",
  "telekinesis",
  "poltergeist",
];

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
  /** Centre of the box. */
  x: number;
  y: number;
  z: number;
  /** Size along world axes. */
  w: number;
  h: number;
  d: number;
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
  /** World Y of the floor the ghost should not fly below. */
  floorY: number;
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
  /** Horizontal direction for flying props (normalized by the mod). */
  dirX?: number;
  dirZ?: number;
  targetId?: number;
  power?: number;
  duration?: number;
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

/**
 * Ghost intent preview. The mod renders a hologram in the game world and the
 * browser renders the same thing locally, so the VR player can react before
 * the ability is actually used.
 */
export interface Preview {
  t: "preview";
  active: boolean;
  ability: AbilityId | null;
  pos: Vec3;
  /** Flight direction for throw_barrel (horizontal, normalized). */
  dir?: Vec3;
  kind?: EnemyKind;
  ts: number;
}

export interface CameraMsg {
  t: "camera";
  pos: Vec3;
  yaw: number;
  pitch: number;
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

export type ClientMessage =
  | Hello
  | Cmd
  | Preview
  | CameraMsg
  | Ping
  | Chat
  | Snapshot
  | MapData
  | GameEvent
  | Toast
  | Ack
  | Pong
  | Welcome
  | PeerEvent
  | ErrorMessage;

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
