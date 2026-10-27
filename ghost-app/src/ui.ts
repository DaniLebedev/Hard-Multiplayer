import {
  ABILITIES,
  ENEMY_KINDS,
  type AbilityId,
  type EnemyKind,
} from "@hm/protocol";
import type { Store } from "./state";

export interface UIActions {
  cast: () => void;
  select: (id: AbilityId) => void;
  leave: () => void;
  toggleSound: () => void;
  resetView: () => void;
  connect: (room: string, name: string) => void;
  newRoom: () => string;
  setBehind: (value: boolean) => void;
  setEnemyKind: (kind: EnemyKind) => void;
  setWhisper: (value: string) => void;
}

interface AbilityCard {
  button: HTMLButtonElement;
  mask: HTMLElement;
  cooldown: HTMLElement;
}

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatLogTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export class UI {
  private readonly cards = new Map<AbilityId, AbilityCard>();
  private readonly roomCode = $("room-code");
  private readonly statusChip = $("status-chip");
  private readonly statusText = $("status-text");
  private readonly latency = $("latency");
  private readonly sceneName = $("scene-name");
  private readonly noMap = $("no-map");
  private readonly playerHpText = $("player-hp-text");
  private readonly playerHp = $("player-hp");
  private readonly energyText = $("energy-text");
  private readonly energyBar = $("energy-bar");
  private readonly chaosText = $("chaos-text");
  private readonly chaosBar = $("chaos-bar");
  private readonly statSpawns = $("stat-spawns");
  private readonly statBarrels = $("stat-barrels");
  private readonly statScares = $("stat-scares");
  private readonly statKills = $("stat-kills");
  private readonly sessionTime = $("session-time");
  private readonly log = $("log");
  private readonly ghostState = $("ghost-state");
  private readonly castName = $("cast-name");
  private readonly castDesc = $("cast-desc");
  private readonly castButton = $<HTMLButtonElement>("cast-btn");
  private readonly enemyKind = $<HTMLSelectElement>("enemy-kind");
  private readonly behindToggle = $<HTMLInputElement>("behind-toggle");
  private readonly whisperText = $<HTMLInputElement>("whisper-text");
  private readonly lobby = $("lobby");
  private readonly lobbyForm = $<HTMLFormElement>("lobby-form");
  private readonly lobbyName = $<HTMLInputElement>("lobby-name");
  private readonly lobbyRoom = $<HTMLInputElement>("lobby-room");
  private readonly lobbyError = $("lobby-error");
  private readonly lobbyConnect = $<HTMLButtonElement>("lobby-connect");
  private readonly help = $("help");
  private readonly soundButton = $<HTMLButtonElement>("sound-btn");
  private readonly toasts = $("toasts");

  private lastLogId = 0;

  constructor(
    private readonly store: Store,
    private readonly actions: UIActions,
  ) {
    this.buildAbilityCards();
    this.buildEnemyKinds();
    this.bind();
    store.onToast = (text, level) => this.toast(text, level);
    store.subscribe(() => this.update());
    window.setInterval(() => this.updateCooldowns(), 100);
    this.update();
  }

  private buildAbilityCards(): void {
    const list = $("ability-list");
    list.innerHTML = "";
    for (const def of Object.values(ABILITIES)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ability";
      button.dataset.ability = def.id;
      button.style.setProperty("--accent-color", def.color);
      button.title = `${def.name} — ${def.description}`;
      button.innerHTML = `
        <span class="ability-top">
          <span class="hotkey">${escapeHtml(def.hotkey)}</span>
          <span class="cost">${def.cost}</span>
        </span>
        <span class="ability-short">${escapeHtml(def.short)}</span>
        <span class="ability-name">${escapeHtml(def.name)}</span>
        <span class="cooldown-mask"></span>
        <span class="cooldown-text"></span>
      `;
      button.addEventListener("click", () => this.actions.select(def.id));
      list.appendChild(button);

      this.cards.set(def.id, {
        button,
        mask: button.querySelector<HTMLElement>(".cooldown-mask")!,
        cooldown: button.querySelector<HTMLElement>(".cooldown-text")!,
      });
    }
  }

  private buildEnemyKinds(): void {
    this.enemyKind.innerHTML = "";
    for (const kind of ENEMY_KINDS) {
      const option = document.createElement("option");
      option.value = kind.id;
      option.textContent = kind.name;
      option.title = kind.note;
      this.enemyKind.appendChild(option);
    }
  }

  private bind(): void {
    this.castButton.addEventListener("click", () => this.actions.cast());
    $("reset-view").addEventListener("click", () => this.actions.resetView());
    $("leave-btn").addEventListener("click", () => this.actions.leave());
    this.soundButton.addEventListener("click", () => this.actions.toggleSound());
    $("help-btn").addEventListener("click", () => this.showHelp(true));
    $("help-close").addEventListener("click", () => this.showHelp(false));
    this.help.addEventListener("click", (event) => {
      if (event.target === this.help) this.showHelp(false);
    });

    this.enemyKind.addEventListener("change", () => {
      this.actions.setEnemyKind(this.enemyKind.value as EnemyKind);
    });

    this.behindToggle.addEventListener("change", () => {
      this.actions.setBehind(this.behindToggle.checked);
    });

    this.whisperText.addEventListener("input", () => {
      this.actions.setWhisper(this.whisperText.value);
    });

    this.lobbyForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const room = this.lobbyRoom.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(room)) {
        this.setLobbyError("Код комнаты: 4–8 символов, только A–Z и 0–9.");
        this.lobbyRoom.focus();
        return;
      }
      const name = this.lobbyName.value.trim() || "Призрак";
      this.setLobbyError("");
      this.actions.connect(room, name);
    });

    $("new-room").addEventListener("click", () => {
      this.lobbyRoom.value = this.actions.newRoom();
      this.setLobbyError("");
    });

    this.lobbyRoom.addEventListener("input", () => {
      this.lobbyRoom.value = this.lobbyRoom.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
  }

  update(): void {
    const store = this.store;
    const snapshot = store.snapshot;

    this.roomCode.textContent = store.room || "----";
    this.statusChip.dataset.status = store.status;
    this.statusText.textContent = store.statusText;
    this.latency.textContent = store.latency === null ? "—" : `${Math.round(store.latency)} ms`;
    this.sceneName.textContent = store.map?.scene || snapshot?.scene || "—";
    this.noMap.classList.toggle("hidden", Boolean(store.map));

    const hp = snapshot?.player.hp ?? 0;
    const alive = snapshot?.player.alive ?? false;
    this.playerHpText.textContent = snapshot ? `${Math.round(hp)}${alive ? "" : " ✝"}` : "—";
    this.playerHp.style.width = `${Math.min(100, Math.max(0, hp))}%`;

    const energy = store.energyNow();
    const maxEnergy = store.maxEnergy();
    this.energyText.textContent = snapshot ? `${Math.round(energy)} / ${Math.round(maxEnergy)}` : "— / —";
    this.energyBar.style.width = `${maxEnergy > 0 ? Math.min(100, (energy / maxEnergy) * 100) : 0}%`;

    const chaos = Math.min(100, Math.max(0, store.chaos()));
    this.chaosText.textContent = `${Math.round(chaos)}%`;
    this.chaosBar.style.width = `${chaos}%`;

    const stats = snapshot?.stats;
    this.statSpawns.textContent = String(stats?.spawns ?? 0);
    this.statBarrels.textContent = String(stats?.barrels ?? 0);
    this.statScares.textContent = String(stats?.scares ?? 0);
    this.statKills.textContent = String(stats?.kills ?? 0);
    this.sessionTime.textContent = formatClock(store.sessionSeconds());

    const ghost = snapshot?.ghost;
    if (ghost?.stunned) {
      this.ghostState.textContent = "ОГЛУШЁН";
      this.ghostState.className = "ghost-state stunned";
    } else if (ghost?.manifested) {
      this.ghostState.textContent = "В ЯВИ";
      this.ghostState.className = "ghost-state manifested";
    } else {
      this.ghostState.textContent = "СКРЫТ";
      this.ghostState.className = "ghost-state";
    }

    const def = ABILITIES[store.selected];
    this.castName.textContent = def.name;
    const extra =
      def.id === "spawn_enemy" && store.behind
        ? " Точка сместится за спину игрока."
        : def.id === "whisper" && store.whisper
          ? ` Фраза: «${store.whisper}»`
          : "";
    this.castDesc.textContent = def.description + extra;

    if (this.enemyKind.value !== store.enemyKind) this.enemyKind.value = store.enemyKind;
    if (this.behindToggle.checked !== store.behind) this.behindToggle.checked = store.behind;
    if (document.activeElement !== this.whisperText && this.whisperText.value !== store.whisper) {
      this.whisperText.value = store.whisper;
    }

    this.soundButton.classList.toggle("active", !store.muted);
    this.soundButton.textContent = store.muted ? "∅" : "♪";

    this.renderLog();
    this.updateCooldowns();
  }

  private updateCooldowns(): void {
    for (const def of Object.values(ABILITIES)) {
      const card = this.cards.get(def.id);
      if (!card) continue;
      const remaining = this.store.cooldownRemaining(def.id);
      const ratio = Math.min(1, Math.max(0, remaining / Math.max(0.001, def.cooldown)));
      card.mask.style.height = `${(ratio * 100).toFixed(1)}%`;
      card.cooldown.textContent = remaining > 0.15 ? String(Math.ceil(remaining)) : "";
      card.button.classList.toggle("selected", this.store.selected === def.id);
      card.button.classList.toggle("disabled", !this.store.canCast(def.id));
    }
    this.castButton.disabled = !this.store.canCast(this.store.selected);
  }

  private renderLog(): void {
    const latest = this.store.logs[this.store.logs.length - 1];
    if (!latest || latest.id === this.lastLogId) return;
    this.lastLogId = latest.id;

    const nearBottom =
      this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;

    this.log.innerHTML = this.store.logs
      .map(
        (entry) =>
          `<div class="log-entry ${entry.kind}"><time>${formatLogTime(entry.at)}</time><span>${escapeHtml(entry.text)}</span></div>`,
      )
      .join("");

    if (nearBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  toast(text: string, level: "info" | "warn" | "good" = "info"): void {
    const element = document.createElement("div");
    element.className = `toast ${level}`;
    element.textContent = text;
    this.toasts.appendChild(element);
    while (this.toasts.children.length > 4) {
      this.toasts.firstElementChild?.remove();
    }
    window.setTimeout(() => {
      element.classList.add("out");
      window.setTimeout(() => element.remove(), 220);
    }, 3600);
  }

  showLobby(show: boolean): void {
    this.lobby.classList.toggle("hidden", !show);
    if (show) {
      window.setTimeout(() => this.lobbyRoom.focus(), 60);
    }
  }

  setLobbyError(text: string): void {
    this.lobbyError.textContent = text;
  }

  setLobbyBusy(busy: boolean): void {
    this.lobbyConnect.disabled = busy;
    this.lobbyConnect.querySelector("span")!.textContent = busy ? "ПОДКЛЮЧЕНИЕ..." : "ПОДКЛЮЧИТЬСЯ";
  }

  setLobbyValues(room: string, name: string): void {
    this.lobbyRoom.value = room;
    this.lobbyName.value = name;
  }

  showHelp(show: boolean): void {
    this.help.classList.toggle("hidden", !show);
  }

  isHelpOpen(): boolean {
    return !this.help.classList.contains("hidden");
  }

  isLobbyOpen(): boolean {
    return !this.lobby.classList.contains("hidden");
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundButton.classList.toggle("active", enabled);
    this.soundButton.textContent = enabled ? "♪" : "∅";
  }
}
