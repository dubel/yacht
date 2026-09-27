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

/**
 * The town is fetched when the ship is this near the quay (m), drawn from this near, and let go of (its
 * meshes and textures freed; fetched again, from the browser's cache, on coming back) past this far.
 */
const LOAD_R = 1500, DRAW_R = 900, FREE_R = 3000;
/** things seen only from close by (m): heavy for their size (the well is a scan that won't simplify) */
const NEAR: Record<string, number> = { well: 90, butcher: 90, tools: 90, feast: 120, stall: 150, stall2: 150 };

/** a model: where it comes from, and how big it is to stand (m, its longest side across the ground) */
interface ModelDef extends Omit<StructureDef, 'turn' | 'scale'> {
  scale?: number;
  /** which way its front (the door) faces in the file, as a turn from +z (rad) */
  face?: number;
  /** its window panes (by material name): made plain stained glass */
  glass?: RegExp;
}

/**
 * Stained glass: plain panes of a light, warm red, half see-through, lit a little from within (so they read in
 * the shade). They cast no shadow, so the sun comes in through them onto the floor inside (in patches of
 * sunlight, not red: a shadow map knows light or none, not colour).
 */
const STAINED = new THREE.MeshStandardMaterial({
  name: 'stained glass', color: 0xe07a6a, emissive: 0x4a120c, roughness: 0.3, metalness: 0,
  transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
});
const T = 'assets/town/';
const LP = T + 'lowpoly.glb', PROPS = T + 'props.glb';
/** the props pack: a barrel a hand under a metre tall */
const PROP_SCALE = 26;
const MODELS: Record<string, ModelDef> = {
  // the square
  // (its door the one in the middle of its front, under the little roof; its windows stained glass, a warm red)
  tavern: { url: T + 'tavern.glb', size: 19, drop: /Circle_Stone_brick_wall/, ground: 0.53, doorParts: /^Material\.038$/, glass: /^Material\.022$/ },
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
  // (for the tavern's tables)
  mug: { url: PROPS, pick: 'Mug_mesh', scale: PROP_SCALE },
  bowl: { url: PROPS, pick: 'Bowl_mesh', scale: PROP_SCALE },
  plate: { url: PROPS, pick: 'Plate_mesh', scale: PROP_SCALE },
  candle: { url: PROPS, pick: 'Candle_LP_mesh', scale: PROP_SCALE },
};

/**
 * The tavern's inside, in its own frame (x toward its door, the square; z along it; the hall's floor at y 0):
 * the counter down the back wall with the casks behind it, round tables with stools, the long table laid for a
 * feast, a chest in the corner, arms against the wall. Model, x, z, turn, and what it stands on: 'floor', or
 * 'table' / 'round' / 'feast' / 'counter' (on top of it).
 */
const TAVERN_IN: [string, number, number, number, string?, number?][] = [
  // behind the counter: casks and crates
  ['barrel', -4.55, -1.6, 0], ['barrel', -4.55, -0.7, 0.8], ['barrel', -4.55, 0.2, 2], ['crate', -4.5, 1.4, 0.2], ['crate', -4.5, 2.3, 1.3], ['barrel', -4.5, 3.1, 0.4],
  // on the counter: mugs, a bowl, candles
  ['mug', -3.85, -1.2, 0.5, 'counter'], ['mug', -3.8, -0.8, 2.1, 'counter'], ['bowl', -3.9, 0.6, 0, 'counter'], ['mug', -3.85, 1.9, 1, 'counter'],
  ['candle', -3.9, -0.1, 0, 'counter'], ['candle', -3.9, 2.6, 0, 'counter'],
  // round tables, three stools each, a candle and a mug or two
  ['round', -2.1, -3.1, 0], ['stool', -2.85, -3.2, 0.3], ['stool', -1.6, -3.75, 1.6], ['stool', -1.55, -2.5, 3.1],
  ['candle', -2.1, -3.1, 0, 'round'], ['mug', -1.95, -2.9, 0.7, 'round'], ['mug', -2.3, -3.3, 2.4, 'round'],
  ['round', -1.0, -1.25, 0], ['stool', -1.75, -1.1, 0.9], ['stool', -0.4, -1.8, 2.2], ['stool', -0.75, -0.55, 4],
  ['candle', -1.0, -1.25, 0, 'round'], ['bowl', -0.85, -1.4, 0, 'round'],
  ['round', -2.3, 2.1, 0], ['stool', -3.0, 2.3, 0.2], ['stool', -1.8, 2.7, 1.9], ['stool', -2.2, 1.35, 3.5],
  ['candle', -2.3, 2.1, 0, 'round'], ['mug', -2.15, 2.25, 1.2, 'round'], ['plate', -2.45, 1.95, 0, 'round'],
  // the long table, laid for a feast
  ['feast', -1.4, 4.9, Math.PI / 2], ['candle', -1.4, 4.9, 0, 'feast'],
  // a chest in the corner, arms against the wall
  ['chest', 0.05, -4.05, -0.4], ['sword', -4.6, 5.6, 0, 'floor', 0.28], ['halberd', -4.55, 5.9, 0, 'floor', 0.22],
];
/** the counter: down the hall's back wall (x), from z0 to z1, so deep and so high */
const COUNTER = { x: -3.95, z0: -2.1, z1: 3.3, depth: 0.7, height: 1.05 };

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
 * The rows of houses, each packed from the square outward (`out`: −1 north, +1 south), close — a few paces
 * between houses, the lanes kept clear — so the town is thickest round the square and thins out, or stops
 * short, toward the ends of the quay. First row: its front to the road; second: its back to the trees. (A
 * shack or a hut more than once: they were all run up the same way.)
 */
const ROWS: { row: 1 | 2; from: number; to: number; out: 1 | -1; houses: string[] }[] = [
  // the north end, the poor end: newcomers, fishermen, buccaneers
  { row: 1, from: -17, to: -176, out: -1, houses: ['noble', 'lp003', 'tall', 'lp001', 'home', 'thatched', 'lp000', 'lp004', 'shack', 'lp014', 'thatched', 'shack', 'lp004', 'home'] },
  { row: 2, from: -24, to: -176, out: -1, houses: ['shed', 'lp002', 'thatched', 'ruin', 'shack', 'oldhut', 'lean', 'lp001', 'home', 'lean', 'oldhut', 'shack'] },
  // the south end: settled men, craftsmen, the port's warehouse, the powder store
  { row: 1, from: 17, to: 176, out: 1, houses: ['smithy', 'timber', 'woodhouse', 'warehouse', 'lp014', 'lp008', 'oldhouse', 'lp005', 'house1', 'logcabin', 'lp000', 'lp008', 'home'] },
  { row: 2, from: 24, to: 176, out: 1, houses: ['lp015', 'store', 'cabin', 'oldcabin', 'oldhut', 'thatched', 'lp002', 'shed', 'lp004', 'oldhut'] },
];

/** the square's furniture and the things lying about: model, u (inland), v (along), turn, tilt (leaning) */
const PROPS_AT: [string, number, number, number, number?][] = [
  // the square
  ['well', 20.5, 0, 0.3],
  ['stall', 10.5, -9, Math.PI / 2],
  ['stall2', 28.5, 9, -Math.PI / 2],
  ['butcher', 29, 13, -Math.PI / 2],
  ['feast', 15.5, 8, 0.2],
  ['crate', 10, -12.6, 0.4], ['crate', 10.8, -13.4, 1.1], ['barrel', 12, -13, 0],
  ['barrel', 27.5, 5, 0], ['barrel', 27.9, 6.1, 0], ['crate', 27.1, 11.8, 0.2],
  ['barrel', 9, 12.5, 0], ['barrel', 31, -12, 0],
  // before the tavern: a table in the open, benches, stools, a chest
  ['table', 30.8, -5, Math.PI / 2], ['bench', 30.8, -3.6, Math.PI / 2], ['bench', 30.8, -6.4, Math.PI / 2],
  ['round', 29.5, 4, 0], ['stool', 28.6, 4.3, 0.5], ['stool', 30.3, 3.3, 1.9], ['stool', 29.9, 5.1, 3],
  ['chest', 32.2, -10.5, 0.3], ['barrel', 32, 2.2, 0], ['barrel', 32.3, 3.2, 0],
  // by the smithy: its tools, weapons waiting to be mended against its front
  ['tools', 24, 14.5, Math.PI], ['sword', 7.1, 21.5, 0, 0.3], ['halberd', 7.2, 22.7, 0, 0.25], ['spear', 6.8, 26.5, 0.5, 0.05],
  // the quayside, between the boardwalk and the road: cargo landed and not yet carried off
  ['crate', 1.6, -60, 0.2], ['crate', 1.9, -61.1, 0.9], ['barrel', 1.4, -58.8, 0],
  ['barrel', 1.5, -10, 0], ['barrel', 2, -9.2, 0], ['barrel', 1.6, -8.2, 0],
  ['crate', 1.7, 33, 0.3], ['chest', 1.5, 96, 1.2], ['barrel', 1.8, 97.5, 0],
  // the north end: a fisherman's barrels, a crate left on the quayside
  ['barrel', 1.6, -168, 0], ['barrel', 2.2, -167.2, 0], ['crate', 1.7, -120, 0.7],
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
  const holes = m.doors.map((d) => {
    const hw = d.width / 2, hd = d.depth / 2;
    const ex = d.outX ? hd : hw, ez = d.outX ? hw : hd;
    return new THREE.Box3(new THREE.Vector3(d.x - ex, d.y - 0.05, d.z - ez), new THREE.Vector3(d.x + ex, d.y + d.height, d.z + ez));
  });
  // a house with stained glass: its window panes, and the inner skin of its walls cut through behind each (so
  // the panes are seen from inside, and the sun comes in through them)
  const glass = m.parts.filter((p) => p.mat.name === 'stained glass');
  const panes = glass.length ? findPanes(glass.map((p) => p.geo)) : [];
  m.panes = panes;
  for (const b of panes) {
    const thinX = b.max.x - b.min.x < b.max.z - b.min.z;
    const h = b.clone();
    // (a hand in from the frame round it, through the wall's thickness)
    if (thinX) { h.min.x -= 0.45; h.max.x += 0.45; h.min.z += 0.05; h.max.z -= 0.05; } else { h.min.z -= 0.45; h.max.z += 0.45; h.min.x += 0.05; h.max.x -= 0.05; }
    h.min.y += 0.04; h.max.y -= 0.04;
    holes.push(h);
  }
  const n = Math.min(MAX_HOLES, holes.length);
  const A = holes.slice(0, n).map((h) => h.min), B = holes.slice(0, n).map((h) => h.max);
  while (A.length < MAX_HOLES) { A.push(new THREE.Vector3(1e6, 1e6, 1e6)); B.push(new THREE.Vector3(1e6, 1e6, 1e6)); }
  const uniforms = { uHoleA: { value: A }, uHoleB: { value: B }, uHoleN: { value: n } };
  for (const p of m.parts) {
    // (not the glass itself)
    if (p.mat.name === 'stained glass') continue;
    const mat = p.mat;
    const key = `${n}:` + holes.slice(0, 3).map((h) => h.min.toArray().map((v) => v.toFixed(2)).join(',')).join(';');
    mat.customProgramCacheKey = () => 'door-holes ' + key;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vHouse;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHouse = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vHouse;\nuniform vec3 uHoleA[${MAX_HOLES}];\nuniform vec3 uHoleB[${MAX_HOLES}];\nuniform int uHoleN;`)
        .replace('void main() {', `void main() {\n  for (int i = 0; i < ${MAX_HOLES}; i++) { if (i >= uHoleN) break; if (all(greaterThan(vHouse, uHoleA[i])) && all(lessThan(vHouse, uHoleB[i]))) discard; }`);
    };
  }
}

/** the most holes (doorways, windows) cut in one house */
const MAX_HOLES = 48;

/** the separate panes in a house's glass: its triangles gathered into pieces that touch, a box each */
function findPanes(geos: THREE.BufferGeometry[]): THREE.Box3[] {
  const tris: THREE.Box3[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const g of geos) {
    const p = g.getAttribute('position');
    for (let t = 0; t + 2 < p.count; t += 3) { a.fromBufferAttribute(p, t); b.fromBufferAttribute(p, t + 1); c.fromBufferAttribute(p, t + 2); tris.push(new THREE.Box3().setFromPoints([a, b, c])); }
  }
  // (pieces: triangles whose boxes, grown a finger's width, meet)
  const parent = tris.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const grown = tris.map((t) => t.clone().expandByScalar(0.03));
  for (let i = 0; i < tris.length; i++) for (let j = i + 1; j < tris.length; j++) if (grown[i].intersectsBox(grown[j])) parent[root(i)] = root(j);
  const boxes = new Map<number, THREE.Box3>();
  tris.forEach((t, i) => { const r = root(i); if (!boxes.has(r)) boxes.set(r, t.clone()); else boxes.get(r)!.union(t); });
  // (a pane is at least a hand across)
  return [...boxes.values()].filter((bx) => Math.max(bx.max.x - bx.min.x, bx.max.z - bx.min.z) > 0.15 && bx.max.y - bx.min.y > 0.15);
}

/** a soft round glow (a flame, its halo) — or, `square`, a soft-edged patch — from a hot middle to a faint rim */
function glowTexture(mid: number[], rim: number[], square = false): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  if (square) {
    // (a patch of light: even in the middle, fading over its last fifth)
    const img = g.createImageData(64, 64);
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
      const e = Math.min(i, 63 - i, j, 63 - j) / 12, a = Math.min(1, e) ** 2;
      img.data.set([mid[0], mid[1], mid[2], Math.round(255 * a)], (j * 64 + i) * 4);
    }
    g.putImageData(img, 0, 0);
  } else {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${mid.join(',')}, 1)`);
    grad.addColorStop(0.35, `rgba(${rim.join(',')}, 0.55)`);
    grad.addColorStop(1, `rgba(${rim.join(',')}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** the one door hung everywhere: planks on ledges, a latch; its hinge edge at x = 0, 1 × 1 (scaled to fit) */
function doorLeaf(): { geo: THREE.BufferGeometry; mat: THREE.Material } {
  const geo = new THREE.BoxGeometry(1, 1, 0.07).translate(0.5, 0.5, 0);
  return { geo, mat: new THREE.MeshStandardMaterial({ map: planks(true), roughness: 0.85, metalness: 0 }) };
}

/** boards side by side, each its own shade, dark seams between, two ledges across; `latch`: a door's */
function planks(latch: boolean): THREE.CanvasTexture {
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
  if (latch) {
    g.fillStyle = 'rgb(28, 26, 26)';
    g.fillRect(100, 118, 18, 8);
    g.beginPath(); g.arc(106, 132, 5, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** a thing to place: its model, where (u inland, v along), turned, leaning; its height if not on the ground;
 *  `deco`: something small set on something else (no say in who walks where) */
interface At { m: string; u: number; v: number; turn: number; tilt: number; y?: number; deco?: boolean }

export class TortugaTown {
  readonly group = new THREE.Group();
  private placed: Placed[] = [];
  /** the houses, and the things standing about (the latter in the way even on a house's floor) */
  private houses: Placed[] = [];
  private props: Placed[] = [];
  /** the tavern's inside: its frame (where it stands, turned); its lights and candle flames */
  private tavern: { x: number; y: number; z: number; turn: number } | null = null;
  private readonly lights: THREE.PointLight[] = [];
  private readonly flames: THREE.Sprite[] = [];
  /** the sun's red through the glass, on the floor (gone at night) */
  private readonly sunPatches: THREE.MeshBasicMaterial[] = [];
  private flicker = 0;
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

  /** once per frame: fetch the town when the ship comes near, draw it from close by, let it go far off */
  update(eye: THREE.Vector3, ship: THREE.Vector3): void {
    const d = (p: THREE.Vector3) => Math.hypot(p.x - TORTUGA_QUAY.x, p.z - (TORTUGA_QUAY.z0 + TORTUGA_QUAY.z1) / 2);
    const near = Math.min(d(eye), d(ship));
    if (this.state === 'waiting' && near < LOAD_R) { this.state = 'loading'; void this.load(); }
    if (this.state === 'ready' && near > FREE_R) this.free();
    this.group.visible = this.state === 'ready' && d(eye) < DRAW_R;
    if (this.group.visible)
      for (const m of this.group.children) {
        const r = m.userData.near as number | undefined;
        if (r) m.visible = eye.distanceTo(m.userData.at as THREE.Vector3) < r;
      }
  }

  /** the town let go of: its meshes and textures freed, its houses and doors forgotten (fetched again later) */
  private free(): void {
    const mats = new Set<THREE.Material>(), texs = new Set<THREE.Texture>();
    for (const o of this.group.children) {
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat);
      (m as THREE.InstancedMesh).dispose?.();
    }
    for (const mat of mats) {
      for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) texs.add(v as THREE.Texture);
      mat.dispose();
    }
    for (const t of texs) t.dispose();
    this.group.clear();
    this.placed = [];
    this.houses = [];
    this.props = [];
    this.tavern = null;
    this.lights.length = 0;
    this.flames.length = 0;
    this.sunPatches.length = 0;
    this.doors.length = 0;
    this.stairs.length = 0;
    this.doorMesh = null;
    this.seed = 987654321;
    this.state = 'waiting';
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
      const glass = def.glass;
      if (glass) for (const p of measured[name].parts) if (glass.test(p.mat.name)) p.mat = STAINED.clone();
      if (HOUSES.has(name) && !DOORLESS.has(name)) cutDoorways(measured[name]);
      await new Promise((r) => setTimeout(r, 0));
    }
    const at: At[] = [];
    this.layRows(measured, at);
    for (const [m, u, v, turn, tilt] of PROPS_AT) at.push({ m, u, v, turn, tilt: tilt ?? 0 });
    this.furnish(measured, at);
    // ---- the meshes: an instanced mesh per model part, a copy per placing ----
    const Q = TORTUGA_QUAY;
    for (const name of Object.keys(MODELS)) {
      const mine = at.filter((a) => a.m === name);
      if (!mine.length) continue;
      const m = measured[name];
      const mats = mine.map((a) => {
        const x = Q.x - a.u, z = a.v;
        const y = a.y ?? this.groundUnder(m, x, z, a.turn);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(a.tilt, a.turn, 0, 'YXZ'));
        // (what is set on a table is in nobody's way: the table is)
        if (!a.deco) {
          const pl = new Placed(m, x, y, z, a.turn);
          this.placed.push(pl);
          (HOUSES.has(name) ? this.houses : this.props).push(pl);
        }
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
        mesh.castShadow = (p.geo.boundingSphere?.radius ?? 0) > 1.5 && p.mat.name !== 'stained glass';
        mesh.receiveShadow = true;
        mesh.name = `town ${name}`;
        if (NEAR[name]) { mesh.userData.near = NEAR[name]; mesh.userData.at = new THREE.Vector3().setFromMatrixPosition(mats[0]); }
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

  /** once per frame: the doors move; the tavern's candles flicker, its lights lit when he is near it */
  tick(dt: number, eye?: THREE.Vector3, day = 1): void {
    if (this.state !== 'ready') return;
    this.swing(dt);
    const t = this.tavern;
    if (!t) return;
    this.flicker += dt;
    const near = eye ? Math.hypot(eye.x - t.x, eye.z - t.z) < 40 : false;
    const f = this.flicker;
    // (off, the lights are left out of the scene altogether: a light, even a dark one, costs every lit surface)
    this.lights.forEach((l, k) => { l.visible = near; l.intensity = 9 * (0.85 + 0.1 * Math.sin(f * 7.3 + k * 2) + 0.05 * Math.sin(f * 17.1 + k)); });
    for (const p of this.sunPatches) p.opacity = 0.32 * day;
    this.flames.forEach((s, k) => {
      const w = 1 + 0.15 * Math.sin(f * 11 + k * 1.7) + 0.08 * Math.sin(f * 23 + k);
      if (k % 2 === 0) s.scale.set(0.05 * w, 0.1 * (2 - w), 1);
      else (s.material as THREE.SpriteMaterial).opacity = 0.3 * w;
    });
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
  private layRows(measured: Record<string, Measured>, at: At[]): void {
    const Tn = TORTUGA_TOWN, S = Tn.square;
    const front1 = Tn.road.u + Tn.road.half + 0.8;
    // the first row's houses as they stand (along the road, and how deep): the second row closes up behind them
    const backs: { v0: number; v1: number; back: number }[] = [];
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
      // packed from the square outward, a few paces apart, round the lanes (and the square's sides)
      const keepClear = (v0: number, v1: number) => Tn.lanes.some((l) => v1 > l - Tn.laneHalf - 0.8 && v0 < l + Tn.laneHalf + 0.8)
        || (r.row === 1 && v1 > S.v0 - 1 && v0 < S.v1 + 1) || (r.row === 2 && v1 > S.v0 - 8 && v0 < S.v1 + 8);
      let edge = r.from;
      const left = [...houses];
      while (left.length) {
        // the next house that fits before a lane (the first in line that does — a smaller one fills the gap
        // before a lane a bigger one wouldn't), else on past the lane
        const gap = 1.5 + this.rnd() * 2, near = edge + r.out * gap;
        const span = (h: { along: number }, n: number) => (r.out > 0 ? [n, n + h.along] : [n - h.along, n]) as [number, number];
        const k = left.findIndex((h) => !keepClear(...span(h, near)));
        if (k < 0) {
          // nothing fits here: step on (past the lane) and try again
          edge += r.out;
          if (r.out > 0 ? edge > r.to : edge < r.to) break;
          continue;
        }
        const h = left.splice(k, 1)[0], [v0, v1] = span(h, near);
        if (r.out > 0 ? v1 > r.to : v0 < r.to) break;
        // first row: its front a step back from the road; second: its back to the trees
        // first row: its front a step back from the road; second: close behind the backs of the first-row
        // houses beside it (a yard's width), wherever they stand
        let u: number;
        if (r.row === 1) {
          u = front1 + h.across / 2 + this.rnd() * 1.2;
          backs.push({ v0, v1, back: u + h.across / 2 });
        } else {
          const behind = backs.filter((b) => b.v1 > v0 - 2 && b.v0 < v1 + 2).reduce((a, b) => Math.max(a, b.back), front1 + 6);
          u = Math.min(Tn.depth - h.across / 2, behind + 2.5 + this.rnd() * 1.5 + h.across / 2);
        }
        at.push({ m: h.name, u, v: (v0 + v1) / 2, turn: h.turn, tilt: 0 });
        edge = r.out > 0 ? v1 : v0;
      }
    }
    // the tavern across the square, its front to it; the fields of the square kept clear
    const tv = measured.tavern, turn = Math.PI / 2 - faceOf('tavern', tv);
    const across = (tv.box.max.x - tv.box.min.x) * Math.abs(Math.cos(turn)) + (tv.box.max.z - tv.box.min.z) * Math.abs(Math.sin(turn));
    at.push({ m: 'tavern', u: S.u1 + 1.5 + across / 2, v: 0, turn, tilt: 0 });
  }

  /**
   * The tavern's inside: its furniture put where TAVERN_IN says (turned with the house, on its floor or on a
   * table), and the rest made here in its frame — the counter, the candles' flames and the glow round them,
   * two warm lights over the hall, and the red of the sun through its stained glass laid on the floor under
   * each window.
   */
  private furnish(measured: Record<string, Measured>, at: At[]): void {
    const Q = TORTUGA_QUAY, tv = at.find((a) => a.m === 'tavern'), m = measured.tavern;
    if (!tv) return;
    const x = Q.x - tv.u, z = tv.v, turn = tv.turn, c = Math.cos(turn), s = Math.sin(turn);
    // the hall's floor (in the house: where its doorway's sill is)
    const floor = m.doors[0]?.y ?? 0.8;
    const y = this.groundUnder(m, x, z, turn) + floor;
    this.tavern = { x, y, z, turn };
    const top = (what?: string) => {
      if (!what || what === 'floor') return 0;
      if (what === 'counter') return COUNTER.height + 0.03;
      return measured[what].box.max.y;
    };
    for (const [name, lx, lz, lt, on, tilt] of TAVERN_IN) {
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      at.push({ m: name, u: Q.x - wx, v: wz, turn: turn + lt, tilt: tilt ?? 0, y: y + top(on), deco: !!on && on !== 'floor' });
    }
    // ---- in the house's frame ----
    const fx = new THREE.Group();
    fx.name = 'tavern inside';
    fx.position.set(x, y, z);
    fx.rotation.y = turn;
    // the counter: planked front and sides, a thick top
    // (boards laid along it, a few to its length)
    const boards = planks(false);
    boards.center.set(0.5, 0.5);
    boards.rotation = Math.PI / 2;
    boards.wrapS = boards.wrapT = THREE.RepeatWrapping;
    boards.repeat.set(1, 2.5);
    const wood = new THREE.MeshStandardMaterial({ map: boards, roughness: 0.85, metalness: 0, envMapIntensity: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(COUNTER.depth, COUNTER.height, COUNTER.z1 - COUNTER.z0), wood);
    body.position.set(COUNTER.x, COUNTER.height / 2, (COUNTER.z0 + COUNTER.z1) / 2);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(COUNTER.depth + 0.16, 0.06, COUNTER.z1 - COUNTER.z0 + 0.12), new THREE.MeshStandardMaterial({ color: 0x3b2414, roughness: 0.8, envMapIntensity: 0.25 }));
    slab.position.set(COUNTER.x, COUNTER.height, (COUNTER.z0 + COUNTER.z1) / 2);
    for (const o of [body, slab]) { o.castShadow = o.receiveShadow = true; fx.add(o); }
    // the candles' flames, and a soft glow round each
    const flameTex = glowTexture([255, 236, 190], [255, 150, 60]), glowTex = glowTexture([255, 190, 110], [255, 120, 40]);
    const candleH = measured.candle.box.max.y;
    for (const [name, lx, lz, , on] of TAVERN_IN) {
      if (name !== 'candle') continue;
      const h = top(on) + candleH;
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      flame.scale.set(0.05, 0.1, 1);
      flame.position.set(lx, h + 0.05, lz);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 }));
      glow.scale.set(0.7, 0.7, 1);
      glow.position.copy(flame.position);
      fx.add(flame, glow);
      this.flames.push(flame, glow);
    }
    // two warm lights over the hall (few: every light costs every lit surface in the game its share)
    for (const lz of [-2, 3]) {
      const l = new THREE.PointLight(0xffa24a, 0, 9, 2);
      l.visible = false;
      l.position.set(-2, 2.1, lz);
      fx.add(l);
      this.lights.push(l);
    }
    // the red the sun throws through the glass: on the floor, a pace in from each window of the hall
    const red = glowTexture([255, 90, 70], [200, 40, 30], true);
    for (const b of m.panes ?? []) {
      if (b.min.y > floor + 2.2 || b.max.y < floor + 0.3) continue;
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      const thinX = b.max.x - b.min.x < b.max.z - b.min.z;
      // (in: toward the middle of the hall)
      const inX = thinX ? Math.sign(-2 - cx) : 0, inZ = thinX ? 0 : Math.sign(1 - cz);
      const wide = (thinX ? b.max.z - b.min.z : b.max.x - b.min.x) * 1.3;
      const patch = new THREE.Mesh(new THREE.PlaneGeometry(thinX ? 1.5 : wide, thinX ? wide : 1.5), new THREE.MeshBasicMaterial({
        map: red, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      }));
      this.sunPatches.push(patch.material as THREE.MeshBasicMaterial);
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(cx + inX * 1.0, 0.03, cz + inZ * 1.0);
      fx.add(patch);
    }
    // its floor, a warmer stone (it came blue-grey)
    for (const p of m.parts) if (p.mat.name === 'Ground_Peables_01') (p.mat as THREE.MeshStandardMaterial).color.setRGB(0.82, 0.68, 0.55);
    this.group.add(fx);
  }

  /** is (x, z) the tavern's counter? */
  private counterAt(x: number, z: number): boolean {
    const t = this.tavern;
    if (!t) return false;
    const c = Math.cos(t.turn), s = Math.sin(t.turn), dx = x - t.x, dz = z - t.z;
    const a = dx * c - dz * s, b = dx * s + dz * c;
    return Math.abs(a - COUNTER.x) < COUNTER.depth / 2 + 0.1 && b > COUNTER.z0 - 0.1 && b < COUNTER.z1 + 0.1;
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
    // things standing about, in the way wherever they stand (on a house's floor too); the tavern's counter
    for (const p of this.props) if (p.cell(x, z) === Cell.Block) return true;
    if (this.counterAt(x, z)) return true;
    // (a house's floor counts before its walls: overlapping houses, the one he is in wins)
    let wall = false;
    for (const p of this.houses) {
      const c = p.cell(x, z);
      if (c === Cell.Walk) return false;
      if (c === Cell.Block) wall = true;
    }
    return wall;
  }
}
