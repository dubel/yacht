import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Cell, measure, Placed, tame, type Measured, type StructureDef } from './structures';
import { terrainHeight, TORTUGA_QUAY, TORTUGA_TOWN } from './WorldGen';

/*
 * Tortuga's town: a pirates' haven, not a European town — a long, narrow straggle of houses between the quay
 * and the trees, run up from whatever was to hand. One sandy road runs along behind the quay; the houses of
 * the first row face it, a second row stands back by the trees, and narrow lanes lead between them. In the
 * middle the road opens into the market square: the well, the stalls, a laden table in the open; the tavern
 * on its far side, the governor's house at one corner, the smithy at the other. North the poorer end — a
 * fishing shack, huts, a burnt-out ruin at the edge of the forest; south the better-off — the store, the
 * craftsmen, the port's warehouse, the powder store kept well away from any fire.
 *
 * Every house is solid (no going in: they are empty inside, for now); the props — barrels, crates, stalls,
 * the well — are in the way too. The houses are models of every kind, scaled to one measure, stood on the
 * ground, turned a little off true: nobody here had a surveyor.
 *
 * Loaded when the ship comes near (it is a lot to fetch), and drawn only from close by.
 */

/** the town is fetched when the ship is this near the quay (m), and drawn from this near */
const LOAD_R = 1500, DRAW_R = 900;

/** a model: where it comes from, and how big it is to stand (m, its longest side across the ground) */
interface ModelDef extends Omit<StructureDef, 'turn' | 'scale'> {
  scale?: number;
  /** which way its front (the door) faces in the file, as a turn from +z (rad) */
  face?: number;
}
const T = 'assets/town/';
const LP = T + 'lowpoly.glb', PROPS = T + 'props.glb';
/** the props pack: a barrel a hand under a metre tall */
const PROP_SCALE = 26;
const MODELS: Record<string, ModelDef> = {
  // the square
  tavern: { url: T + 'tavern.glb', size: 19, drop: /Circle_Stone_brick_wall/, ground: 0.53 },
  // (its base slab, a painted-on shadow, and a white box round the whole house left out)
  noble: { url: T + 'noble.glb', size: 12, drop: /^Plane03[67]|^Shadow$|^Material\.035$/ },
  smithy: { url: T + 'smithy.glb', size: 12.5, doorParts: /^Door(Front|Side)$/ },
  // houses
  woodhouse: { url: T + 'woodhouse.glb', size: 15 },
  // (a stone house: thick walls, small windows — the powder store, well away from the forge)
  store: { url: T + 'store.glb', size: 9 },
  house1: { url: T + 'house1.glb', size: 11 },
  timber: { url: T + 'timber.glb', size: 8, doorParts: /^Door(001)?$|^Handle_Front/ },
  oldhouse: { url: T + 'oldhouse.glb', size: 10 },
  cabin: { url: T + 'cabin.glb', size: 8.5, drop: /^Ground_|Ground_MatMain/ },
  logcabin: { url: T + 'logcabin.glb', size: 8.5, doorParts: /^Door$/ },
  oldcabin: { url: T + 'oldcabin.glb', size: 10 },
  home: { url: T + 'home.glb', size: 7 },
  warehouse: { url: T + 'woodhouse2.glb', size: 13 },
  thatched: { url: T + 'thatched.glb', size: 7.5 },
  lean: { url: T + 'foresthut.glb', size: 4.5 },
  oldhut: { url: T + 'oldhut.glb', size: 7 },
  ruin: { url: T + 'ruin.glb', size: 8 },
  shed: { url: T + 'shed.glb', size: 8 },
  shack: { url: T + 'shack.glb', size: 7.5, doorParts: /^Door$/ },
  tall: { url: T + 'medieval.glb', size: 8 },
  // the low-poly pack: nine houses, one node each
  lp015: { url: LP, pick: 'Cube015', scale: 0.9 },
  lp014: { url: LP, pick: 'Cube014', doorParts: /WoodDoor/, scale: 1.1 },
  lp008: { url: LP, pick: 'Cube008', doorParts: /WoodDoor/, scale: 1.1 },
  lp004: { url: LP, pick: 'Cube004', doorParts: /WoodDoor/, scale: 1.2 },
  lp002: { url: LP, pick: 'Cube002', doorParts: /WoodDoor/, scale: 1.1 },
  lp003: { url: LP, pick: 'Cube003', scale: 1.1 },
  lp001: { url: LP, pick: 'Cube001', scale: 0.8 },
  lp005: { url: LP, pick: 'Cube005', scale: 1.1 },
  lp000: { url: LP, pick: 'Cube', scale: 1.1 },
  // things about the square and the houses
  well: { url: T + 'well.glb', size: 2.5 },
  stall: { url: T + 'stall.glb', size: 5 },
  stall2: { url: T + 'stall2.glb', size: 4.2 },
  butcher: { url: T + 'butcher.glb', size: 2 },
  feast: { url: T + 'feast.glb', scale: 0.5 },
  tools: { url: T + 'tools.glb', size: 4 },
  barrel: { url: PROPS, pick: 'Barrel_mesh', scale: PROP_SCALE },
  crate: { url: PROPS, pick: 'Crate_mesh', scale: PROP_SCALE },
  chest: { url: PROPS, pick: 'Chest_mesh', scale: PROP_SCALE },
  stool: { url: PROPS, pick: 'Stool_mesh', scale: PROP_SCALE },
  table: { url: PROPS, pick: 'Table02_mesh', scale: PROP_SCALE },
  round: { url: PROPS, pick: 'Table01_mesh', scale: PROP_SCALE },
  bench: { url: PROPS, pick: 'Bench_mesh', scale: PROP_SCALE },
  sword: { url: PROPS, pick: 'Sword_mesh', scale: PROP_SCALE },
  halberd: { url: PROPS, pick: 'Halberd_mesh', scale: PROP_SCALE },
  spear: { url: PROPS, pick: 'Spear_mesh', scale: PROP_SCALE },
};

/** the houses (the rest are things standing about): walls, floors, doors */
const HOUSES = new Set(['tavern', 'noble', 'smithy', 'woodhouse', 'store', 'house1', 'timber', 'oldhouse', 'cabin', 'logcabin', 'oldcabin', 'home',
  'warehouse', 'thatched', 'lean', 'oldhut', 'ruin', 'shed', 'shack', 'tall', 'lp015', 'lp014', 'lp008', 'lp004', 'lp002', 'lp003', 'lp001', 'lp005', 'lp000']);

/** houses with no doors to hang: a lean-to open at the front, a burnt-out ruin (in through its gaps) */
const DOORLESS = new Set(['lean', 'ruin']);

/** a door opens (swinging in) through this angle (rad), in this long (s) */
const OPEN = 1.65, SWING = 0.9;

/** a door hung in a doorway of a placed house */
interface Door {
  /** the doorway, in the world: middle on the floor, along the wall, out across it */
  x: number;
  y: number;
  z: number;
  ax: number;
  az: number;
  ox: number;
  oz: number;
  width: number;
  height: number;
  /** open 0 … 1, and where it is going */
  open: number;
  target: number;
  /** its matrix without the swing: the house's, then the hinge's */
  base: THREE.Matrix4;
}

/** steps run up to a doorway above the ground outside it */
interface Stair {
  /** the foot of the wall under the doorway (x, z), out and along; the rise from the ground to the sill */
  x: number;
  z: number;
  ox: number;
  oz: number;
  ax: number;
  az: number;
  half: number;
  ground: number;
  sill: number;
  steps: number;
}
/** a step's rise and tread (m) */
const RISE = 0.2, TREAD = 0.3;

/**
 * The rows of houses, north to south: which, in order along the road (the packing leaves the square and the
 * lanes clear and a gap of a few paces between houses). First row: its front to the road; second: its back
 * to the trees.
 */
const ROWS: { row: 1 | 2; v0: number; v1: number; houses: string[] }[] = [
  // the north end, the poor end: newcomers, fishermen, buccaneers (a shack or a hut more than once: they were
  // all run up the same way)
  { row: 1, v0: -174, v1: -17, houses: ['shack', 'lp004', 'lp000', 'thatched', 'home', 'lp001', 'tall', 'lp003', 'noble'] },
  { row: 2, v0: -174, v1: -24, houses: ['lean', 'oldhut', 'shack', 'ruin', 'thatched', 'lp002', 'shed', 'lp004'] },
  // the south end: settled men, craftsmen, the store
  { row: 1, v0: 17, v1: 176, houses: ['smithy', 'timber', 'woodhouse', 'warehouse', 'lp014', 'lp008', 'oldhouse', 'lp005', 'house1', 'logcabin'] },
  { row: 2, v0: 24, v1: 176, houses: ['lp015', 'store', 'cabin', 'oldcabin', 'oldhut', 'thatched'] },
];

/** the square's furniture and the things lying about: model, u (inland), v (along), turn, tilt (leaning) */
const PROPS_AT: [string, number, number, number, number?][] = [
  // the square
  ['well', 26, 0, 0.3],
  ['stall', 16, -9, Math.PI / 2],
  ['stall2', 34, 9, -Math.PI / 2],
  ['butcher', 34.5, 13, -Math.PI / 2],
  ['feast', 21, 8, 0.2],
  ['crate', 15.5, -12.6, 0.4], ['crate', 16.3, -13.4, 1.1], ['barrel', 17.5, -13, 0],
  ['barrel', 33, 5, 0], ['barrel', 33.4, 6.1, 0], ['crate', 32.6, 11.8, 0.2],
  ['barrel', 14.5, 12.5, 0], ['barrel', 37.5, -12, 0],
  // before the tavern: a table in the open, benches, stools, a chest
  ['table', 37.8, -5, Math.PI / 2], ['bench', 37.8, -3.6, Math.PI / 2], ['bench', 37.8, -6.4, Math.PI / 2],
  ['round', 36.5, 4, 0], ['stool', 35.6, 4.3, 0.5], ['stool', 37.3, 3.3, 1.9], ['stool', 36.9, 5.1, 3],
  ['chest', 39.2, -10.5, 0.3], ['barrel', 39, 2.2, 0], ['barrel', 39.3, 3.2, 0],
  // by the smithy: its tools, weapons waiting to be mended
  ['tools', 29, 14.5, Math.PI], ['sword', 12.9, 22, 0, 0.3], ['halberd', 13, 23.2, 0, 0.25], ['spear', 11.8, 27, 0.5, 0.05],
  // the quayside: cargo landed and not yet carried off
  ['crate', 3.5, -60, 0.2], ['crate', 3.8, -61.1, 0.9], ['barrel', 2.8, -58.8, 0],
  ['barrel', 3.2, -10, 0], ['barrel', 3.9, -9.2, 0], ['barrel', 3.4, -8.2, 0],
  ['crate', 3.6, 33, 0.3], ['chest', 2.9, 96, 1.2], ['barrel', 3.5, 97.5, 0],
  // the north end: a fisherman's barrels, a crate left by the road
  ['barrel', 20, -168, 0], ['barrel', 20.8, -167.2, 0], ['crate', 13.4, -120, 0.7],
];

/** which way a house's front faces in its file (a turn from +z): its first door's, if it has one */
function faceOf(name: string, m: Measured): number {
  const d = m.doors[0];
  return MODELS[name].face ?? (d ? Math.atan2(d.outX, d.outZ) : 0);
}

/**
 * A house's doorways cut through its walls where they have none of their own: its materials leave out what
 * falls in a box round each doorway (the wall's thickness, a door's width and height).
 */
function cutDoorways(m: Measured): void {
  if (!m.doors.length) return;
  const holes = m.doors.slice(0, 3).map((d) => {
    const hw = d.width / 2, hd = d.depth / 2;
    const ex = d.outX ? hd : hw, ez = d.outX ? hw : hd;
    return [new THREE.Vector3(d.x - ex, d.y - 0.05, d.z - ez), new THREE.Vector3(d.x + ex, d.y + d.height, d.z + ez)];
  });
  while (holes.length < 3) holes.push([new THREE.Vector3(1e6, 1e6, 1e6), new THREE.Vector3(1e6, 1e6, 1e6)]);
  const uniforms = { uHoleA: { value: holes.map((h) => h[0]) }, uHoleB: { value: holes.map((h) => h[1]) } };
  for (const p of m.parts) {
    const mat = p.mat;
    const key = holes.map((h) => h[0].toArray().map((v) => v.toFixed(2)).join(',')).join(';');
    mat.customProgramCacheKey = () => 'door-holes ' + key;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vHouse;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHouse = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vHouse;\nuniform vec3 uHoleA[3];\nuniform vec3 uHoleB[3];')
        .replace('void main() {', 'void main() {\n  for (int i = 0; i < 3; i++) if (all(greaterThan(vHouse, uHoleA[i])) && all(lessThan(vHouse, uHoleB[i]))) discard;');
    };
  }
}

/** the one door hung everywhere: planks on ledges, a latch; its hinge edge at x = 0, 1 × 1 (scaled to fit) */
function doorLeaf(): { geo: THREE.BufferGeometry; mat: THREE.Material } {
  const geo = new THREE.BoxGeometry(1, 1, 0.07).translate(0.5, 0.5, 0);
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d')!;
  // (planks, each its own shade, dark seams between; two ledges across; a black iron latch)
  for (let k = 0; k < 5; k++) {
    const l = 0.8 + 0.25 * Math.sin(k * 2.7);
    g.fillStyle = `rgb(${Math.round(92 * l)}, ${Math.round(62 * l)}, ${Math.round(38 * l)})`;
    g.fillRect(k * 25.6, 0, 25.6, 256);
    g.fillStyle = 'rgba(20, 12, 6, 0.8)';
    g.fillRect(k * 25.6, 0, 2, 256);
    for (let n = 0; n < 12; n++) { g.fillStyle = `rgba(30, 18, 8, ${0.15 + 0.1 * Math.sin(n * k)})`; g.fillRect(k * 25.6 + 4 + ((n * 37 + k * 11) % 18), (n * 53 + k * 29) % 256, 1, 30 + (n % 3) * 20); }
  }
  for (const y of [40, 200]) { g.fillStyle = 'rgb(70, 46, 28)'; g.fillRect(0, y, 128, 18); g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, y + 16, 128, 2); }
  g.fillStyle = 'rgb(28, 26, 26)';
  g.fillRect(100, 118, 18, 8);
  g.beginPath(); g.arc(106, 132, 5, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { geo, mat: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }) };
}

export class TortugaTown {
  readonly group = new THREE.Group();
  private placed: Placed[] = [];
  private readonly doors: Door[] = [];
  private readonly stairs: Stair[] = [];
  private doorMesh: THREE.InstancedMesh | null = null;
  /** a door started to open (true) or to close (false) at (x, z) — for its creak (set by the game) */
  onDoor: ((opening: boolean, x: number, z: number) => void) | null = null;
  /** a door came to, at (x, z) */
  onShut: ((x: number, z: number) => void) | null = null;
  private state: 'waiting' | 'loading' | 'ready' = 'waiting';
  private seed = 987654321;

  constructor() {
    this.group.name = 'tortuga town';
    this.group.visible = false;
  }

  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** once per frame: fetch the town when the ship comes near, draw it from close by */
  update(eye: THREE.Vector3, ship: THREE.Vector3): void {
    const d = (p: THREE.Vector3) => Math.hypot(p.x - TORTUGA_QUAY.x, p.z - (TORTUGA_QUAY.z0 + TORTUGA_QUAY.z1) / 2);
    if (this.state === 'waiting' && Math.min(d(eye), d(ship)) < LOAD_R) { this.state = 'loading'; void this.load(); }
    this.group.visible = this.state === 'ready' && d(eye) < DRAW_R;
  }

  /** fetch and put up the town now (a start in the harbour) */
  async loadNow(): Promise<void> {
    if (this.state === 'waiting') { this.state = 'loading'; await this.load(); }
  }

  private async load(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const files = new Map<string, Promise<THREE.Object3D>>();
    const file = (url: string) => { if (!files.has(url)) files.set(url, loader.loadAsync(url).then((g) => g.scene)); return files.get(url)!; };
    // (one model at a time, a frame between: the measuring takes a moment, and the voyage goes on meanwhile)
    const measured: Record<string, Measured> = {};
    for (const [name, def] of Object.entries(MODELS)) {
      const root = await file(def.url);
      measured[name] = measure(root, { ...def, scale: def.scale ?? 1, turn: 0, centre: true, solid: !HOUSES.has(name), building: HOUSES.has(name) });
      if (HOUSES.has(name) && !DOORLESS.has(name)) cutDoorways(measured[name]);
      await new Promise((r) => setTimeout(r, 0));
    }
    const at: { m: string; u: number; v: number; turn: number; tilt: number }[] = [];
    this.layRows(measured, at);
    for (const [m, u, v, turn, tilt] of PROPS_AT) at.push({ m, u, v, turn, tilt: tilt ?? 0 });
    // ---- the meshes: an instanced mesh per model part, a copy per placing ----
    const Q = TORTUGA_QUAY;
    for (const name of Object.keys(MODELS)) {
      const mine = at.filter((a) => a.m === name);
      if (!mine.length) continue;
      const m = measured[name];
      const mats = mine.map((a) => {
        const x = Q.x - a.u, z = a.v;
        const y = this.groundUnder(m, x, z, a.turn);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(a.tilt, a.turn, 0, 'YXZ'));
        this.placed.push(new Placed(m, x, y, z, a.turn));
        const mt = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
        if (!DOORLESS.has(name)) for (const d of m.doors) this.hang(d, mt, x, y, z, a.turn);
        return mt;
      });
      for (const p of m.parts) {
        tame(p.mat);
        const mesh = new THREE.InstancedMesh(p.geo, p.mat, mine.length);
        mats.forEach((mt, k) => mesh.setMatrixAt(k, mt));
        mesh.computeBoundingSphere();
        // (only the big parts cast shadows: a shadow pass for every hinge and mug costs more than it shows)
        mesh.castShadow = (p.geo.boundingSphere?.radius ?? 0) > 1.5;
        mesh.receiveShadow = true;
        mesh.name = `town ${name}`;
        this.group.add(mesh);
      }
    }
    // ---- the doors: one leaf, drawn once per door; the steps up to them, of the same boards ----
    if (this.doors.length) {
      const { geo, mat } = doorLeaf();
      const treads: THREE.BufferGeometry[] = [];
      for (const st of this.stairs) {
        const rise = (st.sill - st.ground) / st.steps, turn = Math.atan2(st.ox, st.oz);
        for (let k = 0; k < st.steps; k++) {
          // step k from the wall: its top a rise lower each tread out, down to the ground
          const top = st.sill - k * rise, h = Math.max(0.05, top - st.ground + 0.1);
          const b = new THREE.BoxGeometry(st.half * 2, h, TREAD);
          b.translate(0, top - h / 2, (k + 0.5) * TREAD);
          b.applyMatrix4(new THREE.Matrix4().makeRotationY(turn)).translate(st.x, 0, st.z);
          treads.push(b);
        }
      }
      if (treads.length) {
        const steps = new THREE.Mesh(mergeGeometries(treads), (mat as THREE.MeshStandardMaterial).clone());
        steps.castShadow = steps.receiveShadow = true;
        steps.name = 'town steps';
        this.group.add(steps);
      }
      this.doorMesh = new THREE.InstancedMesh(geo, mat, this.doors.length);
      this.doorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.doorMesh.castShadow = this.doorMesh.receiveShadow = true;
      this.doorMesh.frustumCulled = false;
      this.doorMesh.name = 'town doors';
      this.group.add(this.doorMesh);
      this.swing(0);
    }
    this.state = 'ready';
  }

  /** a door in a doorway of a house placed with matrix `house` (at x, y, z, turned `turn`) */
  private hang(d: { x: number; y: number; z: number; width: number; height: number; outX: number; outZ: number; depth: number; own?: boolean }, house: THREE.Matrix4, x: number, y: number, z: number, turn: number): void {
    const c = Math.cos(turn), s = Math.sin(turn);
    const w = (a: number, b: number): [number, number] => [a * c + b * s, -a * s + b * c];
    const [ox, oz] = w(d.outX, d.outZ);
    // along the wall: out turned a quarter (the hinge at the start of it)
    const [ax, az] = w(d.outZ, -d.outX);
    const [cx, cz] = w(d.x, d.z);
    // the leaf's frame in the house: its hinge edge, turned so its x runs along the wall and z out
    const th = Math.atan2(d.outX, d.outZ);
    const hingeLocal = new THREE.Matrix4().makeTranslation(d.x - d.outZ * d.width / 2, d.y, d.z + d.outX * d.width / 2).multiply(new THREE.Matrix4().makeRotationY(th));
    this.doors.push({
      x: x + cx, y: y + d.y, z: z + cz, ax, az, ox, oz, width: d.width, height: d.height, open: 0, target: 0,
      base: house.clone().multiply(hingeLocal),
    });
    // a doorway up off the ground: steps up to it (not to a door high in an upper storey: the house's own
    // stair goes there)
    const fx = x + cx + ox * d.depth / 2, fz = z + cz + oz * d.depth / 2;
    const n = Math.ceil((y + d.y - terrainHeight(fx + ox * 0.8, fz + oz * 0.8)) / RISE);
    if (n >= 3 && n * RISE < (d.own ? 2.4 : 3)) {
      const ground = terrainHeight(fx + ox * n * TREAD * 0.5, fz + oz * n * TREAD * 0.5);
      this.stairs.push({ x: fx, z: fz, ox, oz, ax, az, half: d.width / 2 + 0.15, ground, sill: y + d.y, steps: Math.ceil((y + d.y - ground) / RISE) });
    }
  }

  /** the doors swing toward open or shut */
  private swing(dt: number): void {
    const mesh = this.doorMesh;
    if (!mesh) return;
    const m = new THREE.Matrix4(), r = new THREE.Matrix4(), sc = new THREE.Matrix4();
    let moved = false;
    this.doors.forEach((d, k) => {
      if (dt > 0 && d.open === d.target) return;
      const was = d.open;
      d.open = d.target > d.open ? Math.min(d.target, d.open + dt / SWING) : Math.max(d.target, d.open - dt / SWING);
      if (was > 0 && d.open === 0) this.onShut?.(d.x, d.z);
      // (eased: it starts slow, swings, and slows as it comes to)
      const e = d.open * d.open * (3 - 2 * d.open);
      m.copy(d.base).multiply(r.makeRotationY(OPEN * e)).multiply(sc.makeScale(d.width, d.height, 1));
      mesh.setMatrixAt(k, m);
      moved = true;
    });
    if (moved) mesh.instanceMatrix.needsUpdate = true;
  }

  /** once per frame, ashore: the doors move */
  tick(dt: number): void {
    if (this.state === 'ready') this.swing(dt);
  }

  /**
   * The door the sailor at `p` (facing `dir`) would work with the action key: the nearest in reach in front of
   * him. Returns what the key would do, and does it when `act`.
   */
  interact(p: THREE.Vector2, dir: THREE.Vector2, act: boolean): string | null {
    if (this.state !== 'ready') return null;
    let best: Door | null = null, bestD = 2.4;
    for (const d of this.doors) {
      // (the middle of the leaf where it hangs now, near enough)
      const dx = d.x - p.x, dz = d.z - p.y, dist = Math.hypot(dx, dz);
      if (dist > bestD || (dist > 0.6 && (dx * dir.x + dz * dir.y) / dist < 0.35)) continue;
      best = d;
      bestD = dist;
    }
    if (!best) return null;
    const opening = best.target === 0;
    if (act) {
      if (!opening && this.inSwing(best, p)) return 'Odsuń się — drzwi się nie domkną';
      best.target = opening ? 1 : 0;
      this.onDoor?.(opening, best.x, best.z);
    }
    return opening ? 'otwórz drzwi' : 'zamknij drzwi';
  }

  /** is p where the leaf swings (in the doorway, or the arc just inside it)? */
  private inSwing(d: Door, p: THREE.Vector2): boolean {
    const dx = p.x - d.x, dz = p.y - d.z;
    const along = dx * d.ax + dz * d.az, across = dx * d.ox + dz * d.oz;
    return Math.abs(along) < d.width / 2 + 0.3 && across < 0.5 && across > -d.width - 0.4;
  }

  /** the boards (or floor) of a house underfoot at (x, z): its height, or null for the ground */
  floorAt(x: number, z: number): number | null {
    if (!this.near(x, z)) return null;
    let best: number | null = null;
    // (the steps up to a door)
    for (const st of this.stairs) {
      const dx = x - st.x, dz = z - st.z, out = dx * st.ox + dz * st.oz;
      if (out < 0 || out > st.steps * TREAD || Math.abs(dx * st.ax + dz * st.az) > st.half) continue;
      const h = st.sill - Math.floor(out / TREAD) * ((st.sill - st.ground) / st.steps);
      if (best === null || h > best) best = h;
    }
    for (const p of this.placed) if (p.cell(x, z) === Cell.Walk) { const h = p.height(x, z); if (best === null || h > best) best = h; }
    return best;
  }

  private near(x: number, z: number): boolean {
    const Q = TORTUGA_QUAY;
    return this.state === 'ready' && x < Q.x + 2 && x > Q.x - TORTUGA_TOWN.depth - 10 && z > Q.z0 - 30 && z < Q.z1 + 30;
  }

  /**
   * The houses along the road, row by row: each turned to face the road (a little off true), pushed up to
   * its row's line, the next one a few paces on — past the square and the lanes.
   */
  private layRows(measured: Record<string, Measured>, at: { m: string; u: number; v: number; turn: number; tilt: number }[]): void {
    const Tn = TORTUGA_TOWN, S = Tn.square;
    const front1 = Tn.road.u + Tn.road.half + 1.2;
    for (const r of ROWS) {
      // each house turned to face the road (east, +x: its front, +z in the file turned by `face`, swung round
      // to it), a little off true; its extent along the road (v) and across it (u), as turned
      const houses = r.houses.map((name) => {
        const m = measured[name], face = faceOf(name, m);
        const turn = Math.PI / 2 - face + (this.rnd() - 0.5) * 0.3;
        const c = Math.abs(Math.cos(turn)), s = Math.abs(Math.sin(turn));
        const sx = m.box.max.x - m.box.min.x, sz = m.box.max.z - m.box.min.z;
        return { name, turn, along: sx * s + sz * c, across: sx * c + sz * s };
      });
      // the room they have: the row's length less the lanes (and the square) crossing it, shared out evenly
      // between them as gaps, give or take
      const keepClear = (v0: number, v1: number) => Tn.lanes.some((l) => v1 > l - Tn.laneHalf - 0.8 && v0 < l + Tn.laneHalf + 0.8)
        || (r.row === 1 && v1 > S.v0 - 1 && v0 < S.v1 + 1) || (r.row === 2 && v1 > S.v0 - 8 && v0 < S.v1 + 8);
      let clear = 0;
      for (let v = r.v0; v < r.v1; v += 0.5) if (keepClear(v, v + 0.5)) clear += 0.5;
      const used = houses.reduce((a, h) => a + h.along, 0);
      const gap = Math.max(2.5, (r.v1 - r.v0 - clear - used) / (houses.length + 1));
      let v = r.v0 + gap * 0.5;
      for (const h of houses) {
        const jitter = gap * 0.4 * (this.rnd() - 0.5);
        let v0 = v + jitter;
        for (let tries = 0; tries < 80 && keepClear(v0, v0 + h.along); tries++) v0 += 1;
        if (v0 + h.along > r.v1) { console.warn(`tortuga: no room for ${h.name}`); continue; }
        // first row: its front a step back from the road; second: its back to the trees
        const u = r.row === 1 ? front1 + h.across / 2 + this.rnd() * 1.5 : Tn.depth - h.across / 2 - this.rnd() * 3;
        at.push({ m: h.name, u, v: v0 + h.along / 2, turn: h.turn, tilt: 0 });
        v = v0 + h.along + gap;
      }
    }
    // the tavern across the square, its front to it; the fields of the square kept clear
    const tv = measured.tavern, turn = Math.PI / 2 - faceOf('tavern', tv);
    const across = (tv.box.max.x - tv.box.min.x) * Math.abs(Math.cos(turn)) + (tv.box.max.z - tv.box.min.z) * Math.abs(Math.sin(turn));
    at.push({ m: 'tavern', u: S.u1 + 1.5 + across / 2, v: 0, turn, tilt: 0 });
  }

  /** the ground under a house: the lowest of it over its footprint (it may sink a little on the high side) */
  private groundUnder(m: Measured, x: number, z: number, turn: number): number {
    const c = Math.cos(turn), s = Math.sin(turn);
    let low = Infinity;
    for (const [a, b] of [[m.box.min.x, m.box.min.z], [m.box.max.x, m.box.min.z], [m.box.min.x, m.box.max.z], [m.box.max.x, m.box.max.z], [0, 0]])
      low = Math.min(low, terrainHeight(x + a * c + b * s, z - a * s + b * c));
    return low - 0.05;
  }

  /** is (x, z) in the way of a house's walls, a door that isn't open, or a thing standing about? */
  blocked(x: number, z: number): boolean {
    if (!this.near(x, z)) return false;
    for (const d of this.doors) {
      if (d.open > 0.6) continue;
      const dx = x - d.x, dz = z - d.z;
      if (Math.abs(dx * d.ax + dz * d.az) < d.width / 2 && Math.abs(dx * d.ox + dz * d.oz) < 0.35) return true;
    }
    // (a house's floor counts before its walls: overlapping houses, the one he is in wins)
    let wall = false;
    for (const p of this.placed) {
      const c = p.cell(x, z);
      if (c === Cell.Walk) return false;
      if (c === Cell.Block) wall = true;
    }
    return wall;
  }
}
