import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { fbm } from '../core/noise';
import { SKULL_ISLAND, terrainHeight } from './WorldGen';

/*
 * The Skull Island's cave (the island itself is in WorldGen: a wooded hill with a level plateau). On the
 * plateau a rock ridge winds west from a cave mouth framed by a great stone skull; inside, a winding
 * passage, dark but for a few torches, runs to a chamber where a chest of gold stands among spilt coins.
 * Five skeleton pirates keep it: they come one after another — the next rises from the floor when the last
 * falls — run at the sailor and cut at him; two or three hits (a ball, the rapier) and one falls apart into
 * a heap of bones. With the guards down, the gold is his: +1000 ducats. Three game days later the dead rise
 * again and the chest is full.
 *
 * Everything hangs on one path, the passage's centre line (a curve on the plateau floor): the tunnel's
 * walls and the ridge round them are swept along it, the torches and the guards stand by it, the guards
 * run along it, and walking is checked against it (inside the passage: free; in the rock: not).
 *
 * Models (npm run optimize-island; see the README): the skull entrance, the skeleton, the torch, the chest
 * and a coin; the rock texture is the blocky rocks'.
 */

const FLOOR = SKULL_ISLAND.flat!.h;
/** the island's middle (set when the island is built: where it lies depends on the world seed) */
const C = new THREE.Vector2();
/** the passage's centre line (m, from the island's middle): outside the mouth → the mouth → … → the chamber's end */
const PATH: [number, number][] = [[42, 3], [21, 0], [13, -4], [5, -1], [-3, 5], [-11, 3], [-16, -3], [-22, -6], [-29, -7]];
/** along the path (m from its start): the mouth, where the chamber opens, its end */
const GUARDS = 5;
/** a guard's life, a ball's and a cut's toll of it (two balls, three cuts), and a guard's cut's toll of the sailor's */
const GUARD_HP = 10, BALL_HURT = 5.5, CUT_HURT = 3.6, THEIR_CUT = 0.05;
const RESPAWN_DAYS = 3;
/** a guard's run (m/s), how far off he stops, his reach; the run's cycle (s) and the moment in it he stands in */
const RUN = 2.6, STOP = 1.2, REACH = 1.9, RUN_CYCLE = 0.7, STANCE = 0.12;
/** (listed in worldState.ts: a new world clears it) */
const KEY = 'lagoon.skull';
/** the two cuts, as where the sword hand goes from the shoulder (m, his frame: +z ahead, +x his left, +y up):
 *  the directions the arm points: from up over his right shoulder down across to low on his left, and the other way */
export const CUT_PATHS: [THREE.Vector3, THREE.Vector3][] = [
  [new THREE.Vector3(-0.4, 0.9, -0.15), new THREE.Vector3(0.45, -0.8, 0.55)],
  [new THREE.Vector3(0.3, 0.9, 0.05), new THREE.Vector3(-0.5, -0.8, 0.55)],
];
const Y = new THREE.Vector3(0, 1, 0);
/** how long the bones of the fallen lie (s, real time), and how long they take to sink away */
const BONES_LIE = 45, BONES_SINK = 4;

interface Sample { p: THREE.Vector3; t: THREE.Vector3; n: THREE.Vector3; s: number }
type GuardState = 'waiting' | 'rising' | 'chasing' | 'dying' | 'dead';
interface Guard {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  run: THREE.AnimationAction;
  /** the sword arm: the upper arm, the forearm, the hand's bone (the sword's handle) */
  arm: THREE.Bone | null;
  fore: THREE.Bone | null;
  hand: THREE.Bone | null;
  /** the blade's way in the hand bone's frame (see bladeAxis) */
  blade: THREE.Vector3 | null;
  /** which of the two cuts: 0 high right → low left, 1 high left → low right (his own right and left) */
  cut: number;
  /** his heading (rad), turned toward the sailor at a man's pace */
  yaw: number;
  /** till his next rasping breath as he runs (s) */
  growlT: number;
  /** out of the passage, chasing him across the island: where he is (world x, z); null in the passage */
  free: THREE.Vector2 | null;
  mats: THREE.MeshStandardMaterial[];
  state: GuardState;
  s: number;
  lat: number;
  hp: number;
  t: number;
  cool: number;
  /** the cut: 0 none, rising to 1 through the wind-up and the blow */
  swing: number;
  struck: boolean;
  flash: number;
  spawnS: number;
}

export interface SkullHooks {
  say(text: string, seconds: number): void;
  /** the sailor was cut: lose `amount` (0–1) of his life */
  hurt(amount: number): void;
  gold(n: number): void;
  sound(kind: 'boneHit' | 'collapse' | 'swing' | 'rise' | 'coins', at: THREE.Vector3): void;
  /** a guard's voice (`echo`: in the cave) */
  voice(kind: 'roar' | 'rasp' | 'grunt', at: THREE.Vector3, echo: boolean): void;
}

export class SkullIsland {
  readonly group = new THREE.Group();
  /** the torches' light: a few lights moved to the torches nearest the sailor (see update) */
  readonly lights: THREE.PointLight[] = [];
  loaded = false;
  /** 0 outside … 1 deep in the passage: how dark it is (the game dims the sky's light by it) */
  dark = 0;
  /** the sailor is in the passage */
  inside = false;
  private readonly samples: Sample[] = [];
  private sMouth = 0;
  /** along the path: just out of the skull's mouth (where a guard leaves the passage to chase him outside) */
  private sExit = 0;
  /** the stone skull before the mouth: its depth along the path, half its width, half its doorway's */
  private skullDepth = 0;
  private skullHalf = 0;
  private doorHalf = 1.4;
  private sRoom = 0;
  private sEnd = 0;
  private readonly torches: { flame: THREE.Vector3; sprite: THREE.Sprite; phase: number }[] = [];
  private readonly guards: Guard[] = [];
  private chestAt = new THREE.Vector3();
  private coins: THREE.InstancedMesh[] = [];
  private readonly bones: THREE.InstancedMesh;
  private readonly bonePieces: { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3; rest: boolean; age: number }[] = [];
  private readonly shards: THREE.InstancedMesh;
  private readonly shardList: { p: THREE.Vector3; v: THREE.Vector3; life: number }[] = [];
  private state = { days: 0, spawnDay: 0, dead: Array(GUARDS).fill(false) as boolean[], looted: false };
  private next = 0;
  private saveT = 0;
  private saidGuarded = -1e9;
  private time = 0;
  private readonly v = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly here = { p: new THREE.Vector3(), t: new THREE.Vector3(), n: new THREE.Vector3() };
  /** debugging: every swinging guard held at this point of his cut (0–1), or null */
  debugSwing: number | null = null;

  constructor(private readonly hooks: SkullHooks) {
    this.group.name = 'skull island';
    C.set(SKULL_ISLAND.x, SKULL_ISLAND.z);
    // the path, sampled every half metre along its length
    const curve = new THREE.CatmullRomCurve3(PATH.map(([x, z]) => new THREE.Vector3(C.x + x, FLOOR, C.y + z)), false, 'centripetal');
    const len = curve.getLength(), N = Math.ceil(len / 0.5);
    const pts = curve.getSpacedPoints(N);
    let s = 0;
    pts.forEach((p, i) => {
      if (i) s += p.distanceTo(pts[i - 1]);
      const t = curve.getTangentAt(i / N).setY(0).normalize();
      this.samples.push({ p, t, n: new THREE.Vector3(-t.z, 0, t.x), s });
    });
    const at = (x: number, z: number) => this.nearest(C.x + x, C.y + z).s;
    this.sMouth = at(PATH[1][0], PATH[1][1]);
    this.sRoom = at(PATH[6][0], PATH[6][1]);
    this.sEnd = s;
    // bones of the fallen, and the shards a hit knocks off
    const ivory = new THREE.MeshStandardMaterial({ color: 0xd8ccb0, roughness: 0.75 });
    this.bones = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.03, 0.26, 2, 6), ivory, GUARDS * 22);
    this.bones.count = 0;
    this.bones.frustumCulled = false;
    this.shards = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.02, 0.025), ivory, 64);
    this.shards.count = 0;
    this.shards.frustumCulled = false;
    this.group.add(this.bones, this.shards);
    for (let k = 0; k < 3; k++) {
      const l = new THREE.PointLight(0xff9a48, 0, 20, 2);
      this.lights.push(l);
    }
    this.loadState();
  }

  // ------------------------------------------------------------------ the path

  /** the sample nearest (x, z), its distance off the path (signed: + to the path's left) and along it */
  private nearest(x: number, z: number): { i: number; d: number; lat: number; s: number } {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const p = this.samples[i].p, d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const sm = this.samples[best];
    const lat = (x - sm.p.x) * sm.n.x + (z - sm.p.z) * sm.n.z;
    return { i: best, d: Math.sqrt(bd), lat, s: sm.s };
  }

  private sample(s: number): Sample {
    const i = THREE.MathUtils.clamp(Math.round((s / this.sEnd) * (this.samples.length - 1)), 0, this.samples.length - 1);
    return this.samples[i];
  }

  /** the path at s, between its samples (for what moves along it: a guard mustn't hop from sample to sample) */
  private lerpAt(s: number, out: { p: THREE.Vector3; t: THREE.Vector3; n: THREE.Vector3 }): void {
    const f = THREE.MathUtils.clamp((s / this.sEnd) * (this.samples.length - 1), 0, this.samples.length - 1);
    const i = Math.min(Math.floor(f), this.samples.length - 2), k = f - i;
    const a = this.samples[i], b = this.samples[i + 1];
    out.p.lerpVectors(a.p, b.p, k);
    out.t.lerpVectors(a.t, b.t, k).normalize();
    out.n.set(-out.t.z, 0, out.t.x);
  }

  /** the passage's half-width, its walls' height and its ceiling's, at s (the chamber is wider and higher) */
  private profile(s: number): { hw: number; wall: number; top: number; out: number } {
    const k = THREE.MathUtils.smoothstep(s, this.sRoom - 2, this.sRoom + 4);
    const hw = 2.1 + 2.9 * k, wall = 2.3 + 0.9 * k, top = wall + 2.0 + 0.8 * k;
    return { hw, wall, top, out: hw + 3.6 + 1.2 * fbm(s / 9, 3.1, 2) };
  }

  /** is (x, z) inside the passage (or off the island's rocks altogether)? For walking and for balls */
  private where(x: number, z: number): 'open' | 'passage' | 'rock' {
    if (Math.hypot(x - C.x, z - C.y) > 48) return 'open';
    const n = this.nearest(x, z);
    // the stone skull: its doorway is the way in, the rest of it is stone
    if (n.s < this.sMouth - 0.3 && n.s > this.sMouth - this.skullDepth) return Math.abs(n.lat) < this.doorHalf ? 'open' : Math.abs(n.lat) < this.skullHalf ? 'rock' : 'open';
    if (n.s < this.sMouth - 0.3) return 'open';
    const pr = this.profile(n.s);
    // past the chamber's end wall
    const last = this.samples[this.samples.length - 1];
    if (n.i === this.samples.length - 1 && (x - last.p.x) * last.t.x + (z - last.p.z) * last.t.z > -0.4) return n.d < pr.out + 1 ? 'rock' : 'open';
    if (n.d < pr.hw - 0.3) return 'passage';
    return n.d < pr.out + 0.8 ? 'rock' : 'open';
  }

  /** for the walker: can't step here (the rock of the ridge) */
  blocked(x: number, z: number): boolean {
    if (!this.loaded) return false;
    if (this.where(x, z) === 'rock') return true;
    // nor through a guard
    for (const g of this.guards) if ((g.state === 'chasing' || g.state === 'rising') && Math.hypot(g.root.position.x - x, g.root.position.z - z) < 0.55) return true;
    return false;
  }

  // ------------------------------------------------------------------ building it

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const get = (n: string) => loader.loadAsync(`assets/${n}.glb`);
    const [rocks, entrance, skeleton, torch, chest, coinA, coinB] = await Promise.all([
      get('island/rocks'), get('island/cave_entrance'), get('island/skeleton'), get('island/torch'), get('island/chest'), get('items/coin'), get('island/coin2')]);
    // the rock: the blocky rocks' texture, on everything the passage is made of
    let rockMap: THREE.Texture | null = null;
    rocks.scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m?.map && !rockMap) rockMap = m.map; });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a7a68, roughness: 0.95, side: THREE.DoubleSide, envMapIntensity: 0.15 });
    if (rockMap) { const t = (rockMap as THREE.Texture).clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; rockMat.map = t; }
    this.buildPassage(rockMat);
    this.placeEntrance(entrance.scene);
    this.placeRocks(rocks.scene);
    this.placeTorches(torch.scene);
    this.placeChest(chest.scene, coinA.scene, coinB.scene);
    this.makeGuards(skeleton);
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o !== this.bones && o !== this.shards) { o.castShadow = true; o.receiveShadow = true; } });
    this.loaded = true;
    this.respawnIfDue(true);
  }

  /** the passage (its floor, walls and vault, seen from within) and the ridge of rock over it, swept along the path */
  private buildPassage(mat: THREE.Material): void {
    const i0 = this.samples.findIndex((q) => q.s >= this.sMouth);
    const inner: number[] = [], outer: number[] = [], uvI: number[] = [], uvO: number[] = [];
    const ringIn = (s: number) => {
      const { hw, wall, top } = this.profile(s);
      const r: [number, number][] = [];
      for (let k = 0; k <= 4; k++) r.push([hw - (2 * hw * k) / 4, 0]);                       // floor, right → left
      for (let k = 1; k <= 3; k++) r.push([-hw, (wall * k) / 3]);                              // left wall
      for (let k = 1; k < 10; k++) { const a = Math.PI - (Math.PI * k) / 10; r.push([hw * Math.cos(a), wall + (top - wall) * Math.sin(a)]); }
      for (let k = 0; k <= 3; k++) r.push([hw, wall - (wall * k) / 3]);                         // right wall
      return r;
    };
    const ringOut = (s: number) => {
      const { out, top } = this.profile(s);
      const r: [number, number][] = [];
      for (let k = 0; k <= 12; k++) {
        const a = (Math.PI * k) / 12, j = 1 + 0.18 * (fbm(s / 5 + k * 0.7, k * 1.3, 2) - 0.5);
        r.push([out * Math.cos(a) * j, -0.6 + (top + 3.5 + 2.5 * fbm(s / 11, 7.7, 2)) * Math.pow(Math.sin(a), 0.75) * j]);
      }
      return r;
    };
    // (the rough walls: pushed in and out a little, the floor left flat)
    const rough = (s: number, k: number, y: number) => (y > 0.05 ? 0.28 * (fbm(s / 2.2 + k * 0.37, y / 1.7, 3) - 0.5) : 0);
    const put = (arr: number[], uv: number[], sm: Sample, x: number, y: number, u: number) => {
      arr.push(sm.p.x + sm.n.x * x, FLOOR + 0.04 + y, sm.p.z + sm.n.z * x);
      uv.push(u / 3, sm.s / 3);
    };
    const rows = this.samples.slice(i0);
    for (const sm of rows) {
      let u = 0, prev: [number, number] | null = null;
      ringIn(sm.s).forEach(([x, y], k) => {
        const d = rough(sm.s, k, y), len = Math.hypot(x, y - 1) || 1;
        if (prev) u += Math.hypot(x - prev[0], y - prev[1]);
        prev = [x, y];
        put(inner, uvI, sm, x + (x / len) * d, y + ((y - 1) / len) * d, u);
      });
      u = 0; prev = null;
      ringOut(sm.s).forEach(([x, y]) => { if (prev) u += Math.hypot(x - prev[0], y - prev[1]); prev = [x, y]; put(outer, uvO, sm, x, y, u); });
    }
    const strip = (pos: number[], uv: number[], per: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const idx: number[] = [];
      for (let r = 0; r < rows.length - 1; r++) for (let k = 0; k < per - 1; k++) {
        const a = r * per + k, b = a + 1, c = a + per, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      g.setIndex(idx);
      g.computeVertexNormals();
      return new THREE.Mesh(g, mat);
    };
    this.group.add(strip(inner, uvI, ringIn(0).length), strip(outer, uvO, ringOut(0).length));
    // the mouth: the face of the ridge round the opening; the chamber's end: its wall, and the ridge's
    const face = (s: number, withHole: boolean) => {
      const sm = this.sample(s);
      const o = ringOut(s), shape = new THREE.Shape(o.map(([x, y]) => new THREE.Vector2(x, y)));
      if (withHole) shape.holes.push(new THREE.Path(ringIn(s).slice(4).map(([x, y]) => new THREE.Vector2(x, y)).reverse()));
      const g = new THREE.ShapeGeometry(shape);
      const p = g.getAttribute('position');
      const uv: number[] = [];
      for (let k = 0; k < p.count; k++) {
        const x = p.getX(k), y = p.getY(k);
        p.setXYZ(k, sm.p.x + sm.n.x * x, FLOOR + 0.04 + y, sm.p.z + sm.n.z * x);
        uv.push(x / 3, y / 3);
      }
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      this.group.add(new THREE.Mesh(g, mat));
    };
    face(this.samples[i0].s, true);
    face(this.sEnd, false);
  }

  /** the blocky rocks, heaped along the ridge's flanks (clear of the passage) */
  private placeRocks(model: THREE.Object3D): void {
    const spots: [number, number, number, number][] = [[12, 9, 0.02, 0.4], [-4, -9, 0.022, 2.1], [-20, 7, 0.018, 3.6], [2, 12, 0.016, 5], [-26, -14, 0.02, 1.2], [16, -12, 0.017, 4.4]];
    for (const [x, z, sc, rot] of spots) {
      const r = model.clone(true);
      r.scale.setScalar(sc);
      r.rotation.y = rot;
      r.position.set(C.x + x, FLOOR - 0.8, C.y + z);
      this.group.add(r);
      // (a block lying across the way in, or into the passage, is left out)
      r.updateMatrixWorld(true);
      r.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const b = new THREE.Box3().setFromObject(o);
        for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
          const x2 = b.min.x + ((b.max.x - b.min.x) * i) / 6, z2 = b.min.z + ((b.max.z - b.min.z) * j) / 6;
          const n = this.nearest(x2, z2);
          if (n.s < this.sMouth + 1 ? Math.abs(n.lat) < this.skullHalf + 1 && n.s > this.sMouth - this.skullDepth - 8 : n.d < this.profile(n.s).hw + 0.5) { o.visible = false; return; }
        }
      });
    }
  }

  /** the stone skull over the mouth, facing out along the path */
  private placeEntrance(model: THREE.Object3D): void {
    const sm = this.sample(this.sMouth);
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    // ~9 m across; its doorway leads straight into the passage's mouth
    const k = 9 / size.x;
    this.skullDepth = size.z * k;
    this.sExit = Math.max(0, this.sMouth - this.skullDepth - 1.5);
    this.skullHalf = (size.x * k) / 2;
    const holder = new THREE.Group();
    model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    holder.add(model);
    holder.scale.setScalar(k);
    // (the model's face looks along +z: turn it to look back down the path, out of the mouth)
    holder.rotation.y = Math.atan2(-sm.t.x, -sm.t.z);
    holder.position.set(sm.p.x - sm.t.x * (this.skullDepth * 0.45), FLOOR - 0.6, sm.p.z - sm.t.z * (this.skullDepth * 0.45));
    this.group.add(holder);
  }

  private placeTorches(model: THREE.Object3D): void {
    // (the head glows by its own texture; a material that lost that map keeps a plain, dim glow)
    model.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m?.isMeshStandardMaterial && !m.emissiveMap) m.emissive.setRGB(0, 0, 0);
      else if (m?.emissiveMap) m.emissiveIntensity = 2.5;
    });
    const glow = new THREE.SpriteMaterial({ map: flameTexture(), color: new THREE.Color(4, 2.2, 0.9), blending: THREE.AdditiveBlending, depthWrite: false });
    const along = [this.sMouth + 4, this.sMouth + 15, this.sMouth + 26, this.sMouth + 37, this.sRoom + 5, this.sEnd - 1.2];
    along.forEach((s, k) => {
      const sm = this.sample(s), pr = this.profile(s), side = k % 2 ? 1 : -1;
      const t = model.clone(true);
      const at = sm.p.clone().addScaledVector(sm.n, side * (pr.hw - 0.3));
      t.position.set(at.x, FLOOR + 0.02, at.z);
      // (leaning on the wall, a little toward the passage)
      t.rotation.set(0, 0, 0);
      t.rotateOnWorldAxis(sm.t, side * 0.22);
      this.group.add(t);
      t.updateMatrixWorld(true);
      const flame = new THREE.Vector3(0.01, 1.32, -0.05).applyMatrix4(t.matrixWorld);
      const sprite = new THREE.Sprite(glow);
      sprite.position.copy(flame);
      sprite.scale.setScalar(0.5);
      this.group.add(sprite);
      this.torches.push({ flame, sprite, phase: k * 1.7 });
    });
  }

  /** the chest at the chamber's end, looking back down the passage, and the coins spilt round it */
  private placeChest(model: THREE.Object3D, coinA: THREE.Object3D, coinB: THREE.Object3D): void {
    const sm = this.sample(this.sEnd - 2.2);
    this.chestAt.set(sm.p.x, FLOOR, sm.p.z);
    const box = new THREE.Box3().setFromObject(model);
    model.position.y -= box.min.y;
    const holder = new THREE.Group();
    holder.add(model);
    holder.scale.setScalar(1.1);
    holder.rotation.y = Math.atan2(-sm.t.x, -sm.t.z);
    holder.position.copy(this.chestAt).setY(FLOOR + 0.04);
    this.group.add(holder);
    // the coins: instanced, lying about on the floor in front of and beside the chest
    const first = (o: THREE.Object3D) => { let m: THREE.Mesh | null = null; o.traverse((x) => { if ((x as THREE.Mesh).isMesh && !m) m = x as THREE.Mesh; }); return m as THREE.Mesh | null; };
    const rnd = mulberry(99);
    const lay = (mesh: THREE.Mesh | null, n: number, scale: number, lift: number) => {
      if (!mesh) return;
      mesh.updateWorldMatrix(true, false);
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, n);
      const base = mesh.matrixWorld.clone();
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2, r = 0.5 + rnd() * 2.2;
        const x = this.chestAt.x + Math.cos(a) * r - sm.t.x * 0.8, z = this.chestAt.z + Math.sin(a) * r - sm.t.z * 0.8;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.3, rnd() * 6.28, (rnd() - 0.5) * 0.3));
        this.m.compose(new THREE.Vector3(x, FLOOR + 0.05 + lift, z), q, new THREE.Vector3(scale, scale, scale)).multiply(base);
        inst.setMatrixAt(k, this.m);
      }
      inst.frustumCulled = false;
      this.coins.push(inst);
      this.group.add(inst);
    };
    // (the ducat model lies on edge: turn it flat first)
    const a = first(coinA);
    if (a) {
      a.geometry = a.geometry.clone().applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      // (its texture is dark bronze: gilded, as a ducat should shine in the torchlight)
      const mm = (a.material as THREE.MeshStandardMaterial).clone();
      mm.color.setRGB(2.4, 1.75, 0.7); mm.metalness = 0.85; mm.roughness = Math.min(mm.roughness, 0.45);
      a.material = mm;
    }
    lay(a, 34, 0.16, 0.0);
    const b = first(coinB);
    if (b) { const mm = b.material as THREE.MeshStandardMaterial; mm.alphaTest = 0.5; mm.transparent = false; }
    lay(b, 46, 1, 0.0);
  }

  private makeGuards(gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }): void {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const k = 1.85 / (box.max.y - box.min.y);
    const clip = gltf.animations.find((a) => a.name.includes('Running')) ?? gltf.animations[0];
    const spots = [this.sMouth + 11, this.sMouth + 21, this.sMouth + 31, this.sMouth + 41, this.sRoom + 3];
    for (let n = 0; n < GUARDS; n++) {
      const model = cloneSkinned(gltf.scene);
      model.position.y = -box.min.y;
      const root = new THREE.Group();
      const inner = new THREE.Group();
      inner.add(model);
      inner.scale.setScalar(k);
      root.add(inner);
      const mats: THREE.MeshStandardMaterial[] = [];
      model.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isMesh) return;
        m.frustumCulled = false;
        m.material = (m.material as THREE.MeshStandardMaterial).clone();
        mats.push(m.material as THREE.MeshStandardMaterial);
      });
      const mixer = new THREE.AnimationMixer(model);
      const run = mixer.clipAction(clip);
      run.play();
      let arm: THREE.Bone | null = null, fore: THREE.Bone | null = null, hand: THREE.Bone | null = null;
      model.traverse((o) => { if ((o as THREE.Bone).isBone) { if (o.name.startsWith('R_shoulder')) arm = o as THREE.Bone; if (o.name.startsWith('R_forarm')) fore = o as THREE.Bone; if (o.name.startsWith('HandleBone')) hand = o as THREE.Bone; } });
      root.visible = false;
      this.group.add(root);
      this.guards.push({ root, mixer, run, arm, mats, fore, hand, blade: hand ? bladeAxis(model, hand) : null, cut: 0, yaw: 0, free: null, growlT: 0, state: 'waiting', s: spots[n], lat: 0, hp: GUARD_HP, t: 0, cool: 1, swing: 0, struck: false, flash: 0, spawnS: spots[n] });
    }
  }

  // ------------------------------------------------------------------ the game

  /** where the sailor stands in the passage (null: not in it) */
  private inPassage(x: number, z: number): { s: number; lat: number } | null {
    if (!this.loaded || this.where(x, z) !== 'passage') return null;
    const n = this.nearest(x, z);
    return { s: n.s, lat: n.lat };
  }

  /**
   * Once per frame. `feet`: where the sailor stands (null aboard); `hours`: game hours gone by since the
   * last frame (the respawn clock); `eye` for the torch lights.
   */
  update(dt: number, feet: THREE.Vector3 | null, eye: THREE.Vector3, hours: number): void {
    if (!this.loaded) return;
    this.time += dt;
    this.state.days += hours / 24;
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = 5; this.saveState(); }
    const far = eye.distanceTo(this.v.set(C.x, FLOOR, C.y)) > 700;
    this.group.visible = !far;
    const here = feet ? this.inPassage(feet.x, feet.z) : null;
    this.inside = !!here;
    const wantDark = here ? THREE.MathUtils.smoothstep(here.s, this.sMouth + 1, this.sMouth + 9) : 0;
    this.dark += (wantDark - this.dark) * Math.min(1, dt * 2.5);
    // (not with him in the passage, nor with a guard up and after him)
    if (!here && !this.guards.some((g) => g.state === 'chasing' || g.state === 'rising')) this.respawnIfDue(false);
    this.updateTorches(eye, far);
    this.updateGuards(dt, feet, here);
    this.updateBones(dt);
    // the treasure: his, once the guards are down
    if (feet && !this.state.looted && Math.hypot(feet.x - this.chestAt.x, feet.z - this.chestAt.z) < 2.4) {
      if (this.state.dead.every(Boolean)) {
        this.state.looted = true;
        for (const c of this.coins) c.visible = false;
        this.hooks.sound('coins', this.chestAt);
        this.hooks.gold(1000);
        this.hooks.say('Skarb kapitana! +1000 dukatów', 4);
        this.saveState();
      } else if (this.time - this.saidGuarded > 8) {
        this.saidGuarded = this.time;
        this.hooks.say('Strażnicy skarbu jeszcze nie spoczęli…', 3);
      }
    }
  }

  private updateTorches(eye: THREE.Vector3, far: boolean): void {
    for (const t of this.torches) {
      const f = 0.82 + 0.1 * Math.sin(this.time * 9 + t.phase) + 0.08 * Math.sin(this.time * 23 + t.phase * 3);
      t.sprite.scale.set(0.42 * f, 0.55 * f, 1);
    }
    // the nearest torches get the lights
    const byDist = far ? [] : [...this.torches].sort((a, b) => a.flame.distanceToSquared(eye) - b.flame.distanceToSquared(eye));
    this.lights.forEach((l, k) => {
      const t = byDist[k];
      if (!t) { l.intensity = 0; return; }
      l.position.copy(t.flame);
      const f = 0.85 + 0.1 * Math.sin(this.time * 11 + t.phase) + 0.05 * Math.sin(this.time * 27 + t.phase);
      l.intensity = 70 * f;
    });
  }

  private updateGuards(dt: number, feet: THREE.Vector3 | null, here: { s: number; lat: number } | null): void {
    // the next one rises when the one before is down (and he has come in)
    const cur = this.guards[this.next];
    if (cur && cur.state === 'waiting' && !this.state.dead[this.next] && here && here.s > this.sMouth + 3) {
      cur.state = 'rising';
      cur.t = 0;
      cur.s = Math.max(cur.spawnS, here.s + 6);
      cur.s = Math.min(cur.s, this.sEnd - 3);
      cur.root.visible = true;
      this.hooks.sound('rise', cur.root.position);
    }
    for (const g of this.guards) {
      if (g.state === 'waiting' || g.state === 'dead') continue;
      g.t += dt;
      g.flash = Math.max(0, g.flash - dt * 4);
      for (const m of g.mats) m.emissive.setRGB(g.flash * 0.9, g.flash * 0.25, g.flash * 0.1);
      const sm = this.sample(g.s);
      let rise = 0;
      if (g.state === 'rising') {
        rise = 1 - Math.min(1, g.t / 1.3);
        g.run.timeScale = 0;
        g.run.time = STANCE;
        if (g.t > 1.3) { g.state = 'chasing'; g.growlT = 0.7 + Math.random() * 0.6; this.hooks.voice('roar', g.root.position, !g.free); }
      } else if (g.state === 'chasing') {
        g.cool -= dt;
        let moving = false;
        if (feet && g.swing === 0) moving = here ? this.chaseInside(g, here, dt) : this.chaseOutside(g, feet, dt);
        // running, or standing his ground: the stride runs on to a stance (feet apart) and holds there
        const phase = g.run.time % RUN_CYCLE;
        g.run.timeScale = moving || Math.abs(phase - STANCE) > 0.04 ? 1.1 : 0;
        const d = feet ? Math.hypot(feet.x - g.root.position.x, feet.z - g.root.position.z) : 99;
        // running at him and near: a rasping breath now and then
        g.growlT -= dt;
        if (moving && d < 16 && g.growlT <= 0) { g.growlT = 2 + Math.random() * 2.2; this.hooks.voice('rasp', g.root.position, !g.free); }
        if (g.swing === 0 && g.cool <= 0 && d < REACH) {
          g.swing = 0.001; g.struck = false; g.cut = 1 - g.cut;
          this.hooks.sound('swing', g.root.position);
          this.hooks.voice('grunt', g.root.position, !g.free);
          g.growlT = Math.max(g.growlT, 1.2);
        }
        if (g.swing > 0) {
          g.swing = this.debugSwing ?? g.swing + dt / 0.85;
          // the blow lands as the blade comes down through the middle of the cut, if he is still in reach
          if (!g.struck && g.swing > 0.6) {
            g.struck = true;
            const d2 = feet ? Math.hypot(feet.x - g.root.position.x, feet.z - g.root.position.z) : 99;
            if (d2 < REACH + 0.4) this.hooks.hurt(THEIR_CUT);
          }
          if (g.swing >= 1) { g.swing = 0; g.cool = 0.7 + Math.random() * 0.6; }
        }
      } else if (g.state === 'dying') {
        rise = 0;
        const k = Math.min(1, g.t / 0.45);
        g.root.scale.set(1, 1 - 0.9 * k, 1);
        if (g.t > 0.45) { g.state = 'dead'; g.root.visible = false; }
      }
      if (g.free) g.root.position.set(g.free.x, terrainHeight(g.free.x, g.free.y) + 0.04 - rise * 1.9, g.free.y);
      else {
        const at = this.here;
        this.lerpAt(g.s, at);
        g.root.position.set(at.p.x + at.n.x * g.lat, FLOOR + 0.04 - rise * 1.9, at.p.z + at.n.z * g.lat);
      }
      // face him (or down the passage toward the mouth), turning at a man's pace
      const look = feet ? this.v.set(feet.x - g.root.position.x, 0, feet.z - g.root.position.z) : this.v.copy(sm.t).negate();
      if (look.lengthSq() > 1e-4) {
        const want = Math.atan2(look.x, look.z), d = Math.atan2(Math.sin(want - g.yaw), Math.cos(want - g.yaw));
        g.yaw += g.state === 'rising' ? d : THREE.MathUtils.clamp(d, -6 * dt, 6 * dt);
        g.root.rotation.y = g.yaw;
      }
      g.mixer.update(dt);
      if (g.swing > 0) this.cutPose(g);
    }
  }

  /** in the passage he runs at him along it (and toward his side of it); true while running */
  private chaseInside(g: Guard, here: { s: number; lat: number }, dt: number): boolean {
    if (g.free) {
      // coming back in after him: to the way in, then along the passage
      const e = this.sample(this.sExit).p;
      if (!this.runTo(g, e.x, e.z, 0.4, dt)) { g.free = null; g.s = this.sExit; g.lat = 0; }
      return true;
    }
    const ds = here.s - g.s, gap = Math.abs(ds);
    const pr = this.profile(g.s);
    g.lat += (THREE.MathUtils.clamp(here.lat, -(pr.hw - 0.6), pr.hw - 0.6) - g.lat) * Math.min(1, dt * 3);
    // (a few cm of slack, or he would twitch forward every frame, running on the spot)
    const go = gap > STOP + 0.08 ? Math.sign(ds) * Math.min(RUN * dt, gap - STOP) : 0;
    g.s = THREE.MathUtils.clamp(g.s + go, this.sExit, this.sEnd - 1);
    return go !== 0;
  }

  /**
   * He has gone out: the guard that has risen goes after him — out along the passage and through the skull's
   * mouth, then across the island straight at him, round the rocks — until one of them is dead.
   */
  private chaseOutside(g: Guard, feet: THREE.Vector3, dt: number): boolean {
    if (!g.free) {
      if (g.s > this.sExit + 0.05) {
        g.lat += (0 - g.lat) * Math.min(1, dt * 3);
        g.s = Math.max(this.sExit, g.s - RUN * dt);
        return true;
      }
      const p = this.sample(this.sExit).p;
      g.free = new THREE.Vector2(p.x, p.z);
    }
    return this.runTo(g, feet.x, feet.z, STOP, dt);
  }

  /** in the open: a step toward (x, z), stopping `stop` short; sliding round rock, never into the sea. False: there */
  private runTo(g: Guard, x: number, z: number, stop: number, dt: number): boolean {
    const f = g.free!, dx = x - f.x, dz = z - f.y, d = Math.hypot(dx, dz);
    if (d <= stop + 0.08) return false;
    const step = Math.min(RUN * dt, d - stop), ux = dx / d, uz = dz / d;
    const ok = (px: number, pz: number) => this.where(px, pz) !== 'rock' && terrainHeight(px, pz) > -0.4;
    // straight on, or veering either way round what is in the way
    for (const a of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const c = Math.cos(a), s = Math.sin(a), vx = ux * c - uz * s, vz = ux * s + uz * c;
      if (ok(f.x + vx * step, f.y + vz * step)) { f.x += vx * step; f.y += vz * step; return true; }
    }
    return false;
  }

  private cutPose(g: Guard): void {
    if (g.arm && g.fore && g.hand) swingArm(g.root, g.arm, g.fore, g.hand, g.yaw, g.swing, g.cut, g.blade ?? undefined);
  }

  /** a ball from a to b: into a guard (true, and where), or into the passage's rock */
  shoot(a: THREE.Vector3, b: THREE.Vector3): { at: THREE.Vector3; kind: 'bone' | 'land' } | null {
    if (!this.loaded || Math.hypot(a.x - C.x, a.z - C.y) > 400) return null;
    for (const g of this.guards) {
      if (g.state !== 'chasing' && g.state !== 'rising') continue;
      // the guard as an upright capsule: its axis from the hips to the head
      const p = g.root.position, lo = this.v.set(p.x, p.y + 0.35, p.z), hi = new THREE.Vector3(p.x, p.y + 1.65, p.z);
      const q = closestSegments(a, b, lo, hi);
      if (q.dist < 0.32) { this.hit(g, BALL_HURT, q.onA, b.clone().sub(a).normalize()); return { at: q.onA, kind: 'bone' }; }
    }
    // the walls: a ball leaving the passage into rock
    if (this.where(b.x, b.z) === 'rock' && this.where(a.x, a.z) === 'passage' && b.y < FLOOR + 6) return { at: b.clone(), kind: 'land' };
    return null;
  }

  /** a cut of the rapier from the eye along `dir`: the guard in reach before him, if any */
  cut(eye: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
    if (!this.loaded) return null;
    for (const g of this.guards) {
      if (g.state !== 'chasing') continue;
      const to = g.root.position.clone().setY(g.root.position.y + 1.1).sub(eye);
      const d = to.length();
      if (d > 2.4) continue;
      const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize(), toF = to.clone().setY(0).normalize();
      if (flat.dot(toF) < Math.cos(0.9)) continue;
      const at = eye.clone().addScaledVector(to, 0.8);
      this.hit(g, CUT_HURT, at, flat);
      return at;
    }
    return null;
  }

  private hit(g: Guard, hurt: number, at: THREE.Vector3, dir: THREE.Vector3): void {
    g.hp -= hurt;
    g.flash = 1;
    this.hooks.sound('boneHit', at);
    for (let k = 0; k < 7; k++) this.shardList.push({ p: at.clone(), v: new THREE.Vector3(dir.x * 1.5 + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, dir.z * 1.5 + (Math.random() - 0.5) * 3), life: 0.6 + Math.random() * 0.4 });
    // knocked back a step
    const sm = this.sample(g.s);
    g.s = THREE.MathUtils.clamp(g.s + Math.sign(dir.x * sm.t.x + dir.z * sm.t.z) * 0.45, this.sMouth + 1, this.sEnd - 1);
    g.swing = 0;
    g.cool = Math.max(g.cool, 0.5);
    if (g.hp <= 0) this.fall(g);
  }

  /** down, and falling apart: a heap of bones where he stood */
  private fall(g: Guard): void {
    g.state = 'dying';
    g.t = 0;
    const i = this.guards.indexOf(g);
    this.state.dead[i] = true;
    this.next = this.state.dead.findIndex((d) => !d);
    if (this.next < 0) this.next = GUARDS;
    this.hooks.sound('collapse', g.root.position);
    const p = g.root.position;
    for (let k = 0; k < 22; k++) {
      const h = 0.2 + Math.random() * 1.5;
      this.bonePieces.push({
        p: new THREE.Vector3(p.x + (Math.random() - 0.5) * 0.4, FLOOR + h, p.z + (Math.random() - 0.5) * 0.4),
        v: new THREE.Vector3((Math.random() - 0.5) * 1.6, Math.random() * 0.8, (Math.random() - 0.5) * 1.6),
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
        w: new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10), rest: false, age: 0,
      });
    }
    this.saveState();
    if (this.next >= GUARDS) this.hooks.say('Ostatni strażnik padł. Skarb czeka w komnacie.', 4);
  }

  private updateBones(dt: number): void {
    const one = new THREE.Vector3(1, 1, 1), dq = new THREE.Quaternion();
    // the bones of the fallen lie a while, then sink into the floor and are gone
    for (let i = this.bonePieces.length - 1; i >= 0; i--) {
      const b = this.bonePieces[i];
      b.age += dt;
      if (b.age > BONES_LIE) { b.rest = true; b.p.y -= (0.12 / BONES_SINK) * dt; }
      if (b.age > BONES_LIE + BONES_SINK) this.bonePieces.splice(i, 1);
    }
    this.bonePieces.forEach((b, k) => {
      if (!b.rest) {
        b.v.y -= 9.81 * dt;
        b.p.addScaledVector(b.v, dt);
        dq.setFromAxisAngle(this.v.copy(b.w).normalize(), b.w.length() * dt);
        b.q.premultiply(dq);
        if (b.p.y < FLOOR + 0.1) {
          b.p.y = FLOOR + 0.1;
          b.v.set(b.v.x * 0.4, -b.v.y * 0.2, b.v.z * 0.4);
          b.w.multiplyScalar(0.4);
          // lying down: along the floor
          if (b.v.length() < 0.3) { b.rest = true; b.q.setFromEuler(new THREE.Euler(Math.PI / 2, Math.random() * 6.28, 0)); }
        }
      }
      this.bones.setMatrixAt(k, this.m.compose(b.p, b.q, one));
    });
    this.bones.count = this.bonePieces.length;
    this.bones.instanceMatrix.needsUpdate = true;
    for (let i = this.shardList.length - 1; i >= 0; i--) {
      const s = this.shardList[i];
      s.life -= dt;
      s.v.y -= 9.81 * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < FLOOR + 0.02) { s.p.y = FLOOR + 0.02; s.v.multiplyScalar(0.3); }
      if (s.life <= 0) this.shardList.splice(i, 1);
    }
    this.shardList.slice(0, 64).forEach((s, k) => this.shards.setMatrixAt(k, this.m.makeTranslation(s.p.x, s.p.y, s.p.z)));
    this.shards.count = Math.min(64, this.shardList.length);
    this.shards.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ keeping it

  /** three game days after they were raised, the fallen rise again and the chest is full (not while he is inside) */
  private respawnIfDue(first: boolean): void {
    const due = this.state.days - this.state.spawnDay >= RESPAWN_DAYS;
    if (!due && !first) return;
    if (due) {
      this.state.spawnDay = this.state.days;
      this.state.dead.fill(false);
      this.state.looted = false;
      this.bonePieces.length = 0;
    }
    for (const [k, g] of this.guards.entries()) {
      const dead = this.state.dead[k];
      g.state = dead ? 'dead' : 'waiting';
      g.hp = GUARD_HP;
      g.root.visible = false;
      g.root.scale.set(1, 1, 1);
      g.s = g.spawnS;
      g.lat = 0;
      g.swing = 0;
      g.free = null;
    }
    this.next = this.state.dead.findIndex((d) => !d);
    if (this.next < 0) this.next = GUARDS;
    for (const c of this.coins) c.visible = !this.state.looted;
    // the heaps of those already fallen
    if (!due) for (const [k, g] of this.guards.entries()) if (this.state.dead[k]) this.heap(g);
    this.saveState();
  }

  /** the bones of one fallen long ago, lying where he waited */
  private heap(g: Guard): void {
    const sm = this.sample(g.spawnS);
    for (let k = 0; k < 22; k++) {
      this.bonePieces.push({
        p: new THREE.Vector3(sm.p.x + (Math.random() - 0.5) * 0.9, FLOOR + 0.1, sm.p.z + (Math.random() - 0.5) * 0.9),
        v: new THREE.Vector3(), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, Math.random() * 6.28, 0)), w: new THREE.Vector3(), rest: true, age: 0,
      });
    }
  }

  private saveState(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* storage unavailable */ }
  }

  private loadState(): void {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (d && Array.isArray(d.dead) && d.dead.length === GUARDS) this.state = { days: +d.days || 0, spawnDay: +d.spawnDay || 0, dead: d.dead.map(Boolean), looted: !!d.looted };
    } catch { /* a fresh start */ }
  }

  /** stand at s along the passage, facing on down it (debugging: __game.skull.at(40)) */
  at(s: number): { x: number; z: number; yaw: number } {
    const sm = this.sample(s);
    return { x: sm.p.x, z: sm.p.z, yaw: Math.atan2(sm.t.x, sm.t.z) };
  }

  /** where to stand to look into the mouth (for ?location=skull): a few metres out, and the heading in */
  get approach(): { at: THREE.Vector3; yaw: number } {
    const sm = this.sample(this.sMouth);
    const at = sm.p.clone().addScaledVector(sm.t, -(this.skullDepth + 5));
    return { at, yaw: Math.atan2(sm.t.x, sm.t.z) };
  }
}

/**
 * A guard's cut: the sword arm straightened out along the way the cut goes — the upper arm and the forearm
 * each turned (in world terms) to lie along it, the elbow a little bent forward — so the hand with the sabre
 * sweeps a clean arc: wound up high over one shoulder, brought down across him to low on the other side, and
 * back, blended in and out of the running pose. `p` 0–1 through the cut. The directions are in his frame
 * (+z ahead, +x his left, +y up).
 */
export function swingArm(root: THREE.Object3D, arm: THREE.Bone, fore: THREE.Bone, hand: THREE.Bone, yaw: number, p: number, cut: number, blade?: THREE.Vector3): void {
  const ease = (x: number) => x * x * (3 - 2 * x);
  const [from, to] = CUT_PATHS[cut];
  let w: number, k: number;
  if (p < 0.45) { w = ease(p / 0.45); k = 0; }                 // winding up
  else if (p < 0.7) { w = 1; k = ease((p - 0.45) / 0.25); }    // the cut
  else { w = 1 - ease((p - 0.7) / 0.3); k = 1; }               // recovering
  // (through the cut the arm swings round, not straight across: slerp the direction)
  const dir = new THREE.Vector3().copy(from).normalize().lerp(to.clone().normalize(), k).normalize();
  if (k > 0 && k < 1) dir.addScaledVector(new THREE.Vector3(0, 0, 1), Math.sin(k * Math.PI) * 0.6).normalize();
  dir.applyAxisAngle(Y, yaw);
  // the forearm a touch further forward than the upper arm: the elbow slightly bent
  const foreDir = dir.clone().add(new THREE.Vector3(0, 0, 0.35).applyAxisAngle(Y, yaw)).normalize();
  root.updateMatrixWorld(true);
  const aim = (b: THREE.Bone, child: THREE.Object3D, d: THREE.Vector3) => {
    const at = b.getWorldPosition(new THREE.Vector3());
    const cur = child.getWorldPosition(new THREE.Vector3()).sub(at).normalize();
    const world = b.getWorldQuaternion(new THREE.Quaternion());
    const aimed = new THREE.Quaternion().setFromUnitVectors(cur, d).multiply(world);
    const parent = b.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    b.quaternion.slerp(parent.multiply(aimed), w);
    b.updateMatrixWorld(true);
  };
  aim(arm, fore, dir);
  aim(fore, hand, foreDir);
  // the blade carrying on the forearm's line (a little further forward still): it leads the arc
  if (blade) {
    const bd = foreDir.clone().add(new THREE.Vector3(0, 0, 0.1).applyAxisAngle(Y, yaw)).normalize();
    const world = hand.getWorldQuaternion(new THREE.Quaternion());
    const cur = blade.clone().applyQuaternion(world);
    const aimed = new THREE.Quaternion().setFromUnitVectors(cur, bd).multiply(world);
    const parent = hand.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    hand.quaternion.slerp(parent.multiply(aimed), w);
  }
}

/**
 * Which way the blade points in the hand bone's own frame: the long axis of the vertices bound to that bone,
 * toward the far end (the point). Found once from the model's bind pose.
 */
export function bladeAxis(model: THREE.Object3D, hand: THREE.Bone): THREE.Vector3 | null {
  const pts: THREE.Vector3[] = [];
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const bi = m.skeleton.bones.indexOf(hand);
    if (bi < 0) return;
    const pos = m.geometry.getAttribute('position'), si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
    const toBone = m.skeleton.boneInverses[bi].clone().multiply(m.bindMatrix);
    for (let i = 0; i < pos.count; i++)
      for (let c = 0; c < 4; c++) if (si.getComponent(i, c) === bi && sw.getComponent(i, c) > 0.9) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toBone));
  });
  if (pts.length < 10) return null;
  const c = pts.reduce((a, q) => a.add(q), new THREE.Vector3()).divideScalar(pts.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of pts) { const d = q.clone().sub(c).toArray(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
  let v = new THREE.Vector3(1, 0.3, 0.2);
  for (let k = 0; k < 40; k++) v = new THREE.Vector3(C[0][0] * v.x + C[0][1] * v.y + C[0][2] * v.z, C[1][0] * v.x + C[1][1] * v.y + C[1][2] * v.z, C[2][0] * v.x + C[2][1] * v.y + C[2][2] * v.z).normalize();
  // toward the point: the end farther from the bone (the grip is at it)
  let far = 0;
  for (const q of pts) if (Math.abs(q.dot(v)) > Math.abs(far)) far = q.dot(v);
  return far < 0 ? v.negate() : v;
}

/** the closest points of segments a0–a1 and b0–b1, and their distance */
function closestSegments(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): { onA: THREE.Vector3; dist: number } {
  const d1 = a1.clone().sub(a0), d2 = b1.clone().sub(b0), r = a0.clone().sub(b0);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  const c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
  s = den > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
  t = (b * s + f) / e;
  if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
  const pa = a0.clone().addScaledVector(d1, s), pb = b0.clone().addScaledVector(d2, t);
  return { onA: pa, dist: pa.distanceTo(pb) };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** a soft flame: a hot core and an orange tongue fading out, drawn once */
function flameTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 96;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 62, 2, 32, 52, 34);
  g.addColorStop(0, 'rgba(255,250,220,1)');
  g.addColorStop(0.3, 'rgba(255,180,70,0.85)');
  g.addColorStop(1, 'rgba(255,80,10,0)');
  x.fillStyle = g;
  x.beginPath();
  x.ellipse(32, 56, 22, 38, 0, 0, Math.PI * 2);
  x.fill();
  return new THREE.CanvasTexture(c);
}
