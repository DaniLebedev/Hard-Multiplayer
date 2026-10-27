import {
  ABILITIES,
  type AbilityId,
  type EnemyKind,
  type MapData,
  type PeerInfo,
  type Snapshot,
  type Toast,
  type Vec3,
} from "@hm/protocol";

export type ConnectionStatus = "offline" | "connecting" | "online" | "reconnecting";

export type LogKind = "info" | "good" | "warn" | "bad";

export interface LogEntry {
  id: number;
  at: number;
  text: string;
  kind: LogKind;
}

export interface PendingCast {
  ability: AbilityId;
  energyBefore: number;
  at: number;
}

export interface ToastMessage {
  id: number;
  text: string;
  level: "info" | "warn" | "good";
}

export interface AimState {
  x: number;
  y: number;
  z: number;
  groundY: number;
  distance: number;
  valid: boolean;
}

let nextId = 1;

export class Store {
  room = "";
  playerName = "";
  peerId: string | null = null;
  peers: PeerInfo[] = [];

  status: ConnectionStatus = "offline";
  statusText = "ОФЛАЙН";
  latency: number | null = null;

  snapshot: Snapshot | null = null;
  snapshotAt = 0;
  map: MapData | null = null;
  mapImage: HTMLImageElement | null = null;

  logs: LogEntry[] = [];
  toasts: ToastMessage[] = [];

  selected: AbilityId = "spawn_enemy";
  aim: AimState = { x: 0, y: 0, z: 0, groundY: 0, distance: 0, valid: false };
  enemyKind: EnemyKind = "grunt";
  muted = false;
  locked = false;

  /** Locally predicted ghost transform, so the marker does not lag by 100 ms. */
  ghostLocal: { pos: Vec3; yaw: number; pitch: number } | null = null;

  localEnergy = 100;
  localCooldowns = new Map<AbilityId, number>();
  pending = new Map<string, PendingCast>();

  onToast: ((text: string, level: "info" | "warn" | "good") => void) | null = null;

  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  setStatus(status: ConnectionStatus, text?: string): void {
    this.status = status;
    this.statusText =
      text ??
      ({
        offline: "ОФЛАЙН",
        connecting: "ПОДКЛЮЧЕНИЕ",
        online: "В СЕТИ",
        reconnecting: "ПЕРЕПОДКЛЮЧЕНИЕ",
      } as const)[status];
    this.emit();
  }

  setSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.snapshotAt = performance.now();

    if (!this.ghostLocal && snapshot.ghost) {
      this.ghostLocal = {
        pos: { ...snapshot.ghost.pos },
        yaw: snapshot.ghost.yaw,
        pitch: 0,
      };
    }

    if (this.pending.size === 0) {
      this.localEnergy = snapshot.energy;
    }

    this.emit();
  }

  setMap(map: MapData): void {
    this.map = map;
    this.mapImage = null;
    if (map.image?.data) {
      const image = new Image();
      image.onload = () => {
        if (this.map === map) {
          this.mapImage = image;
          this.emit();
        }
      };
      image.onerror = () => {
        if (this.map === map) {
          this.mapImage = null;
          this.emit();
        }
      };
      image.src = `data:${map.image.mime};base64,${map.image.data}`;
    }
    this.emit();
  }

  addLog(kind: LogKind, text: string): void {
    this.logs.push({ id: nextId++, at: Date.now(), text, kind });
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
    this.emit();
  }

  notifyToast(text: string, level: "info" | "warn" | "good" = "info"): void {
    const toast: ToastMessage = { id: nextId++, text, level };
    this.toasts.push(toast);
    if (this.toasts.length > 4) this.toasts.shift();
    this.onToast?.(text, level);
    this.emit();
  }

  notifyFromServer(toast: Toast): void {
    this.notifyToast(toast.text, toast.level ?? "info");
  }

  select(ability: AbilityId): void {
    this.selected = ability;
    this.emit();
  }

  energyNow(): number {
    const base = this.snapshot?.energy ?? 0;
    return Math.max(0, Math.min(base, this.localEnergy));
  }

  maxEnergy(): number {
    return this.snapshot?.maxEnergy ?? 100;
  }

  cooldownRemaining(ability: AbilityId): number {
    const server = this.snapshot?.cooldowns?.[ability] ?? 0;
    const localUntil = this.localCooldowns.get(ability) ?? 0;
    const local = Math.max(0, localUntil - performance.now()) / 1000;
    return Math.max(server, local);
  }

  canCast(ability: AbilityId): boolean {
    const def = ABILITIES[ability];
    if (this.cooldownRemaining(ability) > 0.05) return false;
    if (this.energyNow() + 0.5 < def.cost) return false;
    return true;
  }

  markPending(id: string, ability: AbilityId): void {
    const def = ABILITIES[ability];
    const energyBefore = this.energyNow();
    this.pending.set(id, { ability, energyBefore, at: performance.now() });
    this.localEnergy = Math.max(0, energyBefore - def.cost);
    this.localCooldowns.set(ability, performance.now() + def.cooldown * 1000);
    this.emit();
  }

  resolvePending(id: string, ok: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (!ok) {
      this.localEnergy = Math.max(this.localEnergy, pending.energyBefore);
      this.localCooldowns.delete(pending.ability);
    }
    this.emit();
  }

  clearStalePending(maxAgeMs = 4000): void {
    const now = performance.now();
    for (const [id, pending] of this.pending) {
      if (now - pending.at > maxAgeMs) {
        this.pending.delete(id);
        this.localCooldowns.delete(pending.ability);
      }
    }
  }

  sessionSeconds(): number {
    return this.snapshot?.stats?.sessionTime ?? 0;
  }
}
