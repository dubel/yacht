import * as THREE from 'three';
import type { Input } from '../core/Input';
import { makeLantern, makePistol, makeRapier, type Lantern, type Pistol, type Rapier } from './models';
import { Hands, type Grasp } from './Hands';

/*
 * What the sailor holds on deck: 1 the flintlock pistol, 2 the rapier, 3 a lantern (the spyglass, 0, is its
 * own thing).
 * The models live in an overlay scene drawn last with the depth cleared, so a barrel or blade never sinks
 * into a rail or a mast; the overlay's root follows the camera every frame, and the held piece sits in it
 * at arm's length, swaying a little behind the mouse and bobbing with the stride.
 *
 * Pistol: Ctrl (or a click) lets the cock fall — the pan flashes, and a heartbeat later the charge goes off
 * (flash, recoil, a ball on its way); it takes RELOAD s to load again. Rapier: Ctrl cuts, alternately from
 * high left to low right and from high right to low left, a fading trail behind the blade. Lantern: held
 * overhand by the bail, swinging like a pendulum as the sailor walks and turns; it lights the world (a real
 * light in the main scene, so the deck, the sails, the sea — and one day a beach — are lit by it) and the hand
 * that holds it; Ctrl held lifts it higher and forward, to light further.
 */

export type Weapon = 'none' | 'pistol' | 'rapier' | 'lantern';

const PISTOL_RELOAD = 3;
const SLASH_TIME = 0.42;
const HANG_FIRE = 0.085; // pan flash → shot

interface Pose { p: THREE.Vector3; r: THREE.Euler }
const pose = (x: number, y: number, z: number, rx: number, ry: number, rz: number): Pose => ({ p: new THREE.Vector3(x, y, z), r: new THREE.Euler(rx, ry, rz, 'YXZ') });

const PISTOL_REST = pose(0.16, -0.105, -0.42, 0.04, 0.08, 0);
const RAPIER_GUARD = pose(0.17, -0.13, -0.36, 0.32, 0.22, -0.35);
const LANTERN_HOLD = pose(0.2, -0.01, -0.43, 0.05, -0.25, 0);
const LANTERN_UP = pose(0.1, 0.12, -0.56, 0.2, -0.1, 0);
// the two cuts: start (high, to one side, blade raised) → end (low, across the other side)
const CUTS: [Pose, Pose][] = [
  [pose(-0.06, 0.06, -0.3, 1.25, 0.75, -0.9), pose(0.34, -0.36, -0.36, -0.55, -0.85, -0.9)],
  [pose(0.42, 0.06, -0.3, 1.25, -0.75, 0.9), pose(-0.1, -0.36, -0.36, -0.55, 0.85, 0.9)],
];

/** how the hand closes on each piece (see Hands) */
export const GRASP: Record<Exclude<Weapon, 'none'>, Grasp> = {
  // the index finger along the trigger, the rest round the butt
  pistol: { index: [0.3, 0.4, 0.5], middle: [1.05, 1.1, 0.8], ring: [1.05, 1.1, 0.8], pinky: [1, 1.1, 0.8], thumb: [-0.5, 0.3, 0.3], thumbAcross: 0.2, radius: 0.0155 },
  // the fingers round the wire-bound grip inside the knuckle bow, the thumb along it toward the guard
  rapier: { index: [0.9, 1, 0.8], middle: [1.05, 1.1, 0.8], ring: [1.05, 1.1, 0.8], pinky: [1, 1.1, 0.8], thumb: [-0.5, 0.3, 0.3], thumbAcross: 0.2, radius: 0.012 },
  // overhand on the bail: the fingers hooked round the wire
  lantern: { index: [1.1, 1.3, 0.9], middle: [1.15, 1.3, 0.9], ring: [1.15, 1.3, 0.9], pinky: [1.1, 1.3, 0.9], thumb: [-0.6, 0.4, 0.3], thumbAcross: 0.3, radius: 0.005 },
};

export class Weapons {
  /** drawn last, over everything (see Pipeline.overlay) */
  readonly overlay = new THREE.Scene();
  readonly light = new THREE.DirectionalLight(0xffffff, 1);
  weapon: Weapon = 'none';
  /** the pistol was fired: muzzle (world) and the direction the ball leaves in */
  onPistol: ((muzzle: THREE.Vector3, dir: THREE.Vector3) => void) | null = null;
  /** the flint struck and the pan flashed (sound) */
  onPan: (() => void) | null = null;
  onSlash: ((cut: number) => void) | null = null;
  /** loaded again */
  onReady: (() => void) | null = null;

  private readonly root = new THREE.Group();
  /** the arm and hand that hold them */
  readonly hands = new Hands();
  private readonly pistol: Pistol;
  private readonly rapier: Rapier;
  private readonly lantern: Lantern;
  /** the lantern's light in the world (in the main scene from the start, dark until the lantern is held) */
  readonly worldLight = new THREE.PointLight(0xffa850, 0, 38, 2);
  private readonly handLight = new THREE.PointLight(0xffa850, 0, 1.5, 2);
  private readonly swing = new THREE.Vector2();
  private readonly swingV = new THREE.Vector2();
  private lift = 0;
  private time = 0;
  private readonly flash: THREE.Sprite;
  private readonly flashLight = new THREE.PointLight(0xffa050, 0, 3, 2);
  private readonly trail: THREE.Mesh;
  private readonly trailPts: { a: THREE.Vector3; b: THREE.Vector3; age: number }[] = [];
  private held: Weapon = 'none';
  /** 0 put away … 1 in hand */
  private draw = 0;
  private reload = 0;
  private hang = -1;
  private kick = 0;
  private slashT = -1;
  private cut = 0;
  private swayX = 0;
  private swayY = 0;
  private lastStride = 0;
  private bobPhase = 0;
  private bob = 0;
  private readonly dot = document.createElement('div');
  private readonly slots = document.createElement('div');

  constructor() {
    this.pistol = makePistol();
    this.rapier = makeRapier();
    this.lantern = makeLantern();
    this.lantern.flame.add(this.handLight);
    this.root.add(this.pistol.group, this.rapier.group, this.lantern.group);
    this.lantern.group.visible = false;
    this.root.add(this.hands.root);
    this.overlay.add(this.root, this.light, this.light.target);
    this.pistol.group.visible = this.rapier.group.visible = false;

    // muzzle flash: a hot star, and a light that catches the hand for an instant
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,245,220,1)'); grad.addColorStop(0.25, 'rgba(255,190,90,0.9)'); grad.addColorStop(1, 'rgba(255,110,20,0)');
    x.fillStyle = grad;
    x.beginPath();
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2, r = k % 2 ? 13 : 32; x.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
    x.fill();
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(6, 4.5, 3) }));
    this.flash.scale.setScalar(0.16);
    this.flash.visible = false;
    this.pistol.muzzle.add(this.flash, this.flashLight);
    this.flash.position.z = -0.05;

    // the blade's trail: a ribbon between the last positions of its base and tip
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 2 * 3), 3));
    tg.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(24 * 2), 1));
    const idx: number[] = [];
    for (let k = 0; k < 23; k++) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
    tg.setIndex(idx);
    this.trail = new THREE.Mesh(tg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: 'attribute float aFade; varying float vF; void main(){ vF = aFade; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'varying float vF; void main(){ gl_FragColor = vec4(vec3(0.9,0.95,1.0)*0.9*vF*vF, 1.0); }',
    }));
    this.trail.frustumCulled = false;
    this.root.add(this.trail);

    this.dot.id = 'aimdot';
    this.dot.hidden = true;
    this.slots.id = 'slots';
    this.slots.hidden = true;
    this.slots.innerHTML = '<span data-w="pistol"><kbd>1</kbd> pistolet</span><span data-w="rapier"><kbd>2</kbd> rapier</span><span data-w="lantern"><kbd>3</kbd> latarnia</span><span data-w="spyglass"><kbd>0</kbd> luneta</span>';
    document.body.append(this.dot, this.slots);
  }

  /** the arm and hand model (they are drawn only once it has loaded) */
  async loadHands(url: string): Promise<void> {
    await this.hands.load(url);
  }

  /** anything in hand (Ctrl then belongs to it, not to manning a gun) */
  get drawn(): boolean {
    return this.weapon !== 'none';
  }

  /** 1 / 2: take it out, or put it away if it is the one in hand */
  select(w: Weapon): void {
    this.weapon = this.weapon === w ? 'none' : w;
  }

  holster(): void {
    this.weapon = 'none';
  }

  /** put everything away at once (leaving the deck) */
  stow(): void {
    this.weapon = this.held = 'none';
    this.draw = 0;
    this.slashT = -1;
    this.pistol.group.visible = this.rapier.group.visible = this.lantern.group.visible = false;
    this.worldLight.intensity = this.handLight.intensity = 0;
    this.dot.hidden = this.slots.hidden = true;
  }

  /**
   * Once per frame on deck. `lowered`: the spyglass is up or a map is open — the piece drops out of view and
   * can't be used. `stride`: distance walked (for the bob).
   */
  update(dt: number, input: Input, camera: THREE.PerspectiveCamera, stride: number, lowered: boolean, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, env: THREE.Texture | null): void {
    // ---- which piece: the old one goes down before the new one comes up ----
    const want = lowered ? 'none' : this.weapon;
    if (this.held !== want) {
      this.draw = Math.max(0, this.draw - dt / 0.22);
      if (this.draw === 0) { this.held = want; this.slashT = -1; this.trailPts.length = 0; }
    } else if (this.held !== 'none') this.draw = Math.min(1, this.draw + dt / 0.3);
    this.pistol.group.visible = this.held === 'pistol';
    this.rapier.group.visible = this.held === 'rapier';
    this.lantern.group.visible = this.held === 'lantern';
    this.time += dt;

    // ---- use it ----
    const pull = !lowered && this.draw > 0.95 && (input.wasPressed('ControlLeft') || input.wasPressed('ControlRight') || input.click);
    this.reload = Math.max(0, this.reload - dt);
    if (this.held === 'pistol') {
      if (pull && this.reload <= 0 && this.hang < 0) { this.hang = HANG_FIRE; this.reload = PISTOL_RELOAD; this.onPan?.(); }
    }
    if (this.hang >= 0) {
      this.pistol.cock.rotation.x += (-0.25 - this.pistol.cock.rotation.x) * Math.min(1, dt * 60);
      this.hang -= dt;
      if (this.hang < 0) {
        this.kick = 1;
        this.flash.visible = true;
        this.flash.material.rotation = Math.random() * 6.28;
        this.flashLight.intensity = 4;
        camera.updateMatrixWorld();
        this.root.updateMatrixWorld(true);
        const muzzle = this.pistol.muzzle.getWorldPosition(new THREE.Vector3());
        // the ball goes where the dot is: toward the point 60 m down the line of sight
        const aim = new THREE.Vector3(0, 0, -60).applyMatrix4(camera.matrixWorld);
        this.onPistol?.(muzzle, aim.sub(muzzle).normalize());
      }
    } else if (this.held === 'pistol' && this.reload <= 0 && this.pistol.cock.rotation.x < 0.5) {
      // loaded and primed again: the cock is drawn back with a click
      this.pistol.cock.rotation.x = 0.55;
      this.onReady?.();
    }
    // the flash lasts a couple of frames
    if (this.kick < 0.75) { this.flash.visible = false; this.flashLight.intensity = 0; }
    this.kick = Math.max(0, this.kick - dt * 3.2);

    if (this.held === 'rapier' && pull && (this.slashT < 0 || this.slashT > 0.7)) {
      this.slashT = 0;
      this.cut = 1 - this.cut;
      this.onSlash?.(this.cut);
    }
    if (this.slashT >= 0) {
      this.slashT += dt / SLASH_TIME;
      if (this.slashT >= 1) this.slashT = -1;
    }

    // ---- sway behind the mouse, bob with the stride ----
    this.swayX += (-(input.lookDX + input.dragDX) * 0.00035 - this.swayX) * (1 - Math.exp(-dt * 10));
    this.swayY += (-(input.lookDY + input.dragDY) * 0.00035 - this.swayY) * (1 - Math.exp(-dt * 10));
    const speed = (stride - this.lastStride) / Math.max(dt, 1e-3);
    this.lastStride = stride;
    this.bob += ((speed > 0.3 ? Math.min(1, speed / 2.5) : 0) - this.bob) * (1 - Math.exp(-dt * 6));
    this.bobPhase += speed * dt * 4.4;

    // ---- pose ----
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    if (this.held === 'pistol') {
      p.copy(PISTOL_REST.p);
      q.setFromEuler(PISTOL_REST.r);
      // recoil: the muzzle flips up and the hand comes back, then settles
      const k = this.kick * this.kick * (3 - 2 * this.kick);
      p.z += 0.07 * k;
      p.y += 0.02 * k;
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55 * k, 0, 0.1 * k)));
    } else if (this.held === 'rapier') {
      this.rapierPose(p, q);
    } else if (this.held === 'lantern') {
      // Ctrl held: lift it up and out in front
      const up = !lowered && (input.isDown('ControlLeft') || input.isDown('ControlRight') || input.lmb);
      this.lift += ((up ? 1 : 0) - this.lift) * (1 - Math.exp(-dt * 6));
      const k = this.lift * this.lift * (3 - 2 * this.lift);
      p.lerpVectors(LANTERN_HOLD.p, LANTERN_UP.p, k);
      q.slerpQuaternions(new THREE.Quaternion().setFromEuler(LANTERN_HOLD.r), new THREE.Quaternion().setFromEuler(LANTERN_UP.r), k);
      this.swingLantern(dt);
    }
    // drawing / putting away: from below the frame
    const d = 1 - this.draw;
    p.y -= 0.32 * d * d;
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.9 * d * d, 0, 0)));
    p.x += this.swayX + Math.sin(this.bobPhase) * 0.007 * this.bob;
    p.y += this.swayY - Math.abs(Math.cos(this.bobPhase)) * 0.009 * this.bob;
    const held = this.held === 'pistol' ? this.pistol.group : this.held === 'rapier' ? this.rapier.group : this.lantern.group;
    held.position.copy(p);
    held.quaternion.copy(q);

    // ---- the overlay follows the camera; its light is the sun's ----
    this.root.position.copy(camera.position);
    this.root.quaternion.copy(camera.quaternion);
    // the hand on the grip of what is held, the arm after it
    this.root.updateMatrixWorld(true);
    this.hands.update(this.held === 'none' ? null : this.gripOf(this.held), this.held === 'none' ? null : GRASP[this.held]);
    this.light.position.copy(camera.position).add(sunDir);
    this.light.target.position.copy(camera.position);
    this.light.color.copy(sunColor);
    // (held at arm's length, it would take the full sun and the whole bright sky at once and bleach out:
    //  a little less of both, as the body and the rigging shade it)
    this.light.intensity = sunIntensity * 0.5;
    this.overlay.environment = env;
    this.overlay.environmentIntensity = 0.5;
    this.overlay.visible = this.held !== 'none';
    this.updateTrail(dt);
    this.updateLight();

    // ---- HUD: the aiming dot (amber while loading), the slots ----
    this.dot.hidden = !(this.held === 'pistol' && this.draw > 0.9);
    this.dot.classList.toggle('loading', this.reload > 0);
    this.slots.hidden = false;
    for (const el of this.slots.children) (el as HTMLElement).classList.toggle('on', (el as HTMLElement).dataset.w === this.weapon);
  }

  private gripOf(w: Exclude<Weapon, 'none'>): THREE.Object3D {
    return w === 'pistol' ? this.pistol.grip : w === 'rapier' ? this.rapier.grip : this.lantern.grip;
  }

  /** the slots bar also shows the spyglass slot as active */
  markSpyglass(on: boolean): void {
    (this.slots.lastElementChild as HTMLElement).classList.toggle('on', on);
  }

  hideHud(): void {
    this.dot.hidden = this.slots.hidden = true;
  }

  /**
   * The lantern hangs from the hand: a damped pendulum, kicked by the hand's own motion — the view turning
   * (sway), the stride's bob, lifting it — so it lags, overshoots and settles.
   */
  private swingLantern(dt: number): void {
    const g = 9.81 / 0.16; // ω² of a ~16 cm pendulum
    const push = new THREE.Vector2(this.swayX * 900 + Math.sin(this.bobPhase) * 6 * this.bob, this.swayY * 700 + Math.cos(this.bobPhase * 2) * 3 * this.bob);
    this.swingV.x += (-g * this.swing.x - 2.2 * this.swingV.x + push.x) * dt;
    this.swingV.y += (-g * this.swing.y - 2.2 * this.swingV.y + push.y) * dt;
    this.swing.addScaledVector(this.swingV, dt);
    this.swing.clampScalar(-0.6, 0.6);
    this.lantern.body.rotation.set(this.swing.y, 0, this.swing.x);
  }

  /** the flame flickers; its light follows it in the world and warms the hand */
  private updateLight(): void {
    const on = this.held === 'lantern' ? this.draw : 0;
    const t = this.time;
    const flicker = 0.86 + 0.08 * Math.sin(t * 11.3) + 0.05 * Math.sin(t * 23.7 + 1.3) + 0.03 * Math.sin(t * 41.1);
    // (bright enough to light the deck round about and the rail across it; falls off as the square of distance)
    this.worldLight.intensity = 42 * on * flicker;
    this.handLight.intensity = 0.35 * on * flicker;
    this.lantern.glass.emissiveIntensity = 0.3 * flicker;
    this.lantern.flame.scale.set(1, 0.85 + 0.3 * (flicker - 0.86) / 0.16, 1);
    if (on > 0) {
      this.root.updateMatrixWorld(true);
      this.lantern.flame.getWorldPosition(this.worldLight.position);
    }
  }

  private rapierPose(p: THREE.Vector3, q: THREE.Quaternion): void {
    const g = RAPIER_GUARD;
    if (this.slashT < 0) { p.copy(g.p); q.setFromEuler(g.r); return; }
    const [from, to] = CUTS[this.cut];
    const t = this.slashT;
    const qg = new THREE.Quaternion().setFromEuler(g.r), qa = new THREE.Quaternion().setFromEuler(from.r), qb = new THREE.Quaternion().setFromEuler(to.r);
    const ease = (x: number) => x * x * (3 - 2 * x);
    if (t < 0.28) {            // wind up
      const k = ease(t / 0.28);
      p.lerpVectors(g.p, from.p, k); q.slerpQuaternions(qg, qa, k);
    } else if (t < 0.55) {     // the cut: fast through the middle
      const k = ease((t - 0.28) / 0.27);
      p.lerpVectors(from.p, to.p, k); q.slerpQuaternions(qa, qb, k);
      // (a slight arc outward, as a wrist and elbow swing)
      p.z -= Math.sin(k * Math.PI) * 0.08;
    } else {                   // recover
      const k = ease((t - 0.55) / 0.45);
      p.lerpVectors(to.p, g.p, k); q.slerpQuaternions(qb, qg, k);
    }
  }

  private updateTrail(dt: number): void {
    for (const s of this.trailPts) s.age += dt;
    while (this.trailPts.length && this.trailPts[0].age > 0.12) this.trailPts.shift();
    if (this.held === 'rapier' && this.slashT > 0.26 && this.slashT < 0.62) {
      this.rapier.group.updateMatrix();
      const a = this.rapier.base.position.clone().applyMatrix4(this.rapier.group.matrix);
      const b = this.rapier.tip.position.clone().applyMatrix4(this.rapier.group.matrix);
      this.trailPts.push({ a, b, age: 0 });
      if (this.trailPts.length > 24) this.trailPts.shift();
    }
    const n = this.trailPts.length;
    this.trail.visible = n > 1;
    if (n < 2) return;
    const pos = this.trail.geometry.attributes.position as THREE.BufferAttribute, fade = this.trail.geometry.attributes.aFade as THREE.BufferAttribute;
    for (let k = 0; k < 24; k++) {
      const s = this.trailPts[Math.min(k, n - 1)];
      // (the ribbon runs from partway down the blade to the tip: the tip moves fastest)
      const a = s.a.clone().lerp(s.b, 0.35);
      pos.setXYZ(k * 2, a.x, a.y, a.z);
      pos.setXYZ(k * 2 + 1, s.b.x, s.b.y, s.b.z);
      const f = k < n ? Math.max(0, 1 - s.age / 0.12) * (k / (n - 1)) : 0;
      fade.setX(k * 2, f * 0.5);
      fade.setX(k * 2 + 1, f);
    }
    pos.needsUpdate = fade.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, (n - 1) * 6);
  }
}
