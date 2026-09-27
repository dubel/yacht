import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/*
 * Wooden structures built from models (the piers, wharves and shacks of Tortuga): a model is taken apart once
 * into one geometry per material (so however many times it is placed, it costs a draw call per material, an
 * instanced mesh each), and measured once — rays cast straight down on a fine grid over it tell where its
 * deck is (the level most of its flat, upward-facing surface lies at), where a man can walk (a surface near
 * that level with headroom over it), what stands in his way (walls, posts, barrels, anything rising above
 * the deck) and where there is anything at all (for the ship's hull to bump into). Each placed copy then
 * answers those questions in the world by turning the point into its own frame.
 */

/** the measuring grid (m) */
export const GRID = 0.25;
/** headroom a man needs over a surface to walk on it (m) */
const HEADROOM = 1.75;

export const enum Cell { Empty = 0, Walk = 1, Block = 2, Solid = 3 }

export interface StructureDef {
  url: string;
  /** scale, turn about the vertical (rad), applied before measuring */
  scale: number;
  turn: number;
  /** instead of `scale`: the size (m) its longest side across the ground is to have */
  size?: number;
  /** only this node of the file (a pack of several models: one of them) */
  pick?: string;
  /** parts left out (a ground plate, a base, grass): matched against mesh, node and material names */
  drop?: RegExp;
  /** set on its own ground: its middle over the origin, its foot (`ground`, in the file's units, or its lowest
   *  point) at y = 0 */
  centre?: boolean;
  ground?: number;
  /** a thing standing about (a barrel, a stall): all of it in the way, nothing to walk on */
  solid?: boolean;
  /**
   * A house: its walls in the way, its floors to walk on, and its doorways found (gaps in the walls between
   * the inside and out, for doors to be hung in). A house with no way in is left solid.
   */
  building?: boolean;
  /** a house's own door leaves (left out, and where they hung taken for its doorways) */
  doorParts?: RegExp;
  /** a house's way in, where it is known (in its frame after scaling and centring): the middle of the wall,
   *  and which way is out */
  doorAt?: { x: number; z: number; outX: number; outZ: number; width?: number };
}

/** a doorway found in a house's walls (in the model's frame): its middle on the floor, width, height, and
 *  which way is out (a unit vector across the wall) */
export interface Doorway {
  x: number;
  z: number;
  y: number;
  width: number;
  height: number;
  outX: number;
  outZ: number;
  /** how thick the wall is there (m): the hole cut through it spans this */
  depth: number;
  /** where the house's own door hung (its sill as it was: stepped up to), rather than a doorway made */
  own?: boolean;
}

export interface Measured {
  parts: { geo: THREE.BufferGeometry; mat: THREE.Material }[];
  /** the model's frame after scale and turn: its box, and the deck's height in it */
  box: THREE.Box3;
  deck: number;
  /** grid over the box (x0, z0, nx, nz): what each cell is, the walking height on Walk cells */
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  cell: Uint8Array;
  height: Float32Array;
  /** for cells with anything in them: the way out to the nearest empty cell (m, in the model's frame) */
  outX: Float32Array;
  outZ: Float32Array;
  /** how far the boards go (m, in the model's frame): the first and last column/row with a run of them */
  walk: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** a house's doorways (none: no way in) */
  doors: Doorway[];
  /** a house's window panes, where it has glass (filled in by the town) */
  panes?: THREE.Box3[];
}

/** take a loaded model apart (per material, transforms baked, scaled and turned) and measure it */
export function measure(root: THREE.Object3D, def: StructureDef): Measured {
  root.updateMatrixWorld(true);
  // (one model out of a pack: that node alone, where it stands in the file)
  const from = def.pick ? root.getObjectByName(def.pick) : root;
  if (!from) throw new Error(`structure ${def.url}: no node "${def.pick}"`);
  const meshes: THREE.Mesh[] = [], leaves: THREE.Mesh[] = [];
  const named = (m: THREE.Mesh, re: RegExp) => { const mat = Array.isArray(m.material) ? m.material[0] : m.material; return re.test(m.name) || re.test(m.parent?.name ?? '') || re.test(mat.name); };
  from.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (def.drop && named(m, def.drop)) return;
    if (def.doorParts && named(m, def.doorParts)) { leaves.push(m); return; }
    meshes.push(m);
  });
  // (a part repeated through the model — beams, posts — may come as one mesh drawn many times over: each copy
  // where it stands)
  const copies = (m: THREE.Mesh): THREE.Matrix4[] => {
    const im = m as THREE.InstancedMesh;
    if (!im.isInstancedMesh) return [m.matrixWorld];
    const out: THREE.Matrix4[] = [], t = new THREE.Matrix4();
    for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, t); out.push(m.matrixWorld.clone().multiply(t)); }
    return out;
  };
  // the scale: as given, or to make its longest side across the ground `size`
  let scale = def.scale;
  if (def.size) {
    const b = new THREE.Box3();
    for (const m of meshes) { m.geometry.computeBoundingBox(); for (const w of copies(m)) b.union(m.geometry.boundingBox!.clone().applyMatrix4(w)); }
    scale = def.size / Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  }
  const frame = new THREE.Matrix4().makeRotationY(def.turn).multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  // (a house's materials its own: the holes cut for its doors are cut in them alone)
  const own = new Map<THREE.Material, THREE.Material>();
  for (const m of meshes) {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    // (one material per mesh in these models; a multi-material mesh keeps its first)
    let mat = mats[0];
    if (def.building) { if (!own.has(mat)) own.set(mat, mat.clone()); mat = own.get(mat)!; }
    if (!byMat.has(mat)) byMat.set(mat, []);
    const base = floats(m.geometry);
    for (const w of copies(m)) byMat.get(mat)!.push(base.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(frame, w)));
  }
  const parts: Measured['parts'] = [];
  for (const [mat, gs] of byMat) {
    const keep = ['position', 'normal', 'uv'].filter((a) => gs.every((g) => g.getAttribute(a)));
    for (const g of gs) for (const a of Object.keys(g.attributes)) if (!keep.includes(a)) g.deleteAttribute(a);
    const geo = mergeGeometries(gs, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    parts.push({ geo, mat });
  }
  // ---- the measuring: every surface over each cell of a grid, top down ----
  // (each triangle sampled finely — walls and posts too, which rays from above would slip past — and each
  //  sample put in the cell under it with its height and how level the surface is)
  let box = new THREE.Box3();
  for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox!); }
  // the door leaves' boxes, in the same frame (and shifted with it below)
  const leafBoxes = leaves.map((m) => { m.geometry.computeBoundingBox(); const b = new THREE.Box3(); for (const w of copies(m)) b.union(m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(frame, w))); return b; });
  if (def.centre) {
    // its middle over the origin, its foot on y = 0
    const c = box.getCenter(new THREE.Vector3()), foot = def.ground !== undefined ? def.ground * scale : box.min.y;
    for (const p of parts) { p.geo.translate(-c.x, -foot, -c.z); p.geo.computeBoundingSphere(); }
    for (const b of leafBoxes) b.translate(new THREE.Vector3(-c.x, -foot, -c.z));
    box = new THREE.Box3();
    for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox!); }
  }
  const x0 = box.min.x, z0 = box.min.z;
  const nx = Math.ceil((box.max.x - x0) / GRID) || 1, nz = Math.ceil((box.max.z - z0) / GRID) || 1;
  const hits: { y: number; up: number }[][] = Array.from({ length: nx * nz }, () => []);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), E = new THREE.Vector3();
  const step = GRID * 0.5;
  for (const p of parts) {
    const pos = p.geo.getAttribute('position');
    for (let t = 0; t + 2 < pos.count; t += 3) {
      A.fromBufferAttribute(pos, t); B.fromBufferAttribute(pos, t + 1); C.fromBufferAttribute(pos, t + 2);
      N.subVectors(B, A).cross(E.subVectors(C, A));
      const len = N.length();
      if (len < 1e-10) continue;
      const up = Math.abs(N.y) / len;
      const n = Math.max(1, Math.ceil(Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A)) / step));
      for (let i = 0; i <= n; i++)
        for (let j = 0; i + j <= n; j++) {
          const u = i / n, v = j / n, w = 1 - u - v;
          const x = A.x * w + B.x * u + C.x * v, y = A.y * w + B.y * u + C.y * v, z = A.z * w + B.z * u + C.z * v;
          const ci = Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / GRID))), cj = Math.max(0, Math.min(nz - 1, Math.floor((z - z0) / GRID)));
          hits[cj * nx + ci].push({ y, up });
        }
    }
  }
  for (const hs of hits) hs.sort((p, q) => q.y - p.y);
  // the deck: the level where most flat, upward surface is
  const levels = new Map<number, number>();
  for (const hs of hits) for (const h of hs) if (h.up > 0.92) { const k = Math.round(h.y * 10); levels.set(k, (levels.get(k) ?? 0) + 1); }
  let deck = 0, most = 0;
  for (const [k, n] of levels) if (n > most) { most = n; deck = k / 10; }
  // refine: the mean of the surfaces within 5 cm of it
  { let s = 0, c = 0; for (const hs of hits) for (const h of hs) if (h.up > 0.92 && Math.abs(h.y - deck) < 0.06) { s += h.y; c++; } if (c) deck = s / c; }
  const cell = new Uint8Array(nx * nz), height = new Float32Array(nx * nz);
  let doors: Doorway[] = [];
  if (def.building) {
    // a house: in each cell, the lowest floor with a man's headroom over it — a floor in the model (a
    // raised one, the treads of a stair) or else the ground itself; none, and it is a wall, a post, a bed
    const foot = box.min.y;
    hits.forEach((hs, k) => {
      // (the lowest first: under a porch roof he walks on the ground, not on the roof; an upper floor is out
      // of reach for now)
      const cands = [foot, ...hs.filter((h) => h.up > 0.7 && h.y > foot - 0.3 && h.y < foot + 2.6).map((h) => h.y).sort((p, q) => p - q)];
      for (const c of cands) {
        let over = Infinity;
        for (let m = hs.length - 1; m >= 0; m--) if (hs[m].y > c + 0.06) { over = hs[m].y - c; break; }
        if (over < HEADROOM) continue;
        // (on the ground itself: nothing of the model underfoot — the terrain carries him)
        if (c === foot && !hs.some((h) => Math.abs(h.y - foot) < 0.06)) cell[k] = Cell.Empty;
        else { cell[k] = Cell.Walk; height[k] = c; }
        return;
      }
      cell[k] = Cell.Block;
    });
    // its doorways: where its own doors hung; else gaps found in its walls; else one made in the middle of
    // its front (+z: the side turned to the road)
    // (a leaf's parts — the boards, its handle, its ironwork — are one door: boxes that touch are merged)
    const leavesMerged: THREE.Box3[] = [];
    for (const b of leafBoxes) {
      const hit = leavesMerged.find((m) => m.clone().expandByScalar(0.25).intersectsBox(b));
      if (hit) hit.union(b); else leavesMerged.push(b.clone());
    }
    const D = def.doorAt;
    doors = D ? [{ x: D.x, z: D.z, y: foot, width: D.width ?? 1.2, height: 2.2, outX: D.outX, outZ: D.outZ, depth: 0.9 }]
      : leavesMerged.length ? leavesMerged.map((b) => doorFromLeaf(b, box)) : findDoorways(cell, height, hits, nx, nz, x0, z0, foot);
    if (!doors.length) { const d = frontDoor(cell, height, nx, nz, x0, z0, foot); if (d) doors.push(d); }
    // the way through each: floor, not wall — at the level of the floor just inside it (the ground, if the
    // house has no floor of its own there)
    const before = cell.slice(), beforeH = height.slice();
    const at = (x: number, z: number) => { const i = Math.floor((x - x0) / GRID), j = Math.floor((z - z0) / GRID); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; };
    for (const d of doors) {
      const hw = d.width / 2 - 0.05, reach = d.depth / 2 + 0.4;
      let inner = foot;
      for (let t = d.depth / 2 + 0.3; t < d.depth / 2 + 2; t += GRID) {
        const k = at(d.x - d.outX * t, d.z - d.outZ * t);
        if (k < 0 || before[k] === Cell.Block) continue;
        inner = before[k] === Cell.Walk ? beforeH[k] : foot;
        break;
      }
      // (the house's own doorway keeps its sill, up its steps; one made opens on the floor inside)
      if (!d.own) d.y = inner;
      const sill = d.y;
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          const x = x0 + (i + 0.5) * GRID - d.x, z = z0 + (j + 0.5) * GRID - d.z;
          const across = x * d.outX + z * d.outZ, along = Math.abs(x * d.outZ - z * d.outX);
          if (along > hw || Math.abs(across) > reach) continue;
          const k = j * nx + i;
          if (sill - foot < 0.08) cell[k] = Cell.Empty; else { cell[k] = Cell.Walk; height[k] = sill; }
        }
    }
    if (!doors.length) fillInside(cell, nx, nz);
  } else if (def.solid) {
    // a building: whatever stands above its foot is in the way (a threshold, a paving stone underfoot is not)
    hits.forEach((hs, k) => { if (hs.some((h) => h.y > box.min.y + 0.25)) cell[k] = Cell.Block; });
    // (its inside too: a closed ring of walls round empty floor)
    fillInside(cell, nx, nz);
  } else hits.forEach((hs, k) => {
    // (hits come nearest first: top down)
    let walk = 0, found = false;
    for (let n = 0; n < hs.length; n++) {
      const h = hs[n];
      if (h.up < 0.7 || h.y < deck - 0.7 || h.y > deck + 1.3) continue;
      // headroom: nothing over it for a man's height (a roof high above is fine; the same surface's other
      // samples, within a few cm, don't count)
      let over = Infinity;
      for (let m = n - 1; m >= 0; m--) if (hs[m].y - h.y > 0.06) { over = hs[m].y - h.y; break; }
      if (over >= HEADROOM) { walk = h.y; found = true; break; }
    }
    if (found) { cell[k] = Cell.Walk; height[k] = walk; }
    else if (hs.some((h) => h.y > deck - 0.6)) cell[k] = Cell.Block;
    else if (hs.length) cell[k] = Cell.Solid;
  });
  // the boards, not the gaps between them: a cell takes the highest floor round it (a beam seen through a
  // crack isn't where a foot goes), and an empty crack between floor cells is floor
  const at0 = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i);
  for (let pass = 0; pass < 2; pass++) {
    const was = cell.slice(), wasH = height.slice();
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (was[k] === Cell.Block) continue;
        let top = -Infinity, n = 0;
        for (let b = -1; b <= 1; b++)
          for (let a = -1; a <= 1; a++) {
            const q = at0(i + a, j + b);
            if (q < 0 || was[q] !== Cell.Walk) continue;
            n++;
            top = Math.max(top, wasH[q]);
          }
        if (was[k] === Cell.Walk) { if (top - height[k] < 0.7) height[k] = top; }
        else if (n >= 5) { cell[k] = Cell.Walk; height[k] = top; }
      }
  }
  // a lone walkable cell hemmed in by obstacles, or a rail's top: not a floor (needs walkable neighbours)
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz ? Cell.Empty : cell[j * nx + i]);
  for (let pass = 0; pass < 2; pass++)
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (cell[k] !== Cell.Walk) continue;
        let n = 0;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (at(i + a, j + b) === Cell.Walk) n++;
        if (n < 2) cell[k] = Cell.Block;
      }
  // ---- the way out of anything, to the nearest empty cell (for the hull: pushed off it) ----
  const outX = new Float32Array(nx * nz), outZ = new Float32Array(nx * nz);
  const tx = new Int32Array(nx * nz).fill(-1), tz = new Int32Array(nx * nz).fill(-1);
  const d2 = new Float32Array(nx * nz).fill(Infinity);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (cell[j * nx + i] === Cell.Empty) { const k = j * nx + i; tx[k] = i; tz[k] = j; d2[k] = 0; }
  // (outside the box counts as empty: seed the border cells with the edge beyond them)
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (d2[k] === 0) continue;
    const opts: [number, number][] = [[-1, j], [nx, j], [i, -1], [i, nz]];
    for (const [a, b] of opts) { const d = (a - i) ** 2 + (b - j) ** 2; if (d < d2[k]) { d2[k] = d; tx[k] = a; tz[k] = b; } }
  }
  const relax = (i: number, j: number, a: number, b: number) => {
    if (a < 0 || b < 0 || a >= nx || b >= nz) return;
    const k = j * nx + i, n = b * nx + a;
    if (tx[n] === -1 && d2[n] === Infinity) return;
    const d = (tx[n] - i) ** 2 + (tz[n] - j) ** 2;
    if (d < d2[k]) { d2[k] = d; tx[k] = tx[n]; tz[k] = tz[n]; }
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { relax(i, j, i - 1, j); relax(i, j, i, j - 1); relax(i, j, i - 1, j - 1); relax(i, j, i + 1, j - 1); }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) { relax(i, j, i + 1, j); relax(i, j, i, j + 1); relax(i, j, i + 1, j + 1); relax(i, j, i - 1, j + 1); }
  for (let k = 0; k < nx * nz; k++) {
    if (cell[k] === Cell.Empty) continue;
    const i = k % nx, j = (k - i) / nx;
    outX[k] = (tx[k] - i) * GRID;
    outZ[k] = (tz[k] - j) * GRID;
  }
  // how far the boards go (a column or row counts with a few of them in it)
  const cols = new Int32Array(nx), rows = new Int32Array(nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (cell[j * nx + i] === Cell.Walk) { cols[i]++; rows[j]++; }
  const first = (a: Int32Array) => Math.max(0, a.findIndex((v) => v >= 4)), last = (a: Int32Array) => { for (let k = a.length - 1; k >= 0; k--) if (a[k] >= 4) return k; return a.length - 1; };
  const walk = { minX: x0 + first(cols) * GRID, maxX: x0 + (last(cols) + 1) * GRID, minZ: z0 + first(rows) * GRID, maxZ: z0 + (last(rows) + 1) * GRID };
  return { parts, box, deck, x0, z0, nx, nz, cell, height, outX, outZ, walk, doors };
}

/** a copy with plain float attributes (quantised ones would clip when transformed) and no index */
function floats(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const idx = g.index;
  const n = idx ? idx.count : g.getAttribute('position').count;
  for (const [name, a] of Object.entries(g.attributes)) {
    const k = a.itemSize, arr = new Float32Array(n * k);
    for (let v = 0; v < n; v++) { const s = idx ? idx.getX(v) : v; for (let c = 0; c < k; c++) arr[v * k + c] = a.getComponent(s, c); }
    out.setAttribute(name, new THREE.BufferAttribute(arr, k));
  }
  return out;
}

/** one placed copy of a measured model: where it stands in the world, and its questions answered there */
export class Placed {
  private readonly c: number;
  private readonly s: number;
  /** its box in the world, for a quick "not near" */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  constructor(readonly m: Measured, readonly x: number, readonly y: number, readonly z: number, readonly turn: number) {
    this.c = Math.cos(turn);
    this.s = Math.sin(turn);
    const pts = [[m.box.min.x, m.box.min.z], [m.box.max.x, m.box.min.z], [m.box.min.x, m.box.max.z], [m.box.max.x, m.box.max.z]].map(([a, b]) => this.toWorld(a, b));
    this.minX = Math.min(...pts.map((p) => p[0])); this.maxX = Math.max(...pts.map((p) => p[0]));
    this.minZ = Math.min(...pts.map((p) => p[1])); this.maxZ = Math.max(...pts.map((p) => p[1]));
  }

  /** the model-frame point → world (x, z) */
  toWorld(a: number, b: number): [number, number] {
    // (a turn θ about the vertical: x' = x cos θ + z sin θ, z' = −x sin θ + z cos θ)
    return [this.x + a * this.c + b * this.s, this.z - a * this.s + b * this.c];
  }

  /** the grid index at world (x, z), or −1 */
  index(x: number, z: number): number {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return -1;
    const dx = x - this.x, dz = z - this.z;
    const a = dx * this.c - dz * this.s, b = dx * this.s + dz * this.c;
    const m = this.m, i = Math.floor((a - m.x0) / GRID), j = Math.floor((b - m.z0) / GRID);
    if (i < 0 || j < 0 || i >= m.nx || j >= m.nz) return -1;
    return j * m.nx + i;
  }

  cell(x: number, z: number): Cell {
    const k = this.index(x, z);
    return k < 0 ? Cell.Empty : (this.m.cell[k] as Cell);
  }

  /** the walking height at world (x, z) (only on Walk cells) */
  height(x: number, z: number): number {
    return this.m.height[this.index(x, z)] + this.y;
  }

  /** the way out (world x, z) from inside it at (x, z), or null when (x, z) is clear of it */
  out(x: number, z: number): [number, number] | null {
    const k = this.index(x, z);
    if (k < 0 || this.m.cell[k] === Cell.Empty) return null;
    const a = this.m.outX[k], b = this.m.outZ[k];
    return [a * this.c + b * this.s, -a * this.s + b * this.c];
  }
}

/**
 * A building's inside, in the way too: every empty cell that can't be reached from outside the grid — with
 * the walls thickened a little while looking, so a doorway doesn't count as a way in (no going into houses
 * that have nothing inside them).
 */
function fillInside(cell: Uint8Array, nx: number, nz: number): void {
  const R = 3;
  const wall = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      if (cell[j * nx + i] !== Cell.Block) continue;
      for (let b = Math.max(0, j - R); b <= Math.min(nz - 1, j + R); b++)
        for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++) wall[b * nx + a] = 1;
    }
  const out = new Uint8Array(nx * nz), q: number[] = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if ((i === 0 || j === 0 || i === nx - 1 || j === nz - 1) && !wall[j * nx + i]) { out[j * nx + i] = 1; q.push(j * nx + i); }
  while (q.length) {
    const k = q.pop()!, i = k % nx, j = (k - i) / nx;
    for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const n = b * nx + a;
      if (out[n] || wall[n]) continue;
      out[n] = 1;
      q.push(n);
    }
  }
  // the thickening round the outside of the walls is outside too: a few steps in from what the fill reached
  let front: number[] = [];
  for (let k = 0; k < nx * nz; k++) if (out[k]) front.push(k);
  for (let step = 0; step < R + 1; step++) {
    const next: number[] = [];
    for (const k of front) {
      const i = k % nx, j = (k - i) / nx;
      for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const n = b * nx + a;
        if (out[n] || cell[n] !== Cell.Empty) continue;
        out[n] = 1;
        next.push(n);
      }
    }
    front = next;
  }
  // what is left, walled in: the inside
  for (let k = 0; k < nx * nz; k++) if (cell[k] === Cell.Empty && !out[k]) cell[k] = Cell.Block;
}

/**
 * Downloaded models' materials, made fit for the tropical sun: many come marked as bare metal, polished, which
 * a model viewer with no sky shows as painted wood and stone, but under the game's sky they mirror it and turn
 * white. Only what is named metal keeps some metal; nothing is polished; the sky's reflection kept down.
 */
export function tame(mat: THREE.Material): void {
  const m = mat as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return;
  const metal = /metal|iron|steel|anvil|nail|hinge/i.test(m.name);
  // (old iron, not chrome: hoops and hinges that mirror the sky read as glass from a few paces)
  m.metalness = metal ? Math.min(m.metalness, 0.3) : Math.min(m.metalness, 0.05);
  m.roughness = Math.max(m.roughness, 0.6);
  m.envMapIntensity = 0.5;
  // (see-through leaves, thatch, cloth: cut out rather than blended — blended, they sort badly among the rest)
  if (m.transparent && m.opacity >= 0.99) { m.transparent = false; m.depthWrite = true; m.alphaTest = Math.max(m.alphaTest, 0.5); }
  // (a metal-roughness texture would bring back the metal the numbers took away)
  if (!metal) m.metalnessMap = null;
  m.needsUpdate = true;
}

/**
 * The doorways of a house: gaps in its walls, a door's width, with the inside on one side and the outside on
 * the other. The walls are the grid's Block cells; the inside is what they enclose (found with the walls
 * thickened a little, so the gaps themselves don't let the outside in).
 */
function findDoorways(cell: Uint8Array, height: Float32Array, hits: { y: number; up: number }[][], nx: number, nz: number, x0: number, z0: number, foot: number): Doorway[] {
  const R = 3, N = nx * nz;
  const wall = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && cell[j * nx + i] === Cell.Block;
  // the walls thickened; what the outside reaches round them; the rest, not wall: the inside
  const thick = new Uint8Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (wall(i, j))
    for (let b = Math.max(0, j - R); b <= Math.min(nz - 1, j + R); b++) for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++) thick[b * nx + a] = 1;
  const flood = (open: (k: number) => boolean): Uint8Array => {
    const seen = new Uint8Array(N), q: number[] = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if ((i === 0 || j === 0 || i === nx - 1 || j === nz - 1) && open(j * nx + i)) { seen[j * nx + i] = 1; q.push(j * nx + i); }
    while (q.length) {
      const k = q.pop()!, i = k % nx, j = (k - i) / nx;
      for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const n = b * nx + a;
        if (!seen[n] && open(n)) { seen[n] = 1; q.push(n); }
      }
    }
    return seen;
  };
  const outside = flood((k) => !thick[k]);
  const inside = new Uint8Array(N);
  let insideCount = 0;
  for (let k = 0; k < N; k++) if (!thick[k] && !outside[k]) { inside[k] = 1; insideCount++; }
  // (a room a man can stand in, at least)
  if (insideCount < 30) return [];
  // does the true outside (walls not thickened) get in at all?
  const reach = flood((k) => cell[k] !== Cell.Block);
  let open = false;
  for (let k = 0; k < N; k++) if (inside[k] && reach[k]) { open = true; break; }
  if (!open) return [];
  // the gap cells: between two ends of wall along one axis (a door's width apart at most), with the inside a
  // few cells one way across it and the outside the other way
  const gap = new Int8Array(N); // 0 none; ±1: across is +z/−z out (wall along x); ±2: across is +x/−x out
  const MAXW = 8, LOOK = 7;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (cell[k] === Cell.Block || !reach[k]) continue;
      for (const along of [0, 1]) {
        const di = along === 0 ? 1 : 0, dj = along === 0 ? 0 : 1;
        let a = 1, b = 1;
        while (a <= MAXW && !wall(i - di * a, j - dj * a)) a++;
        while (b <= MAXW && !wall(i + di * b, j + dj * b)) b++;
        if (a > MAXW || b > MAXW || a + b - 1 > MAXW || a + b - 1 < 3) continue;
        // across it: the inside one way, the outside the other
        const ci = dj, cj = di;
        const sideIs = (s: number, what: Uint8Array) => { for (let t = 1; t <= LOOK; t++) { const ii = i + ci * s * t, jj = j + cj * s * t; if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) return what === outside; if (what[jj * nx + ii]) return true; } return false; };
        const code = along === 0 ? 1 : 2;
        if (sideIs(1, inside) && sideIs(-1, outside)) gap[k] = -code as -1 | -2;
        else if (sideIs(-1, inside) && sideIs(1, outside)) gap[k] = code as 1 | 2;
      }
    }
  // each run of gap cells: one doorway
  const seen = new Uint8Array(N), out: Doorway[] = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (!gap[k0] || seen[k0]) continue;
    const code = gap[k0], q = [k0], group: number[] = [];
    seen[k0] = 1;
    while (q.length) {
      const k = q.pop()!, i = k % nx, j = (k - i) / nx;
      group.push(k);
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const ii = i + a, jj = j + b;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const n = jj * nx + ii;
        if (!seen[n] && gap[n] === code) { seen[n] = 1; q.push(n); }
      }
    }
    if (group.length < 3) continue;
    const alongX = Math.abs(code) === 1;
    let si = Infinity, ai = -Infinity, sj = Infinity, aj = -Infinity;
    for (const k of group) { const i = k % nx, j = (k - i) / nx; si = Math.min(si, i); ai = Math.max(ai, i); sj = Math.min(sj, j); aj = Math.max(aj, j); }
    const width = ((alongX ? ai - si : aj - sj) + 1) * GRID;
    if (width < 0.6) continue;
    // its floor, and its lintel: the lowest thing over the gap above head height
    let floor = foot, top = Infinity;
    for (const k of group) {
      if (cell[k] === Cell.Walk) floor = Math.max(floor, height[k]);
      for (const h of hits[k]) if (h.y > floor + 1.5) top = Math.min(top, h.y);
    }
    const outSign = code > 0 ? 1 : -1;
    // (the doorway's line: the middle of its run across the wall)
    out.push({
      x: x0 + ((si + ai) / 2 + 0.5) * GRID, z: z0 + ((sj + aj) / 2 + 0.5) * GRID, y: floor,
      width, height: Math.min(2.3, Math.max(1.8, (top === Infinity ? floor + 2.1 : top) - floor)),
      outX: alongX ? 0 : outSign, outZ: alongX ? outSign : 0, depth: ((alongX ? aj - sj : ai - si) + 1) * GRID + 0.2,
    });
  }
  // (doorways run into each other along a thick wall: one door each, the widest)
  return out.filter((d, i) => !out.some((e, j) => j !== i && Math.hypot(e.x - d.x, e.z - d.z) < 1.2 && (e.width > d.width || (e.width === d.width && j < i))));
}

/** a doorway where a door leaf hung: its box (thin across the wall) gives the width, height and the wall */
function doorFromLeaf(b: THREE.Box3, house: THREE.Box3): Doorway {
  const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
  const c = b.getCenter(new THREE.Vector3()), hc = house.getCenter(new THREE.Vector3());
  // (the leaf lies along the wall: the thin way across is out, away from the middle of the house)
  const acrossX = sx < sz;
  const out = acrossX ? Math.sign(c.x - hc.x) || 1 : Math.sign(c.z - hc.z) || 1;
  return {
    x: c.x, z: c.z, y: b.min.y, width: Math.min(1.6, Math.max(0.8, acrossX ? sz : sx)), height: Math.min(2.4, Math.max(1.8, b.max.y - b.min.y)),
    outX: acrossX ? out : 0, outZ: acrossX ? 0 : out, depth: 0.6, own: true,
  };
}

/**
 * A doorway made where the house has none: in the middle of its front (+z), where the wall is — the first
 * run of wall cells coming in from outside at the middle — a man's width.
 */
function frontDoor(cell: Uint8Array, height: Float32Array, nx: number, nz: number, x0: number, z0: number, foot: number): Doorway | null {
  // (the middle column, and a little either side of it if the middle has a post in it)
  for (const off of [0, 2, -2, 4, -4, 6, -6]) {
    const i = Math.floor(nx / 2) + off;
    let outer = -1;
    for (let j = nz - 1; j >= 0; j--) if (cell[j * nx + i] === Cell.Block) { outer = j; break; }
    if (outer < 0) continue;
    let inner = outer;
    while (inner > 0 && cell[(inner - 1) * nx + i] === Cell.Block) inner--;
    // (a wall, not the whole depth of a solid thing)
    if (outer - inner > 6 || inner === 0) continue;
    // the floor inside, behind it
    const k = Math.max(0, inner - 2) * nx + i;
    const y = cell[k] === Cell.Walk ? height[k] : foot;
    return { x: x0 + (i + 0.5) * GRID, z: z0 + ((inner + outer) / 2 + 0.5) * GRID, y, width: 1.1, height: 2.1, outX: 0, outZ: 1, depth: (outer - inner + 1) * GRID + 0.1 };
  }
  return null;
}
