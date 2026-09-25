import * as THREE from 'three';
import type { WaveField } from '../environment/WaveField';
import { OFF, type DeckMap } from '../boat/DeckMap';
import { terrainHeight } from '../world/WorldGen';

/*
 * Small-arms balls: a pistol ball (a lead sphere of ~1.5 cm) leaves at ~150 m/s and slows in the air. It can
 * come down in the sea, on an island, or strike the boat's own timbers: the deck, a rail, a mast, a cabin —
 * found on the DeckMap's height field (the top of whatever stands at a point of the deck) in the boat's
 * frame, no triangle tests. A glancing hit skips off (a ricochet, with the whine), a square one buries in
 * the wood; at most two skips.
 */

const SPEED = 150;
const DRAG = 0.0035;
const MAX = 16;

interface Ball { pos: THREE.Vector3; vel: THREE.Vector3; age: number; bounces: number }

export type BallHit = 'water' | 'land' | 'wood' | 'ricochet' | 'bone';

export class Musketry {
  readonly mesh: THREE.InstancedMesh;
  onHit: ((kind: BallHit, at: THREE.Vector3) => void) | null = null;
  /** something else a ball can hit on its way from a to b (the Skull Island's guards and rock): where, and what */
  target: ((a: THREE.Vector3, b: THREE.Vector3) => { at: THREE.Vector3; kind: 'bone' | 'land' } | null) | null = null;
  private readonly balls: Ball[] = [];
  private readonly toBoat = new THREE.Matrix4();
  private readonly qInv = new THREE.Quaternion();
  private readonly n = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };
  private readonly m = new THREE.Matrix4();

  constructor(private readonly deck: DeckMap, private readonly boat: THREE.Object3D) {
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.5, metalness: 0.7 }), MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  fire(muzzle: THREE.Vector3, dir: THREE.Vector3, carrier: THREE.Vector3): void {
    if (this.balls.length >= MAX) this.balls.shift();
    this.balls.push({ pos: muzzle.clone(), vel: dir.clone().normalize().multiplyScalar(SPEED * (0.95 + 0.1 * Math.random())).add(carrier), age: 0, bounces: 0 });
  }

  update(dt: number, t: number, waves: WaveField): void {
    dt = Math.min(dt, 0.05);
    this.boat.updateMatrixWorld();
    this.toBoat.copy(this.boat.matrixWorld).invert();
    this.qInv.copy(this.boat.quaternion).invert();
    const local = new THREE.Vector3(), prevL = new THREE.Vector3(), step = new THREE.Vector3();
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.age += dt;
      const sp = b.vel.length();
      b.vel.multiplyScalar(Math.max(0, 1 - DRAG * sp * dt));
      b.vel.y -= 9.81 * dt;
      // march the step in short pieces against the boat's timbers (a ball covers 2–3 m a frame)
      const from = b.pos.clone();
      step.copy(b.vel).multiplyScalar(dt);
      const pieces = Math.max(1, Math.ceil(step.length() / 0.05));
      let hit = false;
      prevL.copy(from).applyMatrix4(this.toBoat);
      for (let k = 1; k <= pieces && !hit; k++) {
        const p = from.clone().addScaledVector(step, k / pieces);
        local.copy(p).applyMatrix4(this.toBoat);
        const top = this.deck.rawAt(local.x, local.z);
        // inside the solid: below the top of what stands there, and above the waterline (the hull's sides)
        if (top !== OFF && local.y <= top && local.y > -0.3) {
          hit = true;
          b.pos.copy(from.clone().addScaledVector(step, (k - 1) / pieces));
          this.strike(b, prevL, local, top);
        }
        prevL.copy(local);
      }
      if (hit) { if (b.bounces < 0) this.balls.splice(i, 1); continue; }
      const other = this.target?.(b.pos, b.pos.clone().add(step));
      if (other) { this.onHit?.(other.kind, other.at); this.balls.splice(i, 1); continue; }
      b.pos.add(step);
      waves.sample(b.pos.x, b.pos.z, t, this.n);
      const ground = terrainHeight(b.pos.x, b.pos.z);
      if (ground > this.n.height && b.pos.y < ground) { this.onHit?.('land', b.pos.clone().setY(ground)); this.balls.splice(i, 1); }
      else if (b.pos.y < this.n.height) { this.onHit?.('water', b.pos.clone().setY(this.n.height)); this.balls.splice(i, 1); }
      else if (b.age > 6) this.balls.splice(i, 1);
    }
    this.balls.forEach((b, i) => this.mesh.setMatrixAt(i, this.m.makeTranslation(b.pos.x, b.pos.y, b.pos.z)));
    this.mesh.count = this.balls.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** the ball met wood at boat-frame `at` (coming from `prev`): skip off, or bury itself (bounces = −1) */
  private strike(b: Ball, prev: THREE.Vector3, at: THREE.Vector3, top: number): void {
    // a floor (it came down from above something of about the same height) or a wall (it came from the side)
    const prevTop = this.deck.rawAt(prev.x, prev.z);
    const n = new THREE.Vector3();
    if (prev.y > top - 0.02 && (prevTop === OFF || Math.abs(prevTop - top) < 0.15)) n.set(0, 1, 0);
    else n.set(prev.x - at.x, 0, prev.z - at.z).normalize();
    if (n.lengthSq() < 0.5) n.set(0, 1, 0);
    const v = b.vel.clone().applyQuaternion(this.qInv);
    const cosI = -v.dot(n) / Math.max(v.length(), 1e-6);
    const world = b.pos.clone();
    if (b.bounces < 2 && (cosI < 0.5 || Math.random() < 0.25)) {
      // a skip: reflected, most of the speed lost, a little scatter
      v.addScaledVector(n, -2 * v.dot(n)).multiplyScalar(0.3 + 0.15 * Math.random());
      v.x += (Math.random() - 0.5) * 6; v.y += Math.random() * 4; v.z += (Math.random() - 0.5) * 6;
      b.vel.copy(v.applyQuaternion(this.boat.quaternion));
      b.bounces++;
      this.onHit?.('ricochet', world);
    } else {
      b.bounces = -1;
      this.onHit?.('wood', world);
    }
  }
}
