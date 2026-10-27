import "./styles.css";
import { ABILITIES, roomCode, type AbilityId, type CmdArgs, type GameEvent } from "@hm/protocol";
import { AudioEngine } from "./audio";
import { Net } from "./net";
import { MapRenderer } from "./render";
import { Store } from "./state";
import { UI } from "./ui";

const WHISPERS = [
  "Я вижу тебя.",
  "Не оборачивайся.",
  "Ты слышишь это?",
  "Здесь кто-то есть.",
  "Останься со мной.",
  "Ты не один.",
  "Оно уже близко.",
  "Не выключай свет.",
];

const store = new Store();
const audio = new AudioEngine();
const net = new Net(store);

const canvas = document.getElementById("map") as HTMLCanvasElement;
const aimReadout = document.getElementById("aim-readout")!;

const renderer = new MapRenderer(canvas, store, {
  onCast: (x, z) => cast(x, z),
  onAim: (x, z, inside) => {
    store.aim = { x, z, valid: inside };
    aimReadout.textContent = inside ? `X ${x.toFixed(1)} · Z ${z.toFixed(1)}` : "X — · Z —";
  },
});

const ui = new UI(store, {
  cast: () => cast(),
  select: (id) => selectAbility(id),
  leave: () => leave(),
  toggleSound: () => toggleSound(),
  resetView: () => renderer.resetView(),
  connect: (room, name) => connect(room, name),
  newRoom: () => roomCode(),
  setBehind: (value) => {
    store.behind = value;
    store.emit();
  },
  setEnemyKind: (kind) => {
    store.enemyKind = kind;
    store.emit();
  },
  setWhisper: (value) => {
    store.whisper = value;
  },
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect(room: string, name: string): void {
  const normalized = room.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(normalized)) {
    ui.setLobbyError("Код комнаты: 4–8 символов, только A–Z и 0–9.");
    return;
  }

  localStorage.setItem("hm.room", normalized);
  localStorage.setItem("hm.name", name);
  ui.setLobbyError("");
  ui.setLobbyBusy(true);
  ui.showLobby(false);
  store.room = normalized;
  store.playerName = name;
  store.addLog("info", `Подключение к комнате ${normalized}...`);

  const url = new URL(window.location.href);
  url.searchParams.set("room", normalized);
  window.history.replaceState(null, "", url);

  audio.resume();
  net.connect(normalized, name);
}

function leave(): void {
  net.disconnect();
  store.room = "";
  store.peerId = null;
  store.snapshot = null;
  store.map = null;
  store.mapImage = null;
  store.ghostLocal = null;
  ui.setLobbyBusy(false);
  ui.showLobby(true);
  ui.setLobbyValues(localStorage.getItem("hm.room") ?? "", localStorage.getItem("hm.name") ?? "");

  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

function selectAbility(id: AbilityId): void {
  store.select(id);
  audio.play("click");
}

function cast(x?: number, z?: number): void {
  if (ui.isLobbyOpen() || ui.isHelpOpen()) return;
  if (!net.connected) {
    store.notifyToast("Нет соединения с relay.", "warn");
    audio.play("error");
    return;
  }

  const def = ABILITIES[store.selected];
  const cooldown = store.cooldownRemaining(def.id);
  if (cooldown > 0.05) {
    store.notifyToast(`Перезарядка: ${Math.ceil(cooldown)} с.`, "warn");
    audio.play("error");
    return;
  }
  if (store.energyNow() + 0.5 < def.cost) {
    store.notifyToast("Не хватает энергии.", "warn");
    audio.play("error");
    return;
  }
  if (store.chaos() + 0.5 < def.minChaos) {
    store.notifyToast(`Нужен хаос ${def.minChaos}%.`, "warn");
    audio.play("error");
    return;
  }

  const point = resolvePoint(x, z);
  const args: CmdArgs = {};

  switch (def.id) {
    case "spawn_enemy": {
      args.kind = store.enemyKind;
      args.x = point.x;
      args.z = point.z;
      args.behind = store.behind;
      args.distance = 6;
      break;
    }
    case "throw_barrel": {
      args.x = point.x;
      args.z = point.z;
      args.fuse = 3;
      break;
    }
    case "telekinesis": {
      args.x = point.x;
      args.z = point.z;
      const enemy = nearestEnemy(point.x, point.z, 2.5);
      if (enemy !== null) args.targetId = enemy;
      break;
    }
    case "poltergeist": {
      args.x = point.x;
      args.z = point.z;
      break;
    }
    case "manifest": {
      break;
    }
    case "whisper": {
      args.text = store.whisper.trim() || WHISPERS[Math.floor(Math.random() * WHISPERS.length)]!;
      break;
    }
  }

  net.sendCmd(def.id, args);
  store.addLog("info", `→ ${def.name}${def.targeting === "point" ? ` (${point.x.toFixed(1)}, ${point.z.toFixed(1)})` : ""}`);
  audio.play(def.id === "spawn_enemy" ? "spawn" : def.id === "throw_barrel" ? "barrel" : def.id === "manifest" ? "manifest" : def.id === "whisper" ? "whisper" : "scare");
}

function resolvePoint(x?: number, z?: number): { x: number; z: number } {
  if (x !== undefined && z !== undefined && Number.isFinite(x) && Number.isFinite(z)) {
    return { x, z };
  }
  if (store.aim.valid) return { x: store.aim.x, z: store.aim.z };
  const player = store.snapshot?.player.pos;
  if (player) return { x: player.x, z: player.z };
  const ghost = store.ghostLocal?.pos ?? store.snapshot?.ghost.pos;
  if (ghost) return { x: ghost.x, z: ghost.z };
  return { x: 0, z: 0 };
}

function nearestEnemy(x: number, z: number, maxDistance: number): number | null {
  const enemies = store.snapshot?.enemies;
  if (!enemies) return null;
  let best: number | null = null;
  let bestDistance = maxDistance;
  for (const enemy of enemies) {
    if (enemy.state === "dead") continue;
    const distance = Math.hypot(enemy.pos.x - x, enemy.pos.z - z);
    if (distance < bestDistance) {
      best = enemy.id;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ghost movement
// ---------------------------------------------------------------------------

const keys = new Set<string>();
let lastMoveAt = performance.now();
let lastCameraAt = 0;

function isTyping(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement
  );
}

window.addEventListener("keydown", (event) => {
  if (isTyping()) {
    if (event.key === "Escape") (document.activeElement as HTMLElement | null)?.blur();
    return;
  }

  const key = event.key;
  const lower = key.toLowerCase();
  keys.add(lower);
  if (key === "Shift") keys.add("shift");

  if (key >= "1" && key <= "6") {
    const def = Object.values(ABILITIES)[Number(key) - 1];
    if (!def) return;
    selectAbility(def.id);
    if (event.shiftKey) cast();
    event.preventDefault();
    return;
  }

  if (key === " " || key === "Enter") {
    cast();
    event.preventDefault();
    return;
  }

  if (key === "Escape") {
    if (ui.isHelpOpen()) {
      ui.showHelp(false);
    } else if (ui.isLobbyOpen()) {
      return;
    } else {
      store.aim = { ...store.aim, valid: false };
      aimReadout.textContent = "X — · Z —";
    }
    return;
  }

  if (lower === "r") {
    renderer.resetView();
    return;
  }

  if (lower === "m") {
    toggleSound();
    return;
  }

  if (key === "?" || lower === "h") {
    ui.showHelp(!ui.isHelpOpen());
    return;
  }

  if (["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(lower)) {
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  const key = event.key;
  keys.delete(key.toLowerCase());
  if (key === "Shift") keys.delete("shift");
});

window.addEventListener("blur", () => keys.clear());

window.setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.12, (now - lastMoveAt) / 1000);
  lastMoveAt = now;

  if (ui.isLobbyOpen() || ui.isHelpOpen() || !store.snapshot) return;
  if (!store.ghostLocal) {
    store.ghostLocal = {
      pos: { ...store.snapshot.ghost.pos },
      yaw: store.snapshot.ghost.yaw,
    };
  }

  const ghost = store.ghostLocal;
  if (!ghost) return;

  const fast = keys.has("shift");
  const speed = fast ? 22 : 9;
  const yaw = ghost.yaw;
  const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };

  let mx = 0;
  let mz = 0;
  if (keys.has("w") || keys.has("arrowup")) {
    mx += forward.x;
    mz += forward.z;
  }
  if (keys.has("s") || keys.has("arrowdown")) {
    mx -= forward.x;
    mz -= forward.z;
  }
  if (keys.has("d") || keys.has("arrowright")) {
    mx += right.x;
    mz += right.z;
  }
  if (keys.has("a") || keys.has("arrowleft")) {
    mx -= right.x;
    mz -= right.z;
  }

  let yawDelta = 0;
  if (keys.has("q")) yawDelta -= 1;
  if (keys.has("e")) yawDelta += 1;
  if (yawDelta !== 0) {
    ghost.yaw = normalizeAngle(ghost.yaw + yawDelta * 1.9 * dt);
  }

  const length = Math.hypot(mx, mz);
  if (length > 0.001) {
    mx /= length;
    mz /= length;
    const bounds = store.map?.bounds;
    const margin = 0.6;
    const minX = (bounds?.minX ?? -30) + margin;
    const maxX = (bounds?.maxX ?? 30) - margin;
    const minZ = (bounds?.minZ ?? -30) + margin;
    const maxZ = (bounds?.maxZ ?? 30) - margin;
    ghost.pos.x = clamp(ghost.pos.x + mx * speed * dt, minX, maxX);
    ghost.pos.z = clamp(ghost.pos.z + mz * speed * dt, minZ, maxZ);
    ghost.pos.y = store.snapshot.player.pos.y;
  }

  if (net.connected && (now - lastCameraAt > 90 || length > 0.001 || yawDelta !== 0)) {
    lastCameraAt = now;
    net.sendCamera(ghost.pos, ghost.yaw);
  }
}, 50);

function normalizeAngle(value: number): number {
  const twoPi = Math.PI * 2;
  return ((value % twoPi) + twoPi) % twoPi;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Sound / events
// ---------------------------------------------------------------------------

function toggleSound(): void {
  store.muted = !store.muted;
  audio.setEnabled(!store.muted);
  ui.setSoundEnabled(!store.muted);
  store.emit();
}

net.onGameEvent = (event: GameEvent) => {
  switch (event.kind) {
    case "enemy_spawned":
      audio.play("spawn");
      break;
    case "barrel_exploded":
      audio.play("barrel");
      break;
    case "player_hit":
    case "player_died":
      audio.play("hit");
      break;
    case "ghost_stunned":
      audio.play("error");
      break;
    case "manifest_start":
      audio.play("manifest");
      break;
    case "manifest_end":
      audio.play("disconnect");
      break;
    case "scare":
      audio.play("scare");
      break;
    default:
      break;
  }
};

net.onPeerEvent = (event) => {
  audio.play(event.event === "joined" ? "connect" : "disconnect");
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const initialRoom = (params.get("room") ?? localStorage.getItem("hm.room") ?? "").toUpperCase();
const initialName = localStorage.getItem("hm.name") ?? "";
ui.setLobbyValues(initialRoom, initialName);
ui.setSoundEnabled(!store.muted);

store.subscribe(() => {
  if (store.status === "online" && ui.isLobbyOpen()) {
    ui.showLobby(false);
    ui.setLobbyBusy(false);
    audio.play("connect");
  }
  if (store.status === "offline" || store.status === "reconnecting") {
    ui.setLobbyBusy(false);
  }
});

if (params.get("auto") === "1" && /^[A-Z0-9]{4,8}$/.test(initialRoom)) {
  window.setTimeout(() => connect(initialRoom, initialName || "Призрак"), 300);
}
