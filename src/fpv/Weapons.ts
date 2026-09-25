import * as THREE from 'three';
import type { Input } from '../core/Input';
import { makeFlintlock, makeLantern, makePistol, makeRapier, makeRum, makeSkullLantern, type Lantern, type Pistol, type Rapier, type RumBottle } from './models';
import { Hands, type Grasp } from './Hands';

/*
 * What the sailor holds on deck: 1 the flintlock pistol, 2 the rapier, 3 a lantern, 7 the revolver, 8 the dark
 * lantern (the spyglass, 0, is its own thing). The pieces are models (models.ts), loaded before the game starts (load).
 * The models live in an overlay scene drawn last with the depth cleared, so a barrel or blade never sinks
 * into a rail or a mast; the overlay's root follows the camera every frame, and the held piece sits in it
 * at arm's length, swaying a little behind the mouse and bobbing with the stride.
 *
 * Pistol: Ctrl (or a click) lets the cock fall — the pan flashes, and a heartbeat later the charge goes off
 * (flash, recoil, a ball on its way); loading it again takes a few seconds, then the cock is drawn back.
 * Revolver: the hammer falls on the cap and the chamber goes off at once; the hammer is drawn back again,
 * turning the cylinder to the next chamber — six, and then it takes a while to load them all. Rapier: Ctrl cuts, alternately from
 * high left to low right and from high right to low left, a fading trail behind the blade. Lantern: held
 * overhand by the bail (the dark one by its cord), swinging like a pendulum as the sailor walks and turns; its
 * flame lights the world (a real light in the main scene, so the deck, the sails, the sea, a beach are lit by
 * it) and the hand that holds it; Ctrl held lifts it higher and forward, to light further.
 */

export type Weapon = 'none' | 'pistol' | 'revolver' | 'rapier' | 'lantern' | 'skull' | 'rum';
type Gun = 'pistol' | 'revolver';
const isGun = (w: Weapon): w is Gun => w === 'pistol' || w === 'revolver';
const PIECES = ['pistol', 'revolver', 'rapier', 'lantern', 'skull', 'rum'] as const;
type Lamp = 'lantern' | 'skull';
const isLamp = (w: Weapon): w is Lamp => w === 'lantern' || w === 'skull';

/** from a shot until the hammer is drawn back for the next (s) */
const CYCLE = 0.3;
const SLASH_TIME = 0.42;

interface Pose { p: THREE.Vector3; r: THREE.Euler }
const pose = (x: number, y: number, z: number, rx: number, ry: number, rz: number): Pose => ({ p: new THREE.Vector3(x, y, z), r: new THREE.Euler(rx, ry, rz, 'YXZ') });

const PISTOL_REST = pose(0.16, -0.105, -0.42, 0.04, 0.08, 0);
const RAPIER_GUARD = pose(0.19, -0.16, -0.42, 0.32, 0.22, -0.35);
const LANTERN_HOLD = pose(0.2, 0.05, -0.47, 0.05, -0.25, 0);
const LANTERN_UP = pose(0.1, 0.12, -0.56, 0.2, -0.1, 0);
// the rum: held upright by the body, its mouth (the pose's point) a little below the eye; drinking, the mouth
// at the lips and the bottle tipped up over them
const RUM_HOLD = pose(0.2, 0.04, -0.48, 0.08, -0.25, 0.06);
const RUM_DRINK = pose(0.05, -0.1, -0.13, 2.0, 0.12, -0.18);
/** a swig: raising it (s) and how long it takes all told; the swigs in a bottle */
const SWIG_TIME = 2.6, SWIGS = 8;
// the two cuts: start (high, to one side, blade raised) → end (low, across the other side)
const CUTS: [Pose, Pose][] = [
  [pose(-0.06, 0.06, -0.34, 1.25, 0.75, -0.9), pose(0.3, -0.26, -0.42, -0.55, -0.85, -0.9)],
  [pose(0.36, 0.06, -0.34, 1.25, -0.75, 0.9), pose(-0.08, -0.26, -0.42, -0.55, 0.85, 0.9)],
];

/** how the hand closes on each piece (see Hands) */
export const GRASP: Record<Exclude<Weapon, 'none'>, Grasp> = {
  // the index finger along the trigger, the rest round the butt
  pistol: { index: [0.3, 0.4, 0.5], middle: [1.05, 1.1, 0.8], ring: [1.05, 1.1, 0.8], pinky: [1, 1.1, 0.8], thumb: [-0.5, 0.3, 0.3], thumbAcross: 0.2, radius: 0.016 },
  revolver: { index: [0.3, 0.4, 0.5], middle: [1.05, 1.1, 0.8], ring: [1.05, 1.1, 0.8], pinky: [1, 1.1, 0.8], thumb: [-0.5, 0.3, 0.3], thumbAcross: 0.2, radius: 0.0155 },
  // a fist round the wire-bound grip inside the knuckle bow, the thumb over it to the index finger
  rapier: { index: [0.9, 1, 0.8], middle: [1.05, 1.1, 0.8], ring: [1.05, 1.1, 0.8], pinky: [1, 1.1, 0.8], thumb: [-1, 0.7, 0.6], thumbAcross: 0.6, radius: 0.02 },
  // overhand on the bail: the fingers hooked round the wire
  lantern: { index: [1.1, 1.3, 0.9], middle: [1.15, 1.3, 0.9], ring: [1.15, 1.3, 0.9], pinky: [1.1, 1.3, 0.9], thumb: [-0.6, 0.4, 0.3], thumbAcross: 0.3, radius: 0.005 },
  // the same round the dark lantern's braided cord
  skull: { index: [1.1, 1.3, 0.9], middle: [1.15, 1.3, 0.9], ring: [1.15, 1.3, 0.9], pinky: [1.1, 1.3, 0.9], thumb: [-0.6, 0.4, 0.3], thumbAcross: 0.3, radius: 0.007 },
  // round the flask's body (8 × 7 cm, too big for a fist): the palm on its narrow side, the fingers round its back
  rum: { index: [0.63, 0.81, 0.54], middle: [0.72, 0.81, 0.54], ring: [0.72, 0.81, 0.54], pinky: [0.63, 0.81, 0.54], thumb: [-0.3, 0.1, 0.1], thumbAcross: 0.1, radius: 0.068, fit: false },
};

export class Weapons {
  /** drawn last, over everything (see Pipeline.overlay) */
  readonly overlay = new THREE.Scene();
  readonly light = new THREE.DirectionalLight(0xffffff, 1);
  weapon: Weapon = 'none';
  /** the pistol was fired: muzzle (world) and the direction the ball leaves in */
  onPistol: ((muzzle: THREE.Vector3, dir: THREE.Vector3) => void) | null = null;
  /** the hammer fell on the cap (sound); the shot follows `hang` s later */
  onPan: ((hang: number) => void) | null = null;
  onSlash: ((cut: number) => void) | null = null;
  /** the blade is through the middle of its cut: whatever is in reach before him is struck now */
  onCutHit: (() => void) | null = null;
  /** the hammer drawn back: ready to fire again */
  onReady: (() => void) | null = null;
  /** the models have loaded (nothing is drawn or used before) */
  ready = false;

  private readonly root = new THREE.Group();
  /** the arm and hand that hold them */
  readonly hands = new Hands();
  /** the guns: the model, loaded chambers, the hammer (0 down … 1 back) and where it is going, the cylinder's turn */
  private guns!: Record<Gun, { model: Pistol; rounds: number; hammer: number; hammerTo: number; cylinder: number; cylinderTo: number; cycle: number; reload: number }>;
  /** the gun whose shot is on its way (its hang-fire running) */
  private firing: Gun = 'pistol';
  private rapier!: Rapier;
  private lamps!: Record<Lamp, Lantern>;
  private rum!: RumBottle;
  /** the rum left in the bottle (0–1), a swig under way (0–1, −1 none), the surface's sloshing up (world) */
  rumLeft = 1;
  private swig = -1;
  /** debugging: the swig held at this point */
  debugSwig: number | null = null;
  private readonly slosh = new THREE.Vector3(0, 1, 0);
  private readonly sloshV = new THREE.Vector3();
  private readonly lastPos = new THREE.Vector3();
  private readonly lastVel = new THREE.Vector3();
  /** the rum: a swig begun (sound), a gulp in it, the swig down (he is the drunker for it); the bottle is empty
   *  (true if it is filled again) */
  onSwig: (() => void) | null = null;
  onGulp: (() => void) | null = null;
  onDrunk: (() => void) | null = null;
  onEmpty: (() => boolean) | null = null;
  /** the lantern's light in the world (in the main scene from the start, dark until a lantern is held) */
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

  constructor() {
    this.root.add(this.hands.root);
    this.overlay.add(this.root, this.light, this.light.target);

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
    document.body.append(this.dot);
  }

  /** the pieces and the arm that holds them */
  async load(): Promise<void> {
    const [pistol, revolver, rapier, lantern, skull, rum] = await Promise.all([makeFlintlock(), makePistol(), makeRapier(), makeLantern(), makeSkullLantern(), makeRum(), this.hands.load('assets/fpv/hands.glb')]);
    this.rum = rum;
    const gun = (model: Pistol) => { model.setHammer(1); return { model, rounds: model.chambers, hammer: 1, hammerTo: 1, cylinder: 0, cylinderTo: 0, cycle: 0, reload: 0 }; };
    this.guns = { pistol: gun(pistol), revolver: gun(revolver) };
    this.rapier = rapier;
    this.lamps = { lantern, skull };
    for (const w of PIECES) { const g = this.groupOf(w); g.visible = false; this.root.add(g); }
    this.ready = true;
  }

  /** a copy of a piece's model as it lies in the hand's frame (for its icon); null before they have loaded */
  pieceCopy(w: Exclude<Weapon, 'none'>): THREE.Object3D | null {
    if (!this.ready) return null;
    const g = this.groupOf(w).clone(true);
    g.position.set(0, 0, 0);
    g.quaternion.identity();
    g.visible = true;
    // (not the muzzle flash, nor the hand's light, should they be hanging on it now)
    g.traverse((o) => { if ((o as THREE.Sprite).isSprite || (o as THREE.Light).isLight) o.visible = false; });
    return g;
  }

  private groupOf(w: Exclude<Weapon, 'none'>): THREE.Group {
    return isGun(w) ? this.guns[w].model.group : w === 'rapier' ? this.rapier.group : w === 'rum' ? this.rum.group : this.lamps[w].group;
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
    if (this.ready) for (const w of PIECES) this.groupOf(w).visible = false;
    this.worldLight.intensity = this.handLight.intensity = 0;
    this.dot.hidden = true;
  }

  /**
   * Once per frame on deck. `lowered`: the spyglass is up or a map is open — the piece drops out of view and
   * can't be used. `stride`: distance walked (for the bob).
   */
  update(dt: number, input: Input, camera: THREE.PerspectiveCamera, stride: number, lowered: boolean, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, env: THREE.Texture | null): void {
    if (!this.ready) { this.overlay.visible = false; return; }
    // ---- which piece: the old one goes down before the new one comes up ----
    const want = lowered ? 'none' : this.weapon;
    if (this.held !== want) {
      this.draw = Math.max(0, this.draw - dt / 0.22);
      if (this.draw === 0) { this.held = want; this.slashT = -1; this.trailPts.length = 0; }
    } else if (this.held !== 'none') this.draw = Math.min(1, this.draw + dt / 0.3);
    for (const w of PIECES) this.groupOf(w).visible = this.held === w;
    this.time += dt;

    // ---- use it ----
    const pull = !lowered && this.draw > 0.95 && (input.wasPressed('ControlLeft') || input.wasPressed('ControlRight') || input.click);
    const held = isGun(this.held) ? this.guns[this.held] : null;
    if (held && pull && held.hammer > 0.95 && held.hammerTo === 1 && held.rounds > 0 && this.hang < 0) {
      // the cock / hammer falls: the pan flashes, or the cap goes off
      held.hammerTo = 0;
      held.rounds--;
      held.cycle = CYCLE;
      this.hang = held.model.hang;
      this.firing = this.held as Gun;
      held.model.muzzle.add(this.flash, this.flashLight);
      this.onPan?.(held.model.hang);
    }
    for (const g of Object.values(this.guns)) {
      // the hammer: it falls at once, it is drawn back by the thumb; the cylinder turns as it comes back
      g.hammer += (g.hammerTo - g.hammer) * Math.min(1, dt * (g.hammerTo < g.hammer ? 60 : 9));
      g.cylinder += (g.cylinderTo - g.cylinder) * Math.min(1, dt * 9);
      g.model.setHammer(g.hammer);
      g.model.setCylinder(g.cylinder);
      g.cycle = Math.max(0, g.cycle - dt);
      g.reload = Math.max(0, g.reload - dt);
      if (g.hammerTo === 0 && this.hang < 0 && g.cycle <= 0) {
        // all fired: load them all first (the dot goes amber), then draw the hammer back
        if (g.rounds === 0 && g.reload <= 0) { g.reload = g.model.reload; g.rounds = -1; }
        else if (g.rounds > 0 || (g.rounds < 0 && g.reload <= 0)) {
          if (g.rounds < 0) g.rounds = g.model.chambers;
          g.hammerTo = 1;
          g.cylinderTo += (Math.PI * 2) / g.model.chambers;
          if (g === held) this.onReady?.();
        }
      }
    }
    if (this.hang >= 0) {
      this.hang -= dt;
      if (this.hang < 0) {
        this.kick = 1;
        this.flash.visible = true;
        this.flash.material.rotation = Math.random() * 6.28;
        this.flashLight.intensity = 4;
        camera.updateMatrixWorld();
        this.root.updateMatrixWorld(true);
        const muzzle = this.guns[this.firing].model.muzzle.getWorldPosition(new THREE.Vector3());
        // the ball goes where the dot is: toward the point 60 m down the line of sight
        const aim = new THREE.Vector3(0, 0, -60).applyMatrix4(camera.matrixWorld);
        this.onPistol?.(muzzle, aim.sub(muzzle).normalize());
      }
    }
    // the flash lasts a couple of frames
    if (this.kick < 0.75) { this.flash.visible = false; this.flashLight.intensity = 0; }
    this.kick = Math.max(0, this.kick - dt * 3.2);

    // the rum: a swig — or, the bottle empty, perhaps it is filled
    if (this.held === 'rum' && pull && this.swig < 0) {
      if (this.rumLeft > 0.01) { this.swig = 0; this.onSwig?.(); }
      else if (this.onEmpty?.()) this.rumLeft = 1;
    }
    if (this.swig >= 0) {
      const was = this.swig;
      this.swig += dt / SWIG_TIME;
      // down the throat through the middle of it, a gulp at a time
      if (this.swig > 0.3 && this.swig < 0.78) this.rumLeft = Math.max(0, this.rumLeft - dt / SWIG_TIME / 0.48 / SWIGS);
      for (const at of [0.42, 0.56, 0.7]) if (was < at && this.swig >= at) this.onGulp?.();
      if (was < 0.8 && this.swig >= 0.8) this.onDrunk?.();
      if (this.swig >= 1) this.swig = -1;
      if (this.held !== 'rum') this.swig = -1;
      if (this.debugSwig !== null) this.swig = this.debugSwig;
    }
    if (this.held === 'rapier' && pull && (this.slashT < 0 || this.slashT > 0.7)) {
      this.slashT = 0;
      this.cut = 1 - this.cut;
      this.onSlash?.(this.cut);
    }
    if (this.slashT >= 0) {
      const was = this.slashT;
      this.slashT += dt / SLASH_TIME;
      if (was < 0.42 && this.slashT >= 0.42) this.onCutHit?.();
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
    if (isGun(this.held)) {
      p.copy(PISTOL_REST.p);
      q.setFromEuler(PISTOL_REST.r);
      // recoil: the muzzle flips up and the hand comes back, then settles
      const k = this.kick * this.kick * (3 - 2 * this.kick);
      p.z += 0.07 * k;
      p.y += 0.02 * k;
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55 * k, 0, 0.1 * k)));
    } else if (this.held === 'rapier') {
      this.rapierPose(p, q);
    } else if (isLamp(this.held)) {
      // Ctrl held: lift it up and out in front
      const up = !lowered && (input.isDown('ControlLeft') || input.isDown('ControlRight') || input.lmb);
      this.lift += ((up ? 1 : 0) - this.lift) * (1 - Math.exp(-dt * 6));
      const k = this.lift * this.lift * (3 - 2 * this.lift);
      p.lerpVectors(LANTERN_HOLD.p, LANTERN_UP.p, k);
      q.slerpQuaternions(new THREE.Quaternion().setFromEuler(LANTERN_HOLD.r), new THREE.Quaternion().setFromEuler(LANTERN_UP.r), k);
      this.swingLantern(dt);
    } else if (this.held === 'rum') {
      // a swig: up to the lips, tipped over them while it goes down, and back
      const w = this.swig < 0 ? 0 : this.swig < 0.25 ? this.swig / 0.25 : this.swig < 0.8 ? 1 : 1 - (this.swig - 0.8) / 0.2;
      const k = w * w * (3 - 2 * w);
      p.lerpVectors(RUM_HOLD.p, RUM_DRINK.p, k);
      q.slerpQuaternions(new THREE.Quaternion().setFromEuler(RUM_HOLD.r), new THREE.Quaternion().setFromEuler(RUM_DRINK.r), k);
      // (the cork out while he drinks)
      this.rum.cork.visible = this.swig < 0.12 || this.swig > 0.95;
    }
    // drawing / putting away: from below the frame
    const d = 1 - this.draw;
    p.y -= 0.32 * d * d;
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.9 * d * d, 0, 0)));
    p.x += this.swayX + Math.sin(this.bobPhase) * 0.007 * this.bob;
    p.y += this.swayY - Math.abs(Math.cos(this.bobPhase)) * 0.009 * this.bob;
    if (this.held !== 'none') {
      const held = this.groupOf(this.held);
      held.position.copy(p);
      held.quaternion.copy(q);
    }

    // ---- the overlay follows the camera; its light is the sun's ----
    this.root.position.copy(camera.position);
    this.root.quaternion.copy(camera.quaternion);
    // the hand on the grip of what is held, the arm after it
    this.root.updateMatrixWorld(true);
    this.hands.update(this.held === 'none' ? null : this.gripOf(this.held), this.held === 'none' ? null : GRASP[this.held]);
    if (this.held === 'rum') this.sloshRum(dt);
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

    // ---- HUD: the aiming dot (amber while loading) ----
    this.dot.hidden = !(held && this.draw > 0.9);
    this.dot.classList.toggle('loading', !!held && held.hammerTo < 1);
  }

  private gripOf(w: Exclude<Weapon, 'none'>): THREE.Object3D {
    return isGun(w) ? this.guns[w].model.grip : w === 'rapier' ? this.rapier.grip : w === 'rum' ? this.rum.grip : this.lamps[w].grip;
  }

  hideHud(): void {
    this.dot.hidden = true;
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
    for (const l of Object.values(this.lamps)) l.body.rotation.set(this.swing.y, 0, this.swing.x);
  }

  /**
   * The rum's surface: level in the world, but with a lag — a damped spring pulled from the true up by the
   * bottle's own acceleration (a jolt throws the rum the other way), so it sways, overshoots and settles.
   */
  private sloshRum(dt: number): void {
    const pos = this.rum.group.getWorldPosition(new THREE.Vector3());
    const vel = pos.clone().sub(this.lastPos).divideScalar(Math.max(dt, 1e-3));
    const acc = vel.clone().sub(this.lastVel).divideScalar(Math.max(dt, 1e-3)).clampLength(0, 25);
    if (this.lastPos.lengthSq() === 0 || dt > 0.1) acc.set(0, 0, 0);
    this.lastPos.copy(pos);
    this.lastVel.copy(vel);
    // where the surface would lie in a steady push: square to gravity less the acceleration
    const target = new THREE.Vector3(0, 9.81, 0).sub(acc.multiplyScalar(0.6)).normalize();
    this.sloshV.addScaledVector(target.sub(this.slosh), 70 * dt).multiplyScalar(Math.exp(-dt * 4.5));
    this.slosh.addScaledVector(this.sloshV, dt).normalize();
    this.rum.setLiquid(this.rumLeft, this.slosh);
  }

  /** the flame flickers; its light follows it in the world, in its own colour and reach, and warms the hand */
  private updateLight(): void {
    const lamp = isLamp(this.held) ? this.lamps[this.held] : null;
    const on = lamp ? this.draw : 0;
    const t = this.time;
    const flicker = 0.86 + 0.08 * Math.sin(t * 11.3) + 0.05 * Math.sin(t * 23.7 + 1.3) + 0.03 * Math.sin(t * 41.1);
    // (the lantern bright enough to light the deck round about and the rail across it; falls off as the square
    //  of distance)
    this.worldLight.intensity = (lamp?.light.intensity ?? 0) * on * flicker;
    this.handLight.intensity = 0.35 * on * flicker;
    if (!lamp) return;
    this.worldLight.color.copy(lamp.light.color);
    this.worldLight.distance = lamp.light.distance;
    this.handLight.color.copy(lamp.light.color);
    if (this.handLight.parent !== lamp.flame) lamp.flame.add(this.handLight);
    for (const m of lamp.glow) m.emissiveIntensity = lamp.glowBase * flicker;
    this.root.updateMatrixWorld(true);
    lamp.flame.getWorldPosition(this.worldLight.position);
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
