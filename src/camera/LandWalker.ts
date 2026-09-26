import * as THREE from 'three';
import type { Input } from '../core/Input';
import { terrainHeight } from '../world/WorldGen';
import { trunksNear } from '../world/vegetationPlacement';

/*
 * First-person view ashore: the sailor on the island, in the world's frame, on the terrain. Walks up what a
 * man walks up (not cliffs), round the palm and tree trunks, into the sea no deeper than the waist — like
 * most sailors of the age, he can't swim, so there he stops and turns back. Wading is slow and sloshes.
 * Look, walk, run, jump and the head's bob as on deck (DeckWalker), with none of the hull's motion.
 */

const EYE = 1.62;
const GRAVITY = 9.81;
const JUMP = 3.4;
const RADIUS = 0.3;
const WALK = 1.5, RUN = 3.0;
/** steepest ground one walks up: rise per metre (~40°) */
const CLIMB = 0.85;
/** deepest water one wades into (m) */
export const WADE = 1.1;

export type Ground = 'sand' | 'grass' | 'water' | 'wood';

export class LandWalker {
  /** position, world x / z */
  readonly pos = new THREE.Vector2();
  footY = 0;
  /** look direction: yaw 0 = +z, + turns toward +x; pitch up + */
  yaw = 0;
  pitch = 0;
  stride = 0;
  pace = 0;
  /** water over the feet (m) */
  wade = 0;
  /** the spyglass and its hands (set each frame, as on deck) */
  scope = 0;
  magnification = 1;
  tremor = { yaw: 0, pitch: 0 };
  /** the head swimming (rum): offsets to the look, and a roll (rad), set each frame */
  sway = { yaw: 0, pitch: 0, roll: 0 };
  onStep: ((pace: number, ground: Ground, wade: number) => void) | null = null;
  onLand: ((height: number) => void) | null = null;
  onJump: (() => void) | null = null;
  /** other things in the way (the boat drawn up on the beach): [x, z, r] */
  obstacles: [number, number, number][] = [];
  /** more that stops him (the Skull Island's rock, its guards) */
  blocked: ((x: number, z: number) => boolean) | null = null;
  /** walked into water deeper than he dares */
  onDeep: (() => void) | null = null;
  /** boards underfoot (Tortuga's piers): their height at (x, z), or null where there are none */
  floorAt: ((x: number, z: number) => number | null) | null = null;

  private readonly vel = new THREE.Vector2();
  private vy = 0;
  private airborne = false;
  private peak = 0;
  private bob = 0;
  private lastStep = 0;
  private trunks: [number, number, number][] = [];
  private readonly trunksAt = new THREE.Vector2(Infinity, Infinity);
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  /** stand at (x, z) facing `yaw` */
  place(x: number, z: number, yaw: number): void {
    this.pos.set(x, z);
    this.footY = this.floor(x, z);
    this.yaw = yaw;
    this.pitch = -0.05;
    this.vel.set(0, 0);
    this.airborne = false;
    this.trunksAt.set(Infinity, Infinity);
  }

  /** the height of what he stands on at (x, z): boards, or the ground */
  private floor(x: number, z: number): number {
    return this.floorAt?.(x, z) ?? terrainHeight(x, z);
  }

  /** what is underfoot here */
  ground(): Ground {
    if (this.floorAt?.(this.pos.x, this.pos.y) != null) return 'wood';
    if (this.wade > 0.12) return 'water';
    return terrainHeight(this.pos.x, this.pos.y) < 2.2 ? 'sand' : 'grass';
  }

  /** can he step to (x, z) from where he is? */
  private canMove(x: number, z: number): boolean {
    // (what stands in the way first: off the edge of a pier is simply no further, not "too deep to wade")
    if (this.blocked?.(x, z)) return false;
    const g = this.floor(x, z);
    if (g < -WADE) { this.onDeep?.(); return false; }
    const here = this.floor(this.pos.x, this.pos.y), run = Math.hypot(x - this.pos.x, z - this.pos.y);
    // uphill only where it isn't too steep (down, anything); boards: a step up, as onto a pier or a stair
    const step = this.floorAt?.(x, z) != null ? 0.3 : 0;
    return g - here <= Math.max(CLIMB * run, step) + 1e-4;
  }

  update(dt: number, input: Input, camera: THREE.PerspectiveCamera): void {
    // ---- look ----
    const k = (input.locked ? 0.0022 : 0.005) / this.magnification;
    this.yaw -= (input.lookDX + (input.locked ? 0 : input.dragDX)) * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch - (input.lookDY + (input.locked ? 0 : input.dragDY)) * k, -1.35, 1.35);

    // ---- walk ----
    const fwd = input.axis('KeyS', 'KeyW'), side = input.axis('KeyD', 'KeyA');
    const run = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const want = new THREE.Vector2(side, fwd);
    if (want.lengthSq() > 1) want.normalize();
    // the glass at the eye: a shuffle; the sea at the knees and more: a slog
    const sp = (run ? RUN : WALK) * (1 - 0.7 * this.scope) * (1 - 0.6 * Math.min(1, this.wade / WADE));
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const tx = (want.x * c + want.y * s) * sp, tz = (-want.x * s + want.y * c) * sp;
    this.vel.lerp(new THREE.Vector2(tx, tz), 1 - Math.exp(-dt * 10));
    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.y + this.vel.y * dt;
    // move, sliding along what stops him one axis at a time
    if (this.canMove(nx, nz)) this.pos.set(nx, nz);
    else if (this.canMove(nx, this.pos.y)) { this.pos.x = nx; this.vel.y = 0; }
    else if (this.canMove(this.pos.x, nz)) { this.pos.y = nz; this.vel.x = 0; }
    else this.vel.set(0, 0);
    // trunks push him out round them (so he slides past)
    if (this.trunksAt.distanceTo(this.pos) > 4) { this.trunksAt.copy(this.pos); this.trunks = trunksNear(this.pos.x, this.pos.y, 9); }
    for (const [x, z, r] of [...this.trunks, ...this.obstacles]) {
      const dx = this.pos.x - x, dz = this.pos.y - z, d = Math.hypot(dx, dz), min = r + RADIUS;
      if (d < min && d > 1e-4) this.pos.set(x + (dx / d) * min, z + (dz / d) * min);
    }

    // ---- feet on the ground ----
    const floor = this.floor(this.pos.x, this.pos.y);
    this.wade = Math.max(0, -floor);
    if (!this.airborne && input.wasPressed('Space') && this.wade < 0.6) {
      this.airborne = true;
      this.vy = JUMP;
      this.peak = this.footY;
      this.onJump?.();
    } else if (!this.airborne && floor < this.footY - 0.5) {
      this.airborne = true;
      this.vy = 0;
      this.peak = this.footY;
    }
    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      this.footY += this.vy * dt;
      this.peak = Math.max(this.peak, this.footY);
      if (this.footY <= floor) {
        this.footY = floor;
        this.airborne = false;
        this.onLand?.(this.peak - floor);
        this.lastStep = this.stride;
      }
    } else this.footY += (floor - this.footY) * (1 - Math.exp(-dt * 18));

    // ---- gait: head bob and footfalls ----
    const moving = this.vel.length();
    this.pace = THREE.MathUtils.clamp((moving - 0.2) / (RUN - 0.2), 0, 1);
    this.stride += moving * dt;
    const stepLen = 0.7 + 0.25 * this.pace;
    if (moving > 0.25 && !this.airborne && this.stride - this.lastStep > stepLen) {
      this.lastStep = this.stride;
      this.onStep?.(this.pace, this.ground(), this.wade);
    }
    if (moving < 0.25) this.lastStep = this.stride - stepLen * 0.5;
    this.bob += ((moving > 0.25 && !this.airborne ? 1 : 0) - this.bob) * (1 - Math.exp(-dt * 6));
    const ph = (this.stride / stepLen) * Math.PI;
    const bobY = this.bob * (0.035 + 0.03 * this.pace) * Math.abs(Math.sin(ph));
    const bobX = this.bob * 0.02 * Math.sin(ph);

    // ---- the eye ----
    camera.position.set(this.pos.x + bobX * c, this.footY + EYE - bobY, this.pos.y - bobX * s);
    // camera looks down −z: turn it to face +z at yaw 0
    this.euler.set(this.pitch + this.tremor.pitch + this.sway.pitch, this.yaw + this.tremor.yaw + this.sway.yaw + Math.PI, this.sway.roll, 'YXZ');
    camera.quaternion.setFromEuler(this.euler);
    camera.updateMatrixWorld();
  }
}
