import "./styles.css";
import {
  ABILITIES,
  PREVIEW_ABILITIES,
  roomCode,
  type AbilityId,
  type CmdArgs,
  type GameEvent,
  type Vec3,
} from "@hm/protocol";
import { AudioEngine } from "./audio";
import { Net } from "./net";
import { Store } from "./state";
import { UI } from "./ui";
import { World } from "./world";

const store = new Store();
const audio = new AudioEngine();
const net = new Net(store);

const viewContainer = document.getElementById("view")!;
const aimReadout = document.getElementById("aim-readout")!;
const lockHint = document.getElementById("lock-hint")!;

const world = new World(viewContainer, store, {
  onAim: (aim) => {
    store.aim = {
      x: aim.pos.x,
      y: aim.pos.y,
      z: aim.pos.z,
      groundY: aim.groundY,
      distance: aim.distance,
      valid: aim.valid,
    };
    aimReadout.textContent = aim.valid
      ? `${aim.distance.toFixed(1)} м · X ${aim.pos.x.toFixed(1)} · Y ${aim.pos.y.toFixed(1)} · Z ${aim.pos.z.toFixed(1)}`
      : "нет поверхности";
  },
  onCast: () => cast(),
  onLockChange: (locked) => {
    store.locked = locked;
    lockHint.classList.toggle("hidden", locked);
    store.emit();
  },
  canControl: () => !ui.isLobbyOpen() && !ui.isHelpOpen(),
});

const ui = new UI(store, {
  cast: () => cast(),
  select: (id) => selectAbility(id),
  leave: () => leave(),
  toggleSound: () => toggleSound(),
  recenter: () => {
    world.resetToPlayer();
    store.notifyToast("Призрак вернулся к игроку.", "info");
  },
  connect: (room, name) => connect(room, name),
  newRoom: () => roomCode(),
  setEnemyKind: (kind) => {
    store.enemyKind = kind;
    store.emit();
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
  world.resetGhost();
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

function cast(): void {
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

  const aim = world.getAim();
  const transform = world.getTransform();
  const args: CmdArgs = {};

  if (def.targeting === "point" || def.targeting === "entity") {
    if (!aim.valid) {
      store.notifyToast("Наведись на пол или стену.", "warn");
      audio.play("error");
      return;
    }
    args.x = aim.pos.x;
    args.y = aim.pos.y;
    args.z = aim.pos.z;
  }

  switch (def.id) {
    case "spawn_enemy": {
      args.kind = store.enemyKind;
      break;
    }
    case "throw_barrel": {
      args.dirX = Math.sin(transform.yaw);
      args.dirZ = Math.cos(transform.yaw);
      args.power = 14;
      args.fuse = 3;
      break;
    }
    case "telekinesis": {
      const enemy = nearestEnemy(aim.pos, 3.5);
      if (enemy !== null) args.targetId = enemy;
      break;
    }
    case "poltergeist": {
      break;
    }
    case "manifest": {
      args.duration = 6;
      break;
    }
  }

  net.sendCmd(def.id, args);
  sendPreview(false);
  world.hidePreview();

  const where = def.targeting === "point" || def.targeting === "entity"
    ? ` (${aim.pos.x.toFixed(1)}, ${aim.pos.y.toFixed(1)}, ${aim.pos.z.toFixed(1)})`
    : "";
  store.addLog("info", `→ ${def.name}${where}`);
  audio.play(
    def.id === "spawn_enemy"
      ? "spawn"
      : def.id === "throw_barrel"
        ? "barrel"
        : def.id === "manifest"
          ? "manifest"
          : "scare",
  );
}

function nearestEnemy(point: Vec3, maxDistance: number): number | null {
  const enemies = store.snapshot?.enemies;
  if (!enemies) return null;

  let best: number | null = null;
  let bestDistance = maxDistance;
  for (const enemy of enemies) {
    if (enemy.state === "dead") continue;
    const distance = Math.hypot(
      enemy.pos.x - point.x,
      enemy.pos.y - point.y,
      enemy.pos.z - point.z,
    );
    if (distance < bestDistance) {
      best = enemy.id;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Preview / camera uplink
// ---------------------------------------------------------------------------

let previewActive = false;
let lastPreviewAt = 0;
let lastCameraAt = 0;

function sendPreview(active: boolean): void {
  if (!active) {
    if (!previewActive) return;
    previewActive = false;
    net.sendPreview(false, null, { x: 0, y: 0, z: 0 });
    return;
  }

  const ability = store.selected;
  const aim = world.getAim();
  if (!net.connected || !PREVIEW_ABILITIES.includes(ability) || !aim.valid) {
    if (previewActive) sendPreview(false);
    return;
  }
  if (store.cooldownRemaining(ability) > 0.05) {
    if (previewActive) sendPreview(false);
    return;
  }

  const transform = world.getTransform();
  const dir =
    ability === "throw_barrel"
      ? { x: Math.sin(transform.yaw), y: 0, z: Math.cos(transform.yaw) }
      : undefined;

  previewActive = true;
  net.sendPreview(true, ability, aim.pos, dir, store.enemyKind);
}

window.setInterval(() => {
  const now = performance.now();

  if (net.connected) {
    if (now - lastCameraAt > 90) {
      lastCameraAt = now;
      const transform = world.getTransform();
      net.sendCamera(transform.pos, transform.yaw, transform.pitch);
    }

    if (now - lastPreviewAt > 100) {
      lastPreviewAt = now;
      const ability = store.selected;
      const aim = world.getAim();
      const shouldPreview =
        PREVIEW_ABILITIES.includes(ability) &&
        aim.valid &&
        store.cooldownRemaining(ability) <= 0.05;
      sendPreview(shouldPreview);
    }
  } else if (previewActive) {
    sendPreview(false);
  }

  store.clearStalePending();
}, 50);

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

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

  if (key >= "1" && key <= "5") {
    const def = Object.values(ABILITIES)[Number(key) - 1];
    if (!def) return;
    selectAbility(def.id);
    event.preventDefault();
    return;
  }

  if (lower === "r") {
    world.resetToPlayer();
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

  if (key === "Escape") {
    if (ui.isHelpOpen()) ui.showHelp(false);
    return;
  }
});

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

if (params.has("debug")) {
  (window as unknown as { __hm?: unknown }).__hm = { store, world, net };
}

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
