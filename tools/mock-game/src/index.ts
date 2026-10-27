import { WebSocket } from "ws";
import {
  ABILITIES,
  PROTOCOL_VERSION,
  type AbilityId,
  type Ack,
  type CameraMsg,
  type Cmd,
  type EnemyKind,
  type EnemyState,
  type GameEvent,
  type MapData,
  type MapWall,
  type PlayerState,
  type Preview,
  type PropState,
  type Snapshot,
  type Toast,
} from "@hm/protocol";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "1"] = arg.replace(/^--/, "").split("=");
    return [key, value] as const;
  }),
);

const ROOM = (args.get("room") ?? process.env.ROOM ?? "TEST").toUpperCase();
const RELAY = args.get("relay") ?? process.env.RELAY_URL ?? "ws://127.0.0.1:8080/ws";
const NAME = args.get("name") ?? "Mock VR";

const FLOOR_Y = 0;

function wall(x: number, y: number, z: number, w: number, h: number, d: number): MapWall {
  return { x, y, z, w, h, d };
}

const WALLS: MapWall[] = [
  wall(0, 2, 30, 60, 4, 1),
  wall(0, 2, -30, 60, 4, 1),
  wall(30, 2, 0, 1, 4, 60),
  wall(-30, 2, 0, 1, 4, 60),
  wall(-12, 1.25, 8, 6, 2.5, 5),
  wall(10, 1.1, -7, 7, 2.2, 4),
  wall(2, 0.9, 16, 10, 1.8, 1.2),
  wall(-18, 1.5, -12, 4, 3, 8),
  wall(17, 1.4, 12, 5, 2.8, 5),
  wall(0, 0.7, -2, 2, 1.4, 2),
  wall(-8, 0.6, -16, 8, 1.2, 1),
  wall(14, 0.6, 2, 1, 1.2, 9),
];

const MAP: MapData = {
  t: "map",
  scene: "mock_arena",
  bounds: { minX: -30, minZ: -30, maxX: 30, maxZ: 30 },
  floorY: FLOOR_Y,
  walls: WALLS,
};

const ENEMY_HP: Record<EnemyKind, number> = {
  grunt: 80,
  runner: 45,
  shooter: 60,
  heavy: 160,
};

interface Barrel {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fuse: number;
  radius: number;
}

const state = {
  scene: "mock_arena",
  player: {
    pos: { x: 0, y: FLOOR_Y, z: 0 },
    yaw: 0,
    vel: { x: 0, y: 0, z: 0 },
    hp: 100,
    alive: true,
  } as PlayerState,
  ghost: {
    pos: { x: 0, y: 1.6, z: -6 },
    yaw: 0,
    manifested: false,
    stunned: false,
  },
  enemies: [] as EnemyState[],
  props: [] as PropState[],
  barrels: [] as Barrel[],
  energy: 100,
  maxEnergy: 100,
  cooldowns: {} as Record<string, number>,
  stats: { scares: 0, kills: 0, spawns: 0, barrels: 0, sessionTime: 0 },
  seq: 0,
  startedAt: Date.now(),
  manifestUntil: 0,
  stunnedUntil: 0,
  respawnAt: 0,
  nextId: 1,
};

for (let i = 0; i < 18; i += 1) {
  const angle = (i / 18) * Math.PI * 2;
  state.props.push({
    id: state.nextId++,
    kind: i % 3 === 0 ? "crate" : i % 3 === 1 ? "bottle" : "chair",
    pos: {
      x: Math.sin(angle) * (8 + (i % 5) * 3),
      y: FLOOR_Y + 0.25,
      z: Math.cos(angle) * (8 + (i % 7) * 2),
    },
    mass: i % 3 === 0 ? 18 : 1.2,
  });
}

let ws: WebSocket | null = null;
let loop: NodeJS.Timeout | null = null;
let lastTick = Date.now();
let playerPhase = 0;

function log(...parts: unknown[]): void {
  console.log(`[mock] ${new Date().toISOString().slice(11, 19)}`, ...parts);
}

function send(message: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendEvent(kind: GameEvent["kind"], data?: Record<string, unknown>): void {
  send({ t: "event", kind, data, ts: Date.now() } satisfies GameEvent);
}

function sendToast(text: string, level: "info" | "warn" | "good" = "info"): void {
  send({ t: "toast", text, level } satisfies Toast);
}

function sendAck(id: string, ok: boolean, error?: string): void {
  send({
    t: "ack",
    id,
    ok,
    error,
    energy: state.energy,
    cooldown: 0,
  } satisfies Ack);
}

function snapshot(): Snapshot {
  return {
    t: "snapshot",
    seq: state.seq++,
    ts: Date.now(),
    scene: state.scene,
    player: state.player,
    ghost: state.ghost,
    enemies: state.enemies,
    props: state.props,
    energy: state.energy,
    maxEnergy: state.maxEnergy,
    cooldowns: state.cooldowns,
    stats: state.stats,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function spawnEnemy(kind: EnemyKind, x: number, z: number, ghost: boolean): EnemyState {
  const enemy: EnemyState = {
    id: state.nextId++,
    kind,
    pos: { x: clamp(x, -28, 28), y: FLOOR_Y, z: clamp(z, -28, 28) },
    hp: ENEMY_HP[kind],
    state: "chase",
    ghost,
  };
  state.enemies.push(enemy);
  state.stats.spawns += 1;
  sendEvent("enemy_spawned", { id: enemy.id, kind, x: enemy.pos.x, z: enemy.pos.z });
  return enemy;
}

function applyCmd(cmd: Cmd): void {
  const def = ABILITIES[cmd.ability as AbilityId];
  if (!def) {
    sendAck(cmd.id, false, "unknown_ability");
    return;
  }

  if (state.energy + 0.5 < def.cost) {
    sendAck(cmd.id, false, "not_enough_energy");
    return;
  }
  if ((state.cooldowns[cmd.ability] ?? 0) > 0.1) {
    sendAck(cmd.id, false, "cooldown");
    return;
  }

  state.energy = Math.max(0, state.energy - def.cost);
  state.cooldowns[cmd.ability] = def.cooldown;

  const px = cmd.args.x ?? state.player.pos.x;
  const py = cmd.args.y ?? FLOOR_Y;
  const pz = cmd.args.z ?? state.player.pos.z;

  switch (cmd.ability) {
    case "spawn_enemy": {
      const kind = (cmd.args.kind as EnemyKind) ?? "grunt";
      spawnEnemy(kind in ENEMY_HP ? kind : "grunt", px, pz, true);
      break;
    }
    case "throw_barrel": {
      const dirX = cmd.args.dirX ?? 0;
      const dirZ = cmd.args.dirZ ?? 1;
      const length = Math.hypot(dirX, dirZ) || 1;
      const speed = clamp(cmd.args.power ?? 14, 4, 30);
      state.barrels.push({
        id: state.nextId++,
        x: clamp(px, -28, 28),
        y: Math.max(FLOOR_Y + 0.4, py),
        z: clamp(pz, -28, 28),
        vx: (dirX / length) * speed,
        vy: 2.2,
        vz: (dirZ / length) * speed,
        fuse: clamp(cmd.args.fuse ?? 3, 1, 10),
        radius: 6,
      });
      state.stats.barrels += 1;
      sendEvent("info", { text: "Бочка брошена." });
      break;
    }
    case "telekinesis": {
      state.stats.scares += 1;
      sendEvent("scare", { text: "Предмет дёрнулся." });
      break;
    }
    case "poltergeist": {
      state.stats.scares += 1;
      sendEvent("scare", { text: "Свет мигнул, что-то упало." });
      break;
    }
    case "manifest": {
      state.ghost.manifested = true;
      state.manifestUntil = Date.now() + (cmd.args.duration ?? 8) * 1000;
      sendEvent("manifest_start", { duration: cmd.args.duration ?? 8 });
      break;
    }
    default:
      break;
  }

  sendAck(cmd.id, true);
}

function applyPreview(preview: Preview): void {
  log(
    "preview:",
    preview.active ? `${preview.ability} @ ${preview.pos.x.toFixed(1)},${preview.pos.y.toFixed(1)},${preview.pos.z.toFixed(1)}` : "off",
  );
}

function tick(): void {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;

  if (state.player.alive) {
    playerPhase += dt;
    const nx = Math.sin(playerPhase * 0.33) * 9;
    const nz = Math.cos(playerPhase * 0.21) * 7;
    state.player.vel = {
      x: (nx - state.player.pos.x) / Math.max(dt, 0.001),
      y: 0,
      z: (nz - state.player.pos.z) / Math.max(dt, 0.001),
    };
    state.player.pos.x = nx;
    state.player.pos.z = nz;
    if (Math.hypot(state.player.vel.x, state.player.vel.z) > 0.1) {
      state.player.yaw = Math.atan2(state.player.vel.x, state.player.vel.z);
    }
    state.player.hp = Math.min(100, state.player.hp + 1.2 * dt);
  } else if (now >= state.respawnAt) {
    state.player.alive = true;
    state.player.hp = 100;
    state.player.pos.x = 0;
    state.player.pos.z = 0;
    sendToast("Игрок возродился.", "info");
    sendEvent("info", { text: "Игрок возродился." });
  }

  state.energy = Math.min(state.maxEnergy, state.energy + 4.5 * dt);

  for (const [ability, remaining] of Object.entries(state.cooldowns)) {
    const next = remaining - dt;
    if (next <= 0) delete state.cooldowns[ability];
    else state.cooldowns[ability] = next;
  }

  for (const enemy of state.enemies) {
    if (enemy.state === "dead") continue;
    const dx = state.player.pos.x - enemy.pos.x;
    const dz = state.player.pos.z - enemy.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.8) {
      const speed = enemy.kind === "runner" ? 2.6 : enemy.kind === "heavy" ? 0.9 : 1.6;
      enemy.pos.x += (dx / dist) * speed * dt;
      enemy.pos.z += (dz / dist) * speed * dt;
      enemy.state = "chase";
    } else {
      enemy.state = "attack";
      if (state.player.alive) {
        state.player.hp = Math.max(0, state.player.hp - 6 * dt);
        if (state.player.hp <= 0) {
          state.player.alive = false;
          state.respawnAt = now + 5000;
          state.stats.kills += 1;
          sendEvent("player_died", { text: "Игрок погиб." });
          sendToast("Игрок погиб. Отдых 5 секунд.", "good");
        }
      }
    }
  }

  for (const barrel of state.barrels) {
    barrel.vy -= 9.8 * dt;
    barrel.x += barrel.vx * dt;
    barrel.y += barrel.vy * dt;
    barrel.z += barrel.vz * dt;

    if (barrel.y < FLOOR_Y + 0.45) {
      barrel.y = FLOOR_Y + 0.45;
      barrel.vy = Math.abs(barrel.vy) * 0.28;
      barrel.vx *= 0.72;
      barrel.vz *= 0.72;
    }

    barrel.fuse -= dt;
    if (barrel.fuse <= 0) {
      const dist = distance(barrel.x, barrel.z, state.player.pos.x, state.player.pos.z);
      if (dist <= barrel.radius && state.player.alive) {
        state.player.hp = Math.max(0, state.player.hp - 38);
        if (state.player.hp <= 0) {
          state.player.alive = false;
          state.respawnAt = now + 5000;
          state.stats.kills += 1;
          sendEvent("player_died", { text: "Игрок погиб от взрыва." });
        } else {
          sendEvent("player_hit", { damage: 38, text: "Игрок ранен взрывом." });
        }
      }
      state.stats.scares += 1;
      sendEvent("barrel_exploded", {
        x: barrel.x,
        y: barrel.y,
        z: barrel.z,
        radius: barrel.radius,
      });
      barrel.fuse = Number.POSITIVE_INFINITY;
    }
  }
  state.barrels = state.barrels.filter((barrel) => Number.isFinite(barrel.fuse));

  if (state.ghost.manifested && now >= state.manifestUntil) {
    state.ghost.manifested = false;
    sendEvent("manifest_end", {});
  }
  if (state.ghost.stunned && now >= state.stunnedUntil) {
    state.ghost.stunned = false;
    sendEvent("info", { text: "Призрак пришёл в себя." });
  }
  if (
    state.ghost.manifested &&
    distance(state.ghost.pos.x, state.ghost.pos.z, state.player.pos.x, state.player.pos.z) < 1.6
  ) {
    state.ghost.stunned = true;
    state.ghost.manifested = false;
    state.stunnedUntil = now + 5000;
    sendEvent("ghost_stunned", { text: "Игрок схватил призрака." });
  }

  state.stats.sessionTime = (now - state.startedAt) / 1000;

  send(snapshot());
}

function connect(): void {
  log(`connecting to ${RELAY} as room ${ROOM}`);
  const socket = new WebSocket(RELAY);
  ws = socket;

  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        t: "hello",
        protocol: PROTOCOL_VERSION,
        room: ROOM,
        role: "game",
        name: NAME,
      }),
    );
  });

  socket.on("message", (raw) => {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const msg = message as Record<string, unknown>;

    switch (msg.t) {
      case "welcome":
        log(`joined room ${String(msg.room)} as ${String(msg.peerId)}`);
        send(MAP);
        sendToast("Mock game подключён. Призрак может играть.", "good");
        if (loop) clearInterval(loop);
        lastTick = Date.now();
        loop = setInterval(tick, 100);
        break;
      case "cmd":
        applyCmd(msg as unknown as Cmd);
        break;
      case "preview":
        applyPreview(msg as unknown as Preview);
        break;
      case "camera": {
        const camera = msg as unknown as CameraMsg;
        state.ghost.pos.x = camera.pos.x;
        state.ghost.pos.y = camera.pos.y;
        state.ghost.pos.z = camera.pos.z;
        state.ghost.yaw = camera.yaw;
        break;
      }
      case "chat":
        log("chat:", msg.text);
        break;
      case "peer":
        log(`peer ${String(msg.event)}: ${String(msg.role)} ${String(msg.name ?? "")}`);
        if (msg.event === "joined" && msg.role === "ghost") {
          sendToast("Призрак подключился.", "good");
        }
        break;
      case "error":
        log("relay error:", msg.code, msg.message);
        break;
      default:
        break;
    }
  });

  socket.on("close", (code, reason) => {
    log(`closed (${code}${reason.length ? `: ${reason.toString()}` : ""}); retrying in 2s`);
    if (loop) {
      clearInterval(loop);
      loop = null;
    }
    ws = null;
    setTimeout(connect, 2000);
  });

  socket.on("error", (error) => {
    log("socket error:", String(error));
  });
}

process.on("SIGINT", () => {
  if (loop) clearInterval(loop);
  ws?.close(1000, "mock shutdown");
  process.exit(0);
});

connect();
