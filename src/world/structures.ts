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
}

/** take a loaded model apart (per material, transforms baked, scaled and turned) and measure it */
export function measure(root: THREE.Object3D, def: StructureDef): Measured {
  const frame = new THREE.Matrix4().makeRotationY(def.turn).multiply(new THREE.Matrix4().makeScale(def.scale, def.scale, def.scale));
  root.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = floats(m.geometry).applyMatrix4(new THREE.Matrix4().multiplyMatrices(frame, m.matrixWorld));
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    // (one material per mesh in these models; a multi-material mesh keeps its first)
    const mat = mats[0];
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat)!.push(g);
  });
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
  const box = new THREE.Box3();
  for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox!); }
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
  hits.forEach((hs, k) => {
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
  return { parts, box, deck, x0, z0, nx, nz, cell, height, outX, outZ, walk };
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
