import * as THREE from 'three';

/*
 * Too much rum: it comes back up. A fit runs its course — two dry heaves, the head nodding with each, then
 * the head bent right down and the rum (and what went with it) thrown up in a gush and a dribble after —
 * and the stuff flies: blobs of orange-brown, a few darker chunks, out of the mouth and down under gravity,
 * splattering where they land into a spreading mess that lies there a while (on the deck it lies on the
 * deck, going where the ship goes) and then soaks away.
 *
 * All of it is two instanced meshes of squashed spheres: what flies and what lies ashore in the world's
 * frame, what lies on the deck in the ship's.
 */

const MAX_FLY = 360, MAX_LIE = 520;
/** how long a mess lies (s), and how long it takes to soak away */
const LIE = 40, SOAK = 5;
/** the fit, in seconds from its start: the heaves, the gush, the dribble, the end */
const HEAVES = [0.05, 0.8], GUSH: [number, number] = [1.45, 2.55], DRIBBLE: [number, number] = [2.9, 3.4], END = 4.6;

interface Drop { p: THREE.Vector3; v: THREE.Vector3; s: number; c: THREE.Color }
interface Mess { p: THREE.Vector3; s: number; r: number; c: THREE.Color; age: number; deck: boolean }

export interface VomitHooks {
  /** the fit's sounds: a heave, the gush, the spit at the end */
  sound(kind: 'heave' | 'gush' | 'spit'): void;
  /** a blob landed (a splat, loud for a big one) */
  splat(at: THREE.Vector3, big: boolean): void;
  /** where the ground (or the deck) is under (x, z), and whether that is the deck */
  floor(x: number, z: number): { y: number; deck: boolean };
}

export class Vomit {
  /** in the world: what flies, what lies ashore */
  readonly group = new THREE.Group();
  /** in the ship's frame: what lies on the deck (put this in the boat's root) */
  readonly deckGroup = new THREE.Group();
  /** a fit under way: seconds into it (−1: none) */
  t = -1;
  private readonly fly: THREE.InstancedMesh;
  private readonly lieWorld: THREE.InstancedMesh;
  private readonly lieDeck: THREE.InstancedMesh;
  private readonly drops: Drop[] = [];
  private readonly mess: Mess[] = [];
  private emit = 0;
  private splatT = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();

  constructor(private readonly hooks: VomitHooks, private readonly boat: THREE.Object3D) {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    // wet, glistening; each blob its own shade (instance colour)
    // (glossy, but not a mirror: the sky's reflection would bleach it pale)
    const mat = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, envMapIntensity: 0.04, emissive: new THREE.Color(0.05, 0.02, 0) });
    this.fly = new THREE.InstancedMesh(geo, mat(), MAX_FLY);
    this.lieWorld = new THREE.InstancedMesh(geo, mat(), MAX_LIE);
    this.lieDeck = new THREE.InstancedMesh(geo, mat(), MAX_LIE);
    for (const im of [this.fly, this.lieWorld, this.lieDeck]) {
      im.count = 0;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, new THREE.Color());
    }
    this.group.add(this.fly, this.lieWorld);
    this.deckGroup.add(this.lieDeck);
    this.group.name = 'vomit';
    this.deckGroup.name = 'vomit on deck';
  }

  get active(): boolean {
    return this.t >= 0;
  }

  start(): void {
    if (this.t < 0) this.t = 0;
  }

  /**
   * How the head goes with the fit: a pitch (rad, down −) and a little shake. The game adds it to the look.
   */
  head(time: number): { pitch: number; shake: number } {
    const t = this.t;
    if (t < 0) return { pitch: 0, shake: 0 };
    let pitch = 0;
    for (const h of HEAVES) { const k = (t - h) / 0.5; if (k > 0 && k < 1) pitch -= 0.3 * Math.sin(k * Math.PI); }
    // bent over for the gush and the dribble, then straightening up
    const down = THREE.MathUtils.smoothstep(t, GUSH[0] - 0.25, GUSH[0]) * (1 - THREE.MathUtils.smoothstep(t, DRIBBLE[1], END));
    pitch -= 0.75 * down;
    const shake = (t > GUSH[0] && t < GUSH[1] ? 0.02 : 0.006) * Math.sin(time * 37) * (t < END ? 1 : 0);
    return { pitch, shake };
  }

  /**
   * Once per frame. `mouth` and `ahead` (world): where it comes from and which way the face looks (the
   * stuff flies out along it and down).
   */
  update(dt: number, mouth: THREE.Vector3, ahead: THREE.Vector3): void {
    // ---- the fit ----
    if (this.t >= 0) {
      const was = this.t;
      this.t += dt;
      for (const h of HEAVES) if (was < h && this.t >= h) this.hooks.sound('heave');
      if (was < GUSH[0] && this.t >= GUSH[0]) this.hooks.sound('gush');
      if (was < DRIBBLE[1] + 0.3 && this.t >= DRIBBLE[1] + 0.3) this.hooks.sound('spit');
      const rate = this.t > GUSH[0] && this.t < GUSH[1] ? 320 : this.t > DRIBBLE[0] && this.t < DRIBBLE[1] ? 90 : 0;
      this.emit += rate * dt;
      while (this.emit >= 1) { this.emit--; this.spawn(mouth, ahead, rate > 100); }
      if (this.t > END) this.t = -1;
    }
    this.splatT -= dt;
    // ---- what flies ----
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.v.y -= 9.81 * dt;
      d.v.multiplyScalar(Math.exp(-dt * 0.4));
      d.p.addScaledVector(d.v, dt);
      const f = this.hooks.floor(d.p.x, d.p.z);
      if (d.p.y <= f.y + 0.01) {
        d.p.y = f.y;
        this.land(d, f.deck);
        this.drops.splice(i, 1);
      } else if (d.p.y < f.y - 3) this.drops.splice(i, 1);
    }
    this.fly.count = this.drops.length;
    this.drops.forEach((d, k) => {
      // stretched along its flight
      const sp = d.v.length();
      this.q.setFromUnitVectors(Y, this.v.copy(d.v).divideScalar(sp || 1));
      const st = 1 + Math.min(1.5, sp * 0.25);
      this.m.compose(d.p, this.q, this.v.set(d.s, d.s * st, d.s));
      this.fly.setMatrixAt(k, this.m);
      this.fly.setColorAt(k, d.c);
    });
    this.fly.instanceMatrix.needsUpdate = true;
    if (this.fly.instanceColor) this.fly.instanceColor.needsUpdate = true;
    // ---- what lies: a while, then soaking away ----
    let w = 0, dk = 0;
    for (let i = this.mess.length - 1; i >= 0; i--) {
      const s = this.mess[i];
      s.age += dt;
      if (s.age > LIE + SOAK) { this.mess.splice(i, 1); continue; }
    }
    for (const s of this.mess) {
      const soak = 1 - THREE.MathUtils.smoothstep(s.age, LIE, LIE + SOAK);
      // (spreading a little as it settles)
      const spread = s.s * (1.4 + 1.2 * Math.min(1, s.age / 1.5)) * (0.4 + 0.6 * soak);
      this.q.setFromAxisAngle(Y, s.r);
      this.m.compose(s.p, this.q, this.v.set(spread * 1.3, s.s * 0.08 * soak + 0.001, spread));
      const im = s.deck ? this.lieDeck : this.lieWorld, k = s.deck ? dk++ : w++;
      if (k >= MAX_LIE) continue;
      im.setMatrixAt(k, this.m);
      im.setColorAt(k, s.c);
    }
    this.lieWorld.count = Math.min(MAX_LIE, w);
    this.lieDeck.count = Math.min(MAX_LIE, dk);
    for (const im of [this.lieWorld, this.lieDeck]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  /** a blob out of the mouth: most of it orange-brown, now and then a darker chunk */
  private spawn(mouth: THREE.Vector3, ahead: THREE.Vector3, gush: boolean): void {
    if (this.drops.length >= MAX_FLY) return;
    const out = ahead.clone().setY(Math.min(ahead.y, 0.2)).normalize();
    const speed = (gush ? 2.2 : 0.8) * (0.7 + 0.6 * Math.random());
    const v = out.multiplyScalar(speed).add(new THREE.Vector3((Math.random() - 0.5) * 0.9, (Math.random() - 0.3) * 0.7, (Math.random() - 0.5) * 0.9));
    const chunk = Math.random() < 0.18;
    // (sRGB shades: rum-brown, bile-orange, darker lumps)
    const c = chunk
      ? new THREE.Color().setHSL(0.065 + Math.random() * 0.03, 0.65, 0.2 + Math.random() * 0.06, THREE.SRGBColorSpace)
      : new THREE.Color().setHSL(0.07 + Math.random() * 0.04, 0.85 + Math.random() * 0.15, 0.36 + Math.random() * 0.1, THREE.SRGBColorSpace);
    this.drops.push({ p: mouth.clone().addScaledVector(v, 0.01), v, s: (chunk ? 0.011 : 0.006) * (0.7 + 0.8 * Math.random()), c });
  }

  /** landed: a splat where it hit (in the ship's frame, on the deck) */
  private land(d: Drop, deck: boolean): void {
    const p = d.p.clone();
    if (deck) { this.boat.updateMatrixWorld(); this.boat.worldToLocal(p); }
    this.mess.push({ p, s: d.s * (2.2 + Math.random() * 1.6), r: Math.random() * 6.28, c: d.c.clone().multiplyScalar(0.85), age: 0, deck });
    if (this.mess.length > MAX_LIE * 2) this.mess.shift();
    // (a splat now and then — not one for every drop)
    if (this.splatT <= 0 && Math.random() < 0.08) { this.splatT = 0.09; this.hooks.splat(d.p, d.s > 0.009); }
  }
}

const Y = new THREE.Vector3(0, 1, 0);
