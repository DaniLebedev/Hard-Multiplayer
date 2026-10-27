import * as THREE from "three";
import {
  ABILITIES,
  PREVIEW_ABILITIES,
  type AbilityId,
  type EnemyState,
  type MapData,
  type Vec3,
} from "@hm/protocol";
import type { Store } from "./state";

const FLOOR_MARGIN = 0.45;
const CEILING_ABOVE_FLOOR = 18;
const WALK_SPEED = 7;
const SPRINT_MULTIPLIER = 2;
const VERTICAL_SPEED = 5;
const MOUSE_SENSITIVITY = 0.0022;
const AIM_INTERVAL_MS = 80;

const ENEMY_COLORS: Record<string, number> = {
  grunt: 0xff6b6b,
  runner: 0xfbbf24,
  shooter: 0x60a5fa,
  heavy: 0xa78bfa,
};

export interface AimInfo {
  pos: Vec3;
  groundY: number;
  distance: number;
  valid: boolean;
}

export interface GhostTransform {
  pos: Vec3;
  yaw: number;
  pitch: number;
}

export interface WorldCallbacks {
  onAim: (aim: AimInfo) => void;
  onCast: () => void;
  onLockChange: (locked: boolean) => void;
  canControl: () => boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function colorOf(kind: string): number {
  return ENEMY_COLORS[kind] ?? ENEMY_COLORS.grunt ?? 0xff6b6b;
}

interface EnemyVisual {
  group: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  hpFill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  hpBar: THREE.Group;
}

export class World {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mapGroup = new THREE.Group();
  private readonly entityGroup = new THREE.Group();
  private readonly previewGroup = new THREE.Group();

  private readonly aimTargets: THREE.Object3D[] = [];
  private readonly enemies = new Map<number, EnemyVisual>();
  private readonly props = new Map<number, THREE.Mesh>();
  private playerGroup: THREE.Group | null = null;
  private playerBody: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial> | null = null;

  private mapRef: MapData | null = null;
  private floorY = 0;
  private bounds = { minX: -30, minZ: -30, maxX: 30, maxZ: 30 };

  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private ghostPos = new THREE.Vector3(0, 1.6, 0);
  private yaw = 0;
  private pitch = 0;
  private ghostReady = false;

  private previewAbility: AbilityId | null = null;
  private previewKey = "";

  private aim: AimInfo = { pos: { x: 0, y: 0, z: 0 }, groundY: 0, distance: 0, valid: false };
  private lastAimAt = 0;
  private lastAt = 0;
  private frame = 0;
  private locked = false;
  private disposed = false;

  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly store: Store,
    private readonly callbacks: WorldCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x05070c, 1);
    this.renderer.domElement.id = "view-canvas";
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
    this.camera.rotation.order = "YXZ";

    this.scene.background = new THREE.Color(0x05070c);
    this.scene.fog = new THREE.FogExp2(0x05070c, 0.016);

    const hemi = new THREE.HemisphereLight(0x9fc7ff, 0x0a0f18, 1.1);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xdfefff, 1.2);
    sun.position.set(24, 38, 12);
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x3b82f6, 0.35);
    fill.position.set(-18, 12, -22);
    this.scene.add(fill);

    this.scene.add(this.mapGroup, this.entityGroup, this.previewGroup);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.bindInput();
    this.lastAt = performance.now();
    this.frame = requestAnimationFrame(this.animate);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }

  // -----------------------------------------------------------------------
  // Map
  // -----------------------------------------------------------------------

  setMap(map: MapData): void {
    this.mapRef = map;
    this.floorY = map.floorY ?? 0;
    this.bounds = map.bounds;

    this.clearGroup(this.mapGroup);
    this.aimTargets.length = 0;

    const width = Math.max(1, this.bounds.maxX - this.bounds.minX);
    const depth = Math.max(1, this.bounds.maxZ - this.bounds.minZ);
    const centerX = (this.bounds.minX + this.bounds.maxX) / 2;
    const centerZ = (this.bounds.minZ + this.bounds.maxZ) / 2;

    const floorGeometry = new THREE.PlaneGeometry(width, depth);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a121d,
      roughness: 0.98,
      metalness: 0,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centerX, this.floorY, centerZ);
    floor.name = "floor";
    this.mapGroup.add(floor);
    this.aimTargets.push(floor);

    const gridSize = Math.max(width, depth);
    const grid = new THREE.GridHelper(
      gridSize,
      Math.max(12, Math.round(gridSize / 2)),
      0x1e3a55,
      0x112233,
    );
    grid.position.set(centerX, this.floorY + 0.015, centerZ);
    this.mapGroup.add(grid);

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b2c40,
      roughness: 0.92,
      metalness: 0.04,
    });
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x3b6b91,
      transparent: true,
      opacity: 0.55,
    });

    for (const wall of map.walls) {
      const geometry = new THREE.BoxGeometry(
        Math.max(0.05, wall.w),
        Math.max(0.05, wall.h),
        Math.max(0.05, wall.d),
      );
      const mesh = new THREE.Mesh(geometry, wallMaterial);
      mesh.position.set(wall.x, wall.y, wall.z);
      this.mapGroup.add(mesh);
      this.aimTargets.push(mesh);

      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
      edges.position.copy(mesh.position);
      this.mapGroup.add(edges);
    }

    this.ghostReady = false;
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (Array.isArray(material)) {
          for (const item of material) item.dispose();
        } else if (material) {
          material.dispose();
        }
      });
    }
  }

  // -----------------------------------------------------------------------
  // Ghost transform
  // -----------------------------------------------------------------------

  getTransform(): GhostTransform {
    return {
      pos: { x: this.ghostPos.x, y: this.ghostPos.y, z: this.ghostPos.z },
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  getDebug(): Record<string, unknown> {
    return {
      pos: { x: this.ghostPos.x, y: this.ghostPos.y, z: this.ghostPos.z },
      yaw: this.yaw,
      pitch: this.pitch,
      keys: [...this.keys],
      velocity: { x: this.velocity.x, y: this.velocity.y, z: this.velocity.z },
      ghostReady: this.ghostReady,
      locked: this.locked,
    };
  }

  getAim(): AimInfo {
    return this.aim;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    void this.renderer.domElement.requestPointerLock();
  }

  resetGhost(): void {
    this.ghostReady = false;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
  }

  resetToPlayer(): void {
    const player = this.store.snapshot?.player;
    if (!player) {
      this.ghostPos.set(0, this.floorY + 1.6, 0);
      return;
    }

    const distance = 4;
    this.ghostPos.set(
      player.pos.x - Math.sin(player.yaw) * distance,
      player.pos.y + 1.6,
      player.pos.z - Math.cos(player.yaw) * distance,
    );
    this.yaw = player.yaw;
    this.pitch = -0.1;
    this.clampGhost();
  }

  private ensureGhost(): void {
    if (this.ghostReady) return;

    const snapshot = this.store.snapshot;
    // Prefer the player's current position on a fresh page. snapshot.ghost.pos
    // can be a stale camera from a previous ghost or from before the player
    // appeared, which used to put the new ghost inside the player.
    if (snapshot?.player) {
      const player = snapshot.player;
      this.ghostPos.set(
        player.pos.x - Math.sin(player.yaw) * 4,
        player.pos.y + 1.6,
        player.pos.z - Math.cos(player.yaw) * 4,
      );
      this.yaw = player.yaw;
    } else if (snapshot?.ghost) {
      const pos = snapshot.ghost.pos;
      this.ghostPos.set(pos.x, pos.y, pos.z);
      this.yaw = snapshot.ghost.yaw;
    } else {
      this.ghostPos.set(0, this.floorY + 1.6, 0);
      this.yaw = 0;
    }

    this.pitch = 0;
    this.clampGhost();
    this.ghostReady = true;
  }

  private clampGhost(): void {
    this.ghostPos.x = clamp(this.ghostPos.x, this.bounds.minX + 0.5, this.bounds.maxX - 0.5);
    this.ghostPos.z = clamp(this.ghostPos.z, this.bounds.minZ + 0.5, this.bounds.maxZ - 0.5);
    this.ghostPos.y = clamp(
      this.ghostPos.y,
      this.floorY + FLOOR_MARGIN,
      this.floorY + CEILING_ABOVE_FLOOR,
    );
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.renderer.domElement;

    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    canvas.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (document.pointerLockElement !== canvas) {
        this.requestLock();
        return;
      }
      if (!this.callbacks.canControl()) return;
      this.callbacks.onCast();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      this.callbacks.onLockChange(this.locked);
    });

    document.addEventListener("mousemove", (event) => {
      if (!this.locked) return;
      this.yaw += event.movementX * MOUSE_SENSITIVITY;
      this.pitch = clamp(this.pitch - event.movementY * MOUSE_SENSITIVITY, -1.45, 1.45);
    });

    window.addEventListener("keydown", (event) => {
      if (!this.callbacks.canControl() || isTyping()) return;
      const key = event.key.toLowerCase();
      if (key === " ") event.preventDefault();
      if (MOVEMENT_KEYS.has(key)) this.keys.add(key);
    });

    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.key.toLowerCase());
    });

    window.addEventListener("blur", () => this.keys.clear());
  }

  // -----------------------------------------------------------------------
  // Frame
  // -----------------------------------------------------------------------

  private animate = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);

    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.0001, (now - this.lastAt) / 1000));
    this.lastAt = now;

    this.tick(dt, now);
    this.renderer.render(this.scene, this.camera);
  };

  private tick(dt: number, now: number): void {
    if (this.store.map && this.store.map !== this.mapRef) {
      this.setMap(this.store.map);
    }

    this.ensureGhost();
    this.move(dt);

    this.camera.position.copy(this.ghostPos);
    this.camera.rotation.set(this.pitch, this.yaw + Math.PI, 0, "YXZ");
    this.camera.updateMatrixWorld();

    this.updateEntities(dt);

    if (now - this.lastAimAt > AIM_INTERVAL_MS) {
      this.lastAimAt = now;
      this.aim = this.raycastAim();
      this.callbacks.onAim(this.aim);
    }

    this.updatePreview();
  }

  private move(dt: number): void {
    const active = this.callbacks.canControl() && this.store.status === "online";
    if (!active) {
      this.velocity.set(0, 0, 0);
      return;
    }

    const sprint = this.keys.has("shift");
    const speed = WALK_SPEED * (sprint ? SPRINT_MULTIPLIER : 1);

    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = new THREE.Vector3();
    if (this.keys.has("w") || this.keys.has("arrowup")) wish.add(forward);
    if (this.keys.has("s") || this.keys.has("arrowdown")) wish.sub(forward);
    if (this.keys.has("d") || this.keys.has("arrowright")) wish.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) wish.sub(right);

    if (wish.lengthSq() > 0.001) wish.normalize();

    let vertical = 0;
    if (this.keys.has(" ")) vertical += 1;
    if (this.keys.has("c")) vertical -= 1;

    const target = wish.multiplyScalar(speed);
    target.y = vertical * VERTICAL_SPEED;

    this.velocity.lerp(target, Math.min(1, dt * 12));
    this.ghostPos.addScaledVector(this.velocity, dt);
    this.clampGhost();
  }

  private raycastAim(): AimInfo {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = 120;
    const hits = this.raycaster.intersectObjects(this.aimTargets, false);
    const hit = hits[0];
    if (hit) {
      let groundY = this.floorY;
      this.raycaster.set(
        new THREE.Vector3(hit.point.x, hit.point.y + 30, hit.point.z),
        new THREE.Vector3(0, -1, 0),
      );
      this.raycaster.far = 80;
      const groundHits = this.raycaster.intersectObjects(this.aimTargets, false);
      const groundHit = groundHits[0];
      if (groundHit) groundY = groundHit.point.y + 0.05;

      return {
        pos: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
        groundY,
        distance: hit.distance,
        valid: true,
      };
    }

    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const point = this.camera.position.clone().addScaledVector(direction, 25);
    return {
      pos: { x: point.x, y: point.y, z: point.z },
      groundY: this.floorY,
      distance: 25,
      valid: false,
    };
  }

  // -----------------------------------------------------------------------
  // Entities
  // -----------------------------------------------------------------------

  private updateEntities(dt: number): void {
    const snapshot = this.store.snapshot;
    if (!snapshot) return;

    this.updatePlayer(snapshot.player.pos, snapshot.player.yaw, snapshot.player.alive, dt);
    this.updateEnemies(snapshot.enemies, dt);
    this.updateProps(snapshot.props);
  }

  private updatePlayer(pos: Vec3, yaw: number, alive: boolean, dt: number): void {
    if (!this.playerGroup) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.35, 1.1, 4, 12),
        new THREE.MeshStandardMaterial({ color: 0xa3e635, roughness: 0.6 }),
      );
      body.position.y = 0.9;
      group.add(body);
      this.playerBody = body;

      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, 0.45, 10),
        new THREE.MeshStandardMaterial({ color: 0xd9ff8a, emissive: 0x4d7c0f, emissiveIntensity: 0.6 }),
      );
      nose.position.set(0, 1.15, 0.62);
      nose.rotation.x = Math.PI / 2;
      group.add(nose);

      this.entityGroup.add(group);
      this.playerGroup = group;
    }

    const target = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.playerGroup.position.lerp(target, Math.min(1, dt * 10));
    this.playerGroup.rotation.y = yaw;
    this.playerBody?.material.color.setHex(alive ? 0xa3e635 : 0x64748b);
  }

  private updateEnemies(enemies: EnemyState[], dt: number): void {
    const seen = new Set<number>();

    for (const enemy of enemies) {
      if (enemy.state === "dead") continue;
      seen.add(enemy.id);

      let visual = this.enemies.get(enemy.id);
      if (!visual) {
        visual = this.createEnemyVisual(enemy.kind);
        this.entityGroup.add(visual.group);
        this.enemies.set(enemy.id, visual);
      }

      const target = new THREE.Vector3(enemy.pos.x, enemy.pos.y, enemy.pos.z);
      visual.group.position.lerp(target, Math.min(1, dt * 12));

      const ratio = clamp(enemy.hp / 100, 0, 1);
      visual.hpFill.scale.x = Math.max(0.001, ratio);
      visual.hpFill.position.x = -(1 - ratio) / 2;
      visual.hpFill.material.color.setHex(colorOf(enemy.kind));
      visual.hpBar.quaternion.copy(this.camera.quaternion);
    }

    for (const [id, visual] of this.enemies) {
      if (seen.has(id)) continue;
      this.entityGroup.remove(visual.group);
      this.disposeObject(visual.group);
      this.enemies.delete(id);
    }
  }

  private createEnemyVisual(kind: string): EnemyVisual {
    const group = new THREE.Group();
    const color = colorOf(kind);

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 1.1, 4, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, emissive: color, emissiveIntensity: 0.12 }),
    );
    body.position.y = 0.9;
    group.add(body);

    const hpBar = new THREE.Group();
    hpBar.position.y = 2.05;

    const hpBack = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.12),
      new THREE.MeshBasicMaterial({ color: 0x05070c, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    hpBar.add(hpBack);

    const hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    hpFill.position.z = 0.01;
    hpBar.add(hpFill);

    group.add(hpBar);

    return { group, body, hpFill, hpBar };
  }

  private updateProps(props: { id: number; pos: Vec3 }[]): void {
    const seen = new Set<number>();
    for (const prop of props) {
      seen.add(prop.id);
      let mesh = this.props.get(prop.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.36, 0.36, 0.36),
          new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.8 }),
        );
        this.entityGroup.add(mesh);
        this.props.set(prop.id, mesh);
      }
      mesh.position.set(prop.pos.x, prop.pos.y, prop.pos.z);
    }

    for (const [id, mesh] of this.props) {
      if (seen.has(id)) continue;
      this.entityGroup.remove(mesh);
      this.disposeObject(mesh);
      this.props.delete(id);
    }
  }

  // -----------------------------------------------------------------------
  // Hologram preview
  // -----------------------------------------------------------------------

  private updatePreview(): void {
    const ability = this.store.selected;
    const cooldown = this.store.cooldownRemaining(ability);
    const enabled =
      PREVIEW_ABILITIES.includes(ability) &&
      this.aim.valid &&
      this.store.status === "online" &&
      cooldown <= 0.05;

    if (!enabled) {
      this.previewGroup.visible = false;
      return;
    }

    const key = `${ability}:${this.store.enemyKind}`;
    if (key !== this.previewKey) {
      this.buildPreview(ability, this.store.enemyKind);
      this.previewKey = key;
    }

    this.previewGroup.visible = true;
    this.previewGroup.position.set(this.aim.pos.x, this.aim.groundY, this.aim.pos.z);

    if (ability === "throw_barrel") {
      this.previewGroup.rotation.y = this.yaw;
    } else {
      this.previewGroup.rotation.y = 0;
    }

    const pulse = 1 + Math.sin(performance.now() * 0.005) * 0.03;
    this.previewGroup.scale.setScalar(pulse);
  }

  hidePreview(): void {
    this.previewGroup.visible = false;
  }

  private buildPreview(ability: AbilityId, kind: string): void {
    this.clearGroup(this.previewGroup);
    this.previewAbility = ability;

    const color = previewColor(ability);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const lineMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
    });

    const addRing = (): void => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 40), material);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      this.previewGroup.add(ring);
    };

    const addHologram = (geometry: THREE.BufferGeometry, y: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = y;
      this.previewGroup.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), lineMaterial);
      edges.position.y = y;
      this.previewGroup.add(edges);
      return mesh;
    };

    addRing();

    switch (ability) {
      case "spawn_enemy":
        addHologram(new THREE.CapsuleGeometry(0.35, 1.1, 4, 12), 0.9);
        break;

      case "throw_barrel": {
        addHologram(new THREE.CylinderGeometry(0.35, 0.35, 1.1, 16), 0.55);

        const shaft = new THREE.BoxGeometry(0.09, 0.09, 6);
        const shaftMesh = new THREE.Mesh(shaft, material);
        shaftMesh.position.set(0, 0.7, 3);
        this.previewGroup.add(shaftMesh);
        const shaftEdges = new THREE.LineSegments(new THREE.EdgesGeometry(shaft), lineMaterial);
        shaftEdges.position.copy(shaftMesh.position);
        this.previewGroup.add(shaftEdges);

        for (const side of [-1, 1]) {
          const wingGeometry = new THREE.BoxGeometry(0.08, 0.08, 0.9);
          const wing = new THREE.Mesh(wingGeometry, material);
          wing.position.set(side * 0.22, 0.7, 5.75);
          wing.rotation.y = side * 0.56;
          this.previewGroup.add(wing);
        }
        break;
      }

      case "telekinesis":
      case "poltergeist": {
        const diamond = new THREE.BoxGeometry(0.42, 0.42, 0.42);
        const mesh = addHologram(diamond, 0.9);
        mesh.rotation.set(Math.PI / 4, Math.PI / 4, 0);
        break;
      }

      default:
        break;
    }
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else if (material) {
        material.dispose();
      }
    });
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}

const MOVEMENT_KEYS = new Set(["w", "a", "s", "d", " ", "c", "shift", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function isTyping(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement
  );
}

function previewColor(ability: AbilityId): number {
  switch (ability) {
    case "spawn_enemy":
      return 0xff5d5d;
    case "throw_barrel":
      return 0xffb347;
    case "telekinesis":
      return 0x7dd3fc;
    case "poltergeist":
      return 0xc084fc;
    default:
      return 0x7dd3fc;
  }
}

export function abilityName(id: AbilityId): string {
  return ABILITIES[id].name;
}
