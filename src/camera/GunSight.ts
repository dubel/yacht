import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { Gun } from '../combat/Guns';

/*
 * Manning a gun: the view from just behind the breech, looking down the barrel, a single cross as the sight.
 * The mouse trains the piece within its mount's arc (±35° either way, a little down, a good deal up). The
 * gun is bolted to the hull, so the boat's roll and pitch move the aim — the old gunner's craft of firing
 * on the roll — and the cross always shows exactly where the ball will leave. A shot kicks the view up and
 * back for a moment; a bar under the cross shows the reload.
 */

const YAW = 0.6, PITCH_DOWN = -0.12, PITCH_UP = 0.35;

export class GunSight {
  /** gun being manned (−1: none) */
  gun = -1;
  /** training and elevation of the manned gun (rad), for the piece itself to follow */
  yaw = 0;
  pitch = 0.04;
  private kick = 0;
  private readonly el = document.createElement('div');
  private readonly bar: HTMLDivElement;
  private readonly eye = new THREE.Vector3();
  private readonly aimW = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor() {
    this.el.id = 'gunsight';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="cross"></div><div class="reload"><i></i></div>
      <div class="hint"><kbd>Ctrl</kbd> / lewy przycisk — ognia &nbsp;·&nbsp; <kbd>WASD</kbd> / <kbd>Esc</kbd> — odejdź od działa</div>`;
    document.body.append(this.el);
    this.bar = this.el.querySelector('.reload i')!;
  }

  get active(): boolean {
    return this.gun >= 0;
  }

  enter(i: number): void {
    this.gun = i;
    this.yaw = 0;
    this.pitch = 0.04;
    this.el.hidden = false;
    document.body.classList.add('manning');
  }

  exit(): void {
    this.gun = -1;
    this.el.hidden = true;
    document.body.classList.remove('manning');
  }

  /** a shot: kick the view */
  recoil(): void {
    this.kick = 1;
  }

  /**
   * Once per frame while manning: aim with the mouse, place the camera behind the breech. Returns the
   * muzzle and the direction a ball would leave in, in world space.
   */
  update(dt: number, input: Input, boat: THREE.Object3D, g: Gun, camera: THREE.PerspectiveCamera, reload: number, reloadTime: number): { muzzle: THREE.Vector3; dir: THREE.Vector3 } {
    const k = input.locked ? 0.0018 : 0.004;
    this.yaw = THREE.MathUtils.clamp(this.yaw - (input.lookDX + (input.locked ? 0 : input.dragDX)) * k, -YAW, YAW);
    this.pitch = THREE.MathUtils.clamp(this.pitch - (input.lookDY + (input.locked ? 0 : input.dragDY)) * k, PITCH_DOWN, PITCH_UP);
    this.kick = Math.max(0, this.kick - dt * 3.5);

    // aim in the boat frame: the barrel's bearing turned by the training, raised by the elevation
    const base = Math.atan2(g.dir.x, g.dir.z) + this.yaw;
    const cp = Math.cos(this.pitch);
    const aim = new THREE.Vector3(Math.sin(base) * cp, Math.sin(this.pitch), Math.cos(base) * cp);
    // the eye: crouched behind the breech on the line of the barrel as it is trained, a little above it
    const pivot = g.mesh.position;
    const back = Math.abs(pivot.x - g.breech.x), front = Math.abs(g.muzzle.x - pivot.x);
    this.eye.copy(pivot).addScaledVector(aim, -(back + 0.5));
    this.eye.y += 0.3;
    boat.updateMatrixWorld();
    camera.position.copy(this.eye).applyMatrix4(boat.matrixWorld);
    this.aimW.copy(aim).applyQuaternion(boat.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(boat.quaternion);
    // recoil: the view jumps up and back, then settles (the aim itself doesn't move)
    const kick = this.kick * this.kick;
    camera.position.addScaledVector(this.aimW, -0.25 * kick);
    camera.up.copy(this.up);
    camera.lookAt(camera.position.clone().add(this.aimW).addScaledVector(this.up, 0.08 * kick));
    camera.up.set(0, 1, 0);
    camera.updateMatrixWorld();

    this.bar.style.width = `${(1 - reload / reloadTime) * 100}%`;
    this.el.classList.toggle('ready', reload <= 0);
    const muzzle = pivot.clone().addScaledVector(aim, front).applyMatrix4(boat.matrixWorld);
    return { muzzle, dir: this.aimW.clone() };
  }
}
