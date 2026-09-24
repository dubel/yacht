import * as THREE from 'three';
import type { Input } from '../core/Input';
import { OFF, type DeckMap } from '../boat/DeckMap';

/*
 * First-person view from the deck. The sailor lives in the boat's frame (x starboard…port, z stern→bow,
 * y up), walks on the DeckMap floor — steps up to STEP, drops down edges, never through walls, masts or
 * over the side (the hull edge is a wall at any height, so even a jump can't clear it) — and is carried by
 * the hull: heel, pitch and heave move the eye as they would. Space jumps; drops off edges are ballistic
 * and land with a thud. The inner
 * ear compensates part of the roll, so the view keeps only some of the boat's tilt (LEVEL), which reads as
 * being at sea without being sickening. Mouse looks (pointer lock, or drag without it), WASD walks,
 * Shift runs.
 */

const EYE = 1.62;
const STEP = 0.4;
const DROP = 0.9;
const GRAVITY = 9.81;
/** take-off speed: a ~0.6 m hop, enough to get onto a hatch cover */
const JUMP = 3.4;
const RADIUS = 0.28;
const WALK = 1.5, RUN = 3.0;
/** share of the boat's roll/pitch the view keeps (the rest the sailor's balance cancels) */
const LEVEL = 0.55;

export class DeckWalker {
  /** position on the deck, boat frame */
  readonly pos = new THREE.Vector2();
  footY = 0;
  /** look direction relative to the bow (yaw 0 = forward, + = to port) */
  yaw = 0;
  pitch = 0;
  /** distance walked (m), for footsteps */
  stride = 0;
  /** 0 standing … 1 running */
  pace = 0;
  onStep: ((pace: number) => void) | null = null;
  /** landed after dropping `height` m (off the raised deck, a hatch…) */
  onLand: ((height: number) => void) | null = null;
  /** vertical speed while airborne (boat frame) */
  private vy = 0;
  private airborne = false;
  private peak = 0;
  onJump: (() => void) | null = null;
  /** the spyglass: 0 lowered … 1 at the eye, its magnification and the hands' wander (set each frame) */
  scope = 0;
  magnification = 1;
  tremor = { yaw: 0, pitch: 0 };

  private readonly vel = new THREE.Vector2();
  private bob = 0;
  private lastStep = 0;
  private readonly eye = new THREE.Vector3();
  private readonly qLevel = new THREE.Quaternion();
  private readonly qLook = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly deck: DeckMap) {}

  /** put the sailor at the helm (aft, on the centreline), looking forward */
  spawn(stern: number): void {
    // nearest standable spot to a point a few metres in from the stern
    for (let r = 0; r < 6; r += 0.1)
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        const x = Math.cos(a) * r, z = stern + 3.2 + Math.sin(a) * r;
        const f = this.deck.at(x, z);
        if (f > OFF + 1 && this.free(x, z, f)) { this.pos.set(x, z); this.footY = f; this.yaw = 0; this.pitch = -0.05; this.vel.set(0, 0); return; }
      }
  }

  /** can a body of RADIUS stand at (x, z) with its feet at about `foot`? */
  private free(x: number, z: number, foot: number): boolean {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const f = this.deck.at(x + Math.cos(a) * RADIUS, z + Math.sin(a) * RADIUS);
      if (f === OFF || f > foot + STEP) return false;
    }
    return true;
  }

  private canMove(x: number, z: number): number | null {
    const f = this.deck.at(x, z);
    if (f === OFF || f > this.footY + STEP || f < this.footY - DROP) return null;
    return this.free(x, z, Math.max(f, this.footY)) ? f : null;
  }

  /**
   * Blocked head-on by a corner: find the nearest side offset (up to SLIP m, either way) from which the
   * move would go on, and ease toward it — at most 5 cm a frame, so walking into a corner glides round it.
   */
  private slip(dx: number, dz: number): boolean {
    const l = Math.hypot(dx, dz);
    if (l < 1e-5) return false;
    const px = -dz / l, pz = dx / l, SLIP = 0.35;
    for (let o = 0.02; o <= SLIP; o += 0.02)
      for (const side of [1, -1]) {
        const ox = this.pos.x + px * o * side, oz = this.pos.y + pz * o * side;
        if (this.canMove(ox, oz) === null || this.canMove(ox + dx, oz + dz) === null) continue;
        const k = Math.min(o, 0.05) * side;
        const sx = this.pos.x + px * k, sz = this.pos.y + pz * k;
        if (this.canMove(sx, sz) === null) continue;
        this.pos.set(sx, sz);
        return true;
      }
    return false;
  }

  update(dt: number, input: Input, boat: THREE.Object3D, camera: THREE.PerspectiveCamera): void {
    // ---- look ----
    // (through the spyglass the mouse turns the view finer, so the aim stays under control)
    const k = (input.locked ? 0.0022 : 0.005) / this.magnification;
    this.yaw -= (input.lookDX + (input.locked ? 0 : input.dragDX)) * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch - (input.lookDY + (input.locked ? 0 : input.dragDY)) * k, -1.35, 1.35);

    // ---- walk (boat frame: forward = +z at yaw 0, left = +x) ----
    const fwd = input.axis('KeyS', 'KeyW'), side = input.axis('KeyD', 'KeyA');
    const run = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const want = new THREE.Vector2(side, fwd);
    if (want.lengthSq() > 1) want.normalize();
    // with the glass at the eye one only shuffles
    const sp = (run ? RUN : WALK) * (1 - 0.7 * this.scope);
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const tx = (want.x * c + want.y * s) * sp, tz = (-want.x * s + want.y * c) * sp;
    this.vel.lerp(new THREE.Vector2(tx, tz), 1 - Math.exp(-dt * 10));
    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.y + this.vel.y * dt;
    // move, sliding along walls one axis at a time
    let f = this.canMove(nx, nz);
    if (f !== null) this.pos.set(nx, nz);
    else if (Math.abs(nx - this.pos.x) > 1e-4 && (f = this.canMove(nx, this.pos.y)) !== null) { this.pos.x = nx; this.vel.y = 0; }
    else if (Math.abs(nz - this.pos.y) > 1e-4 && (f = this.canMove(this.pos.x, nz)) !== null) { this.pos.y = nz; this.vel.x = 0; }
    else if (!this.slip(nx - this.pos.x, nz - this.pos.y)) this.vel.set(0, 0);
    const floor = this.deck.at(this.pos.x, this.pos.y);
    if (floor !== OFF) {
      if (!this.airborne && input.wasPressed('Space')) {
        this.airborne = true;
        this.vy = JUMP;
        this.peak = this.footY;
        this.onJump?.();
      } else if (!this.airborne && floor < this.footY - 0.2) {
        // walked off an edge: fall
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
          this.lastStep = this.stride; // the landing is the step
        }
      } else {
        // up steps quickly, down gentle slopes smoothly
        this.footY += (floor - this.footY) * (1 - Math.exp(-dt * 18));
      }
    }

    // ---- gait: head bob and footfalls ----
    const moving = this.vel.length();
    this.pace = THREE.MathUtils.clamp((moving - 0.2) / (RUN - 0.2), 0, 1);
    this.stride += moving * dt;
    const stepLen = 0.7 + 0.25 * this.pace;
    if (moving > 0.3 && !this.airborne && this.stride - this.lastStep > stepLen) { this.lastStep = this.stride; this.onStep?.(this.pace); }
    if (moving < 0.3) this.lastStep = this.stride - stepLen * 0.5; // the first step comes soon after starting
    this.bob += ((moving > 0.3 && !this.airborne ? 1 : 0) - this.bob) * (1 - Math.exp(-dt * 6));
    const ph = (this.stride / stepLen) * Math.PI;
    const bobY = this.bob * (0.035 + 0.03 * this.pace) * Math.abs(Math.sin(ph));
    const bobX = this.bob * 0.02 * Math.sin(ph);

    // ---- place the eye on the moving hull ----
    this.eye.set(this.pos.x + bobX * c, this.footY + EYE - bobY, this.pos.y - bobX * s);
    boat.updateMatrixWorld();
    camera.position.copy(this.eye).applyMatrix4(boat.matrixWorld);
    // orientation: heading from the boat, only part of its roll and pitch
    const qb = boat.quaternion;
    const f3 = new THREE.Vector3(0, 0, 1).applyQuaternion(qb);
    this.qLevel.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f3.x, f3.z));
    // bracing against the roll with the glass up: less of the boat's tilt reaches the view
    const qBody = this.qLevel.clone().slerp(qb, LEVEL * (1 - 0.6 * this.scope));
    // camera looks down −z: turn it to face the bow (+z), then yaw / pitch
    this.euler.set(this.pitch + this.tremor.pitch, this.yaw + this.tremor.yaw + Math.PI, 0, 'YXZ');
    this.qLook.setFromEuler(this.euler);
    camera.quaternion.copy(qBody).multiply(this.qLook);
    camera.updateMatrixWorld();
  }
}
