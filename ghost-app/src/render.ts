import { ABILITIES, type EnemyState, type MapBounds, type MapData, type Vec3 } from "@hm/protocol";
import type { Store } from "./state";

const DEFAULT_BOUNDS: MapBounds = { minX: -30, minZ: -30, maxX: 30, maxZ: 30 };
const PADDING = 28;

interface Point {
  x: number;
  y: number;
}

export interface RendererCallbacks {
  onCast: (x: number, z: number) => void;
  onAim: (x: number, z: number, inside: boolean) => void;
}

const ENEMY_COLORS: Record<string, string> = {
  grunt: "#ff6b6b",
  runner: "#fbbf24",
  shooter: "#60a5fa",
  heavy: "#a78bfa",
  default: "#ff6b6b",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private baseScale = 1;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private hover: { x: number; z: number } | null = null;
  private dragging = false;
  private dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
  private pressStart: Point | null = null;
  private lastBoundsKey = "";
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly callbacks: RendererCallbacks,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;

    this.resize();
    this.bindEvents();
    window.addEventListener("resize", () => this.resize());

    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.draw();
    };
    this.frame = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
  }

  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.fit();
  }

  private bounds(): MapBounds {
    return this.store.map?.bounds ?? DEFAULT_BOUNDS;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fit();
  }

  private fit(): void {
    const bounds = this.bounds();
    const worldW = Math.max(1, bounds.maxX - bounds.minX);
    const worldD = Math.max(1, bounds.maxZ - bounds.minZ);
    this.baseScale = Math.max(
      0.01,
      Math.min((this.width - PADDING * 2) / worldW, (this.height - PADDING * 2) / worldD),
    );
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  private scale(): number {
    return this.baseScale * this.zoom;
  }

  private center(): { x: number; z: number } {
    const b = this.bounds();
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
  }

  private toScreen(x: number, z: number): Point {
    const c = this.center();
    const s = this.scale();
    return {
      x: this.width / 2 + this.panX + (x - c.x) * s,
      y: this.height / 2 + this.panY - (z - c.z) * s,
    };
  }

  private toWorld(sx: number, sy: number): { x: number; z: number } {
    const c = this.center();
    const s = this.scale();
    return {
      x: c.x + (sx - this.width / 2 - this.panX) / s,
      z: c.z - (sy - this.height / 2 - this.panY) / s,
    };
  }

  private bindEvents(): void {
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      if (event.button === 2 || event.button === 1) {
        this.dragging = true;
        this.dragStart = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
        this.canvas.classList.add("dragging");
      } else if (event.button === 0) {
        const rect = this.canvas.getBoundingClientRect();
        this.pressStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }
    });

    this.canvas.addEventListener("pointermove", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;

      if (this.dragging) {
        this.panX = this.dragStart.panX + (event.clientX - this.dragStart.x);
        this.panY = this.dragStart.panY + (event.clientY - this.dragStart.y);
        return;
      }

      const world = this.toWorld(sx, sy);
      this.hover = world;
      this.callbacks.onAim(world.x, world.z, true);
      this.canvas.classList.add("aiming");
    });

    this.canvas.addEventListener("pointerup", (event) => {
      if (this.dragging && (event.button === 2 || event.button === 1)) {
        this.dragging = false;
        this.canvas.classList.remove("dragging");
        return;
      }

      if (event.button !== 0 || !this.pressStart) return;
      const rect = this.canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const moved = Math.hypot(sx - this.pressStart.x, sy - this.pressStart.y);
      this.pressStart = null;
      if (moved > 6) return;

      const world = this.toWorld(sx, sy);
      this.hover = world;
      this.callbacks.onAim(world.x, world.z, true);
      this.callbacks.onCast(world.x, world.z);
    });

    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.callbacks.onAim(0, 0, false);
      this.canvas.classList.remove("aiming");
    });

    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const sx = event.clientX - rect.left;
        const sy = event.clientY - rect.top;
        const before = this.toWorld(sx, sy);
        const factor = Math.exp(-event.deltaY * 0.0015);
        this.zoom = clamp(this.zoom * factor, 0.4, 8);
        const after = this.toWorld(sx, sy);
        const s = this.scale();
        this.panX += (after.x - before.x) * s;
        this.panY -= (after.z - before.z) * s;
      },
      { passive: false },
    );
  }

  draw(): void {
    const ctx = this.ctx;
    const bounds = this.bounds();
    const key = `${bounds.minX},${bounds.minZ},${bounds.maxX},${bounds.maxZ},${this.store.map?.scene ?? ""}`;
    if (key !== this.lastBoundsKey) {
      this.lastBoundsKey = key;
      this.fit();
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const bg = ctx.createRadialGradient(
      this.width * 0.5,
      this.height * 0.45,
      20,
      this.width * 0.5,
      this.height * 0.5,
      Math.max(this.width, this.height) * 0.75,
    );
    bg.addColorStop(0, "#0b1220");
    bg.addColorStop(1, "#05070c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawGrid();
    this.drawMapImage();
    this.drawWalls();
    this.drawBounds();
    this.drawProps();
    this.drawEnemies();
    this.drawPlayer();
    this.drawGhost();
    this.drawAim();
    this.drawScaleBar();
    this.drawCompass();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const s = this.scale();
    let step = 5;
    while (step * s < 26) step *= 2;

    const tl = this.toWorld(0, 0);
    const br = this.toWorld(this.width, this.height);
    const minX = Math.min(tl.x, br.x);
    const maxX = Math.max(tl.x, br.x);
    const minZ = Math.min(tl.z, br.z);
    const maxZ = Math.max(tl.z, br.z);

    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = "500 9px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let count = 0;
    for (let x = Math.floor(minX / step) * step; x <= maxX && count < 300; x += step) {
      const p = this.toScreen(x, 0);
      const major = Math.abs(x % (step * 4)) < 0.001;
      ctx.strokeStyle = major ? "rgba(125,211,252,0.13)" : "rgba(125,211,252,0.055)";
      ctx.beginPath();
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, this.height);
      ctx.stroke();
      count += 1;
    }

    count = 0;
    for (let z = Math.floor(minZ / step) * step; z <= maxZ && count < 300; z += step) {
      const p = this.toScreen(0, z);
      const major = Math.abs(z % (step * 4)) < 0.001;
      ctx.strokeStyle = major ? "rgba(125,211,252,0.13)" : "rgba(125,211,252,0.055)";
      ctx.beginPath();
      ctx.moveTo(0, p.y);
      ctx.lineTo(this.width, p.y);
      ctx.stroke();
      count += 1;
    }

    ctx.fillStyle = "rgba(148,163,184,0.45)";
    for (let x = Math.floor(minX / (step * 4)) * (step * 4); x <= maxX; x += step * 4) {
      const p = this.toScreen(x, maxZ);
      ctx.fillText(`${Math.round(x)}`, p.x, clamp(p.y - 9, 10, this.height - 10));
    }
    for (let z = Math.floor(minZ / (step * 4)) * (step * 4); z <= maxZ; z += step * 4) {
      const p = this.toScreen(minX, z);
      ctx.textAlign = "left";
      ctx.fillText(`${Math.round(z)}`, clamp(p.x + 5, 2, this.width - 30), p.y);
      ctx.textAlign = "center";
    }
    ctx.restore();
  }

  private drawMapImage(): void {
    const image = this.store.mapImage;
    const info = this.store.map?.image;
    if (!image || !info) return;
    const a = this.toScreen(info.minX, info.maxZ);
    const b = this.toScreen(info.maxX, info.minZ);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.drawImage(image, a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(125,211,252,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  private drawWalls(): void {
    const walls = this.store.map?.walls;
    if (!walls || walls.length === 0) return;
    const ctx = this.ctx;
    const s = this.scale();
    const hasImage = Boolean(this.store.mapImage);
    ctx.save();
    ctx.fillStyle = hasImage ? "rgba(15,23,42,0.28)" : "rgba(56,78,104,0.5)";
    ctx.strokeStyle = hasImage ? "rgba(148,163,184,0.18)" : "rgba(148,163,184,0.45)";
    ctx.lineWidth = 1;
    for (const wall of walls) {
      const p = this.toScreen(wall.x, wall.z);
      const w = Math.max(1, wall.w * s);
      const d = Math.max(1, wall.d * s);
      const x = p.x - w / 2;
      const y = p.y - d / 2;
      ctx.fillRect(x, y, w, d);
      if (w > 3 && d > 3) ctx.strokeRect(x + 0.5, y + 0.5, w - 1, d - 1);
    }
    ctx.restore();
  }

  private drawBounds(): void {
    const b = this.bounds();
    const tl = this.toScreen(b.minX, b.maxZ);
    const br = this.toScreen(b.maxX, b.minZ);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(125,211,252,0.35)";
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.restore();
  }

  private drawProps(): void {
    const props = this.store.snapshot?.props;
    if (!props || props.length === 0) return;
    const ctx = this.ctx;
    const s = this.scale();
    ctx.save();
    ctx.fillStyle = "rgba(100,116,139,0.65)";
    for (const prop of props) {
      const p = this.toScreen(prop.pos.x, prop.pos.z);
      const size = clamp(0.22 * s, 1.5, 5);
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.restore();
  }

  private drawEnemies(): void {
    const enemies = this.store.snapshot?.enemies;
    if (!enemies || enemies.length === 0) return;
    const ctx = this.ctx;
    const s = this.scale();
    ctx.save();
    for (const enemy of enemies) {
      this.drawEnemy(enemy, s);
    }
    ctx.restore();
  }

  private drawEnemy(enemy: EnemyState, scale: number): void {
    const ctx = this.ctx;
    const p = this.toScreen(enemy.pos.x, enemy.pos.z);
    const color = ENEMY_COLORS[enemy.kind] ?? ENEMY_COLORS.default!;
    const radius = clamp(0.42 * scale, 3, 11);

    if (enemy.state === "dead") {
      ctx.strokeStyle = "rgba(148,163,184,0.5)";
      ctx.lineWidth = 1.5;
      const r = radius * 0.8;
      ctx.beginPath();
      ctx.moveTo(p.x - r, p.y - r);
      ctx.lineTo(p.x + r, p.y + r);
      ctx.moveTo(p.x + r, p.y - r);
      ctx.lineTo(p.x - r, p.y + r);
      ctx.stroke();
      return;
    }

    if (enemy.ghost) {
      ctx.strokeStyle = "rgba(244,114,182,0.75)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(5,7,12,0.8)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1, radius * 0.35), 0, Math.PI * 2);
    ctx.fill();

    if (enemy.hp > 0) {
      const width = Math.max(10, radius * 3.2);
      const hp = clamp(enemy.hp / 100, 0, 1);
      ctx.fillStyle = "rgba(5,7,12,0.85)";
      ctx.fillRect(p.x - width / 2, p.y - radius - 7, width, 3);
      ctx.fillStyle = color;
      ctx.fillRect(p.x - width / 2, p.y - radius - 7, width * hp, 3);
    }
  }

  private drawPlayer(): void {
    const player = this.store.snapshot?.player;
    if (!player) return;
    const ctx = this.ctx;
    const p = this.toScreen(player.pos.x, player.pos.z);
    const s = this.scale();
    const yaw = player.yaw;
    const radius = clamp(0.7 * s, 5, 16);

    const dir = (angle: number): Point => ({ x: Math.sin(angle), y: -Math.cos(angle) });
    const left = dir(yaw - 0.55);
    const right = dir(yaw + 0.55);
    const forward = dir(yaw);

    const cone = clamp(15 * s, 30, 260);
    const gradient = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, cone);
    gradient.addColorStop(0, "rgba(163,230,53,0.20)");
    gradient.addColorStop(1, "rgba(163,230,53,0)");
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + left.x * cone, p.y + left.y * cone);
    ctx.lineTo(p.x + right.x * cone, p.y + right.y * cone);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = player.alive ? "#a3e635" : "#64748b";
    ctx.strokeStyle = "rgba(5,7,12,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x + forward.x * radius, p.y + forward.y * radius);
    ctx.lineTo(p.x + left.x * radius * 0.7, p.y + left.y * radius * 0.7);
    ctx.lineTo(p.x - forward.x * radius * 0.6, p.y - forward.y * radius * 0.6);
    ctx.lineTo(p.x + right.x * radius * 0.7, p.y + right.y * radius * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(163,230,53,0.95)";
    ctx.font = "700 10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText("ИГРОК", p.x, p.y + radius + 14);
    ctx.restore();
  }

  private drawGhost(): void {
    const ghost = this.store.ghostLocal ?? this.store.snapshot?.ghost;
    if (!ghost) return;
    const ctx = this.ctx;
    const p = this.toScreen(ghost.pos.x, ghost.pos.z);
    const s = this.scale();
    const manifested = this.store.snapshot?.ghost.manifested ?? false;
    const stunned = this.store.snapshot?.ghost.stunned ?? false;
    const radius = clamp(0.55 * s, 5, 14);

    ctx.save();
    if (manifested) {
      const glow = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, radius * 3.2);
      glow.addColorStop(0, "rgba(244,114,182,0.45)");
      glow.addColorStop(1, "rgba(244,114,182,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = stunned ? "rgba(148,163,184,0.8)" : manifested ? "#f472b6" : "#7dd3fc";
    ctx.fillStyle = stunned ? "rgba(100,116,139,0.9)" : manifested ? "#f472b6" : "#0ea5e9";
    ctx.lineWidth = 2;
    ctx.setLineDash(stunned ? [2, 4] : [5, 4]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(p.x, p.y - radius);
    ctx.lineTo(p.x + radius, p.y);
    ctx.lineTo(p.x, p.y + radius);
    ctx.lineTo(p.x - radius, p.y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#e2f6ff";
    ctx.font = "700 10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText(stunned ? "ОГЛУШЁН" : manifested ? "ЯВЬ" : "ПРИЗРАК", p.x, p.y - radius - 10);
    ctx.restore();
  }

  private drawAim(): void {
    const aim = this.hover ?? (this.store.aim.valid ? { x: this.store.aim.x, z: this.store.aim.z } : null);
    if (!aim) return;
    const ctx = this.ctx;
    const p = this.toScreen(aim.x, aim.z);
    const def = ABILITIES[this.store.selected];

    const ghost = this.store.ghostLocal ?? this.store.snapshot?.ghost;
    if (ghost) {
      const g = this.toScreen(ghost.pos.x, ghost.pos.z);
      ctx.save();
      ctx.strokeStyle = "rgba(125,211,252,0.28)";
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = def.color;
    ctx.fillStyle = def.color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x - 16, p.y);
    ctx.lineTo(p.x - 5, p.y);
    ctx.moveTo(p.x + 5, p.y);
    ctx.lineTo(p.x + 16, p.y);
    ctx.moveTo(p.x, p.y - 16);
    ctx.lineTo(p.x, p.y - 5);
    ctx.moveTo(p.x, p.y + 5);
    ctx.lineTo(p.x, p.y + 16);
    ctx.stroke();
    ctx.restore();

    if (this.store.behind && this.store.selected === "spawn_enemy") {
      const player = this.store.snapshot?.player;
      if (player) {
        const yaw = player.yaw;
        const bx = player.pos.x - Math.sin(yaw) * 6;
        const bz = player.pos.z - Math.cos(yaw) * 6;
        const b = this.toScreen(bx, bz);
        ctx.save();
        ctx.strokeStyle = "rgba(255,93,93,0.7)";
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(b.x, b.y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255,93,93,0.9)";
        ctx.font = "600 9px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("ЗА СПИНОЙ", b.x, b.y - 16);
        ctx.restore();
      }
    }
  }

  private drawScaleBar(): void {
    const ctx = this.ctx;
    const s = this.scale();
    let meters = 5;
    while (meters * s < 55) meters *= 2;
    const px = meters * s;
    const x = 20;
    const y = this.height - 22;

    ctx.save();
    ctx.strokeStyle = "rgba(148,163,184,0.7)";
    ctx.fillStyle = "rgba(148,163,184,0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + px, y - 4);
    ctx.lineTo(x + px, y + 4);
    ctx.stroke();
    ctx.font = "500 10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${meters} м`, x, y - 9);
    ctx.restore();
  }

  private drawCompass(): void {
    const ctx = this.ctx;
    const x = this.width - 28;
    const y = 28;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(148,163,184,0.75)";
    ctx.strokeStyle = "rgba(148,163,184,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(4, 4);
    ctx.lineTo(0, 1);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.font = "700 8px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("N", 0, -18);
    ctx.restore();
  }
}

export function playerWorldPosition(store: Store): Vec3 | null {
  return store.snapshot?.player.pos ?? null;
}
