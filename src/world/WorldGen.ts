import { fbm, mulberry32, smoothstep, vnoise } from '../core/noise';

/**
 * The world's heightfield: the hand-made home lagoon at the origin plus an endless procedural ocean around
 * it. Analytic and deterministic (the same (x, z) always gives the same height, on the main thread and in
 * the terrain worker), so physics queries `terrainHeight` directly and nothing has to be read back.
 * Heights are metres relative to mean water level (y = 0).
 *
 * The ocean is divided into CELL-sized cells; each cell's features (islands, cays, rock stacks, atolls,
 * shoals) come from a hash of the cell index and the world seed. A slowly varying "archipelago" field
 * decides how busy a region is, so there are clusters of islands with stretches of open sea between them.
 * Every feature has an influence radius beyond which it lies well below the ocean floor, which lets the
 * renderer skip open-ocean tiles without evaluating a single height.
 */

export interface Island {
  x: number;
  z: number;
  radius: number;
  peak: number;
  /** 0 = soft jungle hill, 1 = craggy rock */
  rock: number;
  /** elongation along a direction (sandbars) */
  stretch?: [number, number, number];
  /** height of the shoreline shelf above water (m) */
  shore?: number;
}

/** a ring reef enclosing a shallow lagoon, with navigable passes */
export interface Lagoon {
  x: number;
  z: number;
  radius: number;
  /** x-stretch of the (slightly elliptical) ring */
  ellipse: number;
  /** pass directions (radians, atan2(dz, dx)) */
  passes: number[];
  islands: Island[];
  /** keep the start area and its surroundings clear of coral (home lagoon only) */
  clearStart?: boolean;
}

type Feature =
  | { kind: 'island'; isl: Island; reach: number }
  | { kind: 'lagoon'; lag: Lagoon; reach: number };

const LAGOON_FLOOR = -4.6;
/** open-ocean floor; deep enough that the water hides it completely (see WATER_SIG_T) */
const OCEAN_FLOOR = -48;
/** below this a tile shows nothing through the water: the renderer skips it */
export const INVISIBLE_DEPTH = -40;

// ---------------------------------------------------------------- the home lagoon (hand-made)

const HOME: Lagoon = {
  x: 0,
  z: 0,
  radius: 430,
  ellipse: 1.08,
  // south-east (the original pass by the "Przejście w rafie" mark), north, west
  passes: [0.62, -1.9, 3.02],
  clearStart: true,
  islands: [
    { x: -175, z: -130, radius: 95, peak: 38, rock: 0.35 },
    { x: 195, z: -45, radius: 55, peak: 16, rock: 0.15 },
    { x: 40, z: -240, radius: 17, peak: 9, rock: 1 },
    { x: 95, z: 120, radius: 26, peak: 0.25, rock: 0, stretch: [0.8, 0.6, 2.4], shore: 0.35 },
    { x: -70, z: 235, radius: 40, peak: 13, rock: 0.25 },
    { x: -250, z: 120, radius: 12, peak: 6, rock: 0.9 },
  ],
};

// ---------------------------------------------------------------- shapes

const smax = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

function islandHeight(isl: Island, x: number, z: number): number {
  let dx = x - isl.x, dz = z - isl.z;
  if (isl.stretch) {
    const [cx, cz, s] = isl.stretch;
    const a = dx * cx + dz * cz, b = -dx * cz + dz * cx;
    dx = a / s;
    dz = b;
  }
  // wobbly coastline
  const wob = 1 + 0.42 * (fbm(x / 55 + isl.x, z / 55 + isl.z, 3) - 0.5);
  const d = Math.hypot(dx, dz) / wob;
  const R = isl.radius;
  const shore = isl.shore ?? 1.1;
  if (d < R) {
    const r = d / R;
    const dome = Math.pow(1 - r * r, 1.4);
    const bumps = fbm(x / 22, z / 22, 4) - 0.5;
    const crag = isl.rock * Math.abs(fbm(x / 9, z / 9, 3) - 0.5) * 2;
    return shore + isl.peak * dome * (0.8 + 0.5 * bumps + 0.35 * crag);
  }
  // underwater shoulder: gentle beach shelf, then steeper (keeps falling, below the ocean floor far out)
  const o = d - R;
  return shore - o * 0.1 - Math.max(0, o - 14) * 0.22 * (1 + isl.rock);
}

/** distance beyond which an island is certainly more than 4 m under the ocean floor */
function islandReach(isl: Island): number {
  // (the shape is measured in a frame shrunk by the stretch and the ≤ 1.21 coastline wobble, so both scale
  //  the whole distance: shore, 14 m shelf, then ≥ 0.32 m/m down to 4 m below the deepest floor)
  const s = isl.stretch ? Math.max(isl.stretch[2], 1) : 1;
  return s * 1.22 * (isl.radius + 14 + (Math.abs(OCEAN_FLOOR) + 12) / (0.1 + 0.22 * (1 + isl.rock))) + 10;
}

const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

function lagoonHeight(L: Lagoon, x: number, z: number): number {
  const lx = x - L.x, lz = z - L.z;
  // lagoon floor: broad undulation + sand waves + scattered coral heads
  let h = LAGOON_FLOOR + 1.4 * (fbm(x / 140, z / 140, 3) - 0.5) + 0.35 * (vnoise(x / 18, z / 18) - 0.5);
  const coral = smoothstep(0.72, 0.9, fbm(x / 26 + 40, z / 26 - 13, 3));
  h += coral * 3.1;

  // keep the start area and a channel to the east open and navigable
  if (L.clearStart) {
    const startClear = smoothstep(80, 25, Math.hypot(lx, lz));
    h = h - startClear * Math.max(0, h + 3.2);
  }

  for (const isl of L.islands) h = smax(h, islandHeight(isl, x, z), 4);

  // barrier reef ring (slightly elliptical), cut by the passes
  const rd = Math.hypot(lx / L.ellipse, lz);
  const ang = Math.atan2(lz, lx);
  let pass = 0;
  for (const p of L.passes) pass = Math.max(pass, smoothstep(0.22, 0.08, angDiff(ang, p) * (430 / L.radius)));
  const crest = -0.35 + 0.8 * (fbm(x / 30, z / 30, 3) - 0.5) - pass * 5.5;
  const reef = crest - Math.pow(Math.abs(rd - L.radius) / 22, 2) * 3.2;
  h = smax(h, reef, 3);
  // the fore-reef slope outside the ring, then down past the open-ocean floor
  const outside = smoothstep(L.radius + 10, L.radius + 70, rd);
  const slope = -26 + 6 * fbm(x / 80, z / 80, 2) - 30 * smoothstep(L.radius + 80, L.radius + 400, rd);
  return h * (1 - outside) + Math.min(h, slope) * outside;
}

function lagoonReach(L: Lagoon): number {
  return L.radius * Math.max(L.ellipse, 1) + 420;
}

function featureHeight(f: Feature, x: number, z: number): number {
  return f.kind === 'island' ? islandHeight(f.isl, x, z) : lagoonHeight(f.lag, x, z);
}

function featureCenter(f: Feature): [number, number] {
  return f.kind === 'island' ? [f.isl.x, f.isl.z] : [f.lag.x, f.lag.z];
}

// ---------------------------------------------------------------- procedural cells

/** cell size (m); every feature's reach is well under one cell, so a 3×3 neighbourhood covers any point */
export const CELL = 2000;
let SEED = 1337;
const HOME_FEATURE: Feature = { kind: 'lagoon', lag: HOME, reach: lagoonReach(HOME) };
const cellCache = new Map<number, Feature[]>();

/** choose the procedural world (the home lagoon never changes) */
export function setWorldSeed(seed: number): void {
  SEED = seed | 0;
  cellCache.clear();
}

const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

function hashCell(i: number, j: number): number {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(SEED, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) | 0;
}

function randomIsland(rnd: () => number, x: number, z: number, type: 'high' | 'cay' | 'rock'): Island {
  if (type === 'high') {
    const radius = 40 + 110 * rnd() * rnd();
    return { x, z, radius, peak: 10 + radius * (0.15 + 0.3 * rnd()), rock: 0.1 + 0.45 * rnd() };
  }
  if (type === 'cay') {
    const a = rnd() * Math.PI * 2;
    return {
      x, z, radius: 14 + 26 * rnd(), peak: 0.2 + 1.8 * rnd() * rnd(), rock: 0, shore: 0.3 + 0.3 * rnd(),
      stretch: rnd() < 0.6 ? [Math.cos(a), Math.sin(a), 1.3 + 1.1 * rnd()] : undefined,
    };
  }
  return { x, z, radius: 7 + 14 * rnd(), peak: 6 + 20 * rnd(), rock: 0.85 + 0.15 * rnd() };
}

function randomAtoll(rnd: () => number, x: number, z: number): Lagoon {
  const radius = 220 + 330 * rnd();
  const ellipse = 0.9 + 0.25 * rnd();
  const passes: number[] = [];
  const np = 1 + Math.floor(rnd() * 3);
  const a0 = rnd() * Math.PI * 2;
  for (let k = 0; k < np; k++) passes.push(a0 + (k * Math.PI * 2) / np + (rnd() - 0.5) * 0.9);
  const islands: Island[] = [];
  // motus: low sandy islets on the ring, away from the passes
  const nm = 2 + Math.floor(rnd() * 5);
  for (let k = 0; k < nm; k++) {
    const a = rnd() * Math.PI * 2;
    if (passes.some((p) => angDiff(a, p) < 0.35)) continue;
    const m = randomIsland(rnd, x + Math.cos(a) * radius * ellipse, z + Math.sin(a) * radius, 'cay');
    m.stretch = [-Math.sin(a), Math.cos(a), 1.5 + 1.5 * rnd()]; // along the ring
    islands.push(m);
  }
  // sometimes a volcanic remnant in the middle
  if (rnd() < 0.35) islands.push(randomIsland(rnd, x + (rnd() - 0.5) * radius * 0.5, z + (rnd() - 0.5) * radius * 0.5, 'high'));
  return { x, z, radius, ellipse, passes, islands };
}

function cellFeatures(i: number, j: number): Feature[] {
  const key = cellKey(i, j);
  const hit = cellCache.get(key);
  if (hit) return hit;
  const out: Feature[] = [];
  const rnd = mulberry32(hashCell(i, j));
  const cx = (i + 0.5) * CELL, cz = (j + 0.5) * CELL;
  // how busy this region is: archipelagos and open ocean, over ~10 km
  const busy = smoothstep(0.38, 0.68, fbm(cx / 9000 + SEED * 0.013, cz / 9000 - SEED * 0.007, 2));
  const n = Math.floor(rnd() * (0.6 + 5.4 * busy) + 0.25 * busy);
  let atoll = false;
  for (let k = 0; k < n; k++) {
    const x = (i + 0.1 + 0.8 * rnd()) * CELL, z = (j + 0.1 + 0.8 * rnd()) * CELL;
    const r = rnd();
    let f: Feature;
    if (r < 0.14 && !atoll) {
      atoll = true;
      const lag = randomAtoll(rnd, x, z);
      f = { kind: 'lagoon', lag, reach: lagoonReach(lag) };
    } else {
      const isl = randomIsland(rnd, x, z, r < 0.55 ? 'high' : r < 0.82 ? 'cay' : 'rock');
      f = { kind: 'island', isl, reach: islandReach(isl) };
    }
    // the ocean around the home lagoon stays open for a while: no features overlapping its reef or slope
    const [fx, fz] = featureCenter(f);
    if (Math.hypot(fx, fz) < HOME_FEATURE.reach + f.reach + 300) continue;
    out.push(f);
  }
  if (i === 0 && j === 0) out.push(HOME_FEATURE);
  cellCache.set(key, out);
  return out;
}

const near: Feature[] = [];

/** features whose reach overlaps the axis-aligned box [x0,x1]×[z0,z1] */
function featuresIn(x0: number, z0: number, x1: number, z1: number, out: Feature[]): Feature[] {
  out.length = 0;
  const i0 = Math.floor(x0 / CELL) - 1, i1 = Math.floor(x1 / CELL) + 1;
  const j0 = Math.floor(z0 / CELL) - 1, j1 = Math.floor(z1 / CELL) + 1;
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      // the home lagoon lives in cell (0,0) but reaches into its neighbours
      for (const f of cellFeatures(i, j)) {
        const [fx, fz] = featureCenter(f);
        const dx = Math.max(x0 - fx, 0, fx - x1), dz = Math.max(z0 - fz, 0, fz - z1);
        if (dx * dx + dz * dz < f.reach * f.reach) out.push(f);
      }
    }
  return out;
}

function oceanFloor(x: number, z: number): number {
  return OCEAN_FLOOR + 6 * fbm(x / 80, z / 80, 2);
}

export function terrainHeight(x: number, z: number): number {
  const fs = featuresIn(x, z, x, z, near);
  let h = oceanFloor(x, z);
  for (const f of fs) h = smax(h, featureHeight(f, x, z), 4);
  return h;
}

/** true when nothing in the box rises above INVISIBLE_DEPTH (open ocean: no geometry needed) */
export function boxIsOpenOcean(x0: number, z0: number, x1: number, z1: number): boolean {
  return featuresIn(x0, z0, x1, z1, near).length === 0;
}

/** island summaries for debugging / maps */
export function featuresNear(x: number, z: number, radius: number): { kind: string; x: number; z: number; radius: number }[] {
  return featuresIn(x - radius, z - radius, x + radius, z + radius, []).map((f) =>
    f.kind === 'island' ? { kind: f.isl.rock > 0.8 ? 'rock' : f.isl.peak < 3 ? 'cay' : 'island', x: f.isl.x, z: f.isl.z, radius: f.isl.radius }
      : { kind: f === HOME_FEATURE ? 'home' : 'atoll', x: f.lag.x, z: f.lag.z, radius: f.lag.radius });
}

/** a lateral mark at a reef pass; `port` = red (left side when entering the lagoon from the sea, IALA A) */
export interface Gate {
  x: number;
  z: number;
  port: boolean;
}

/** channel marks for every reef pass of the lagoons within `radius` of (x, z) */
export function gatesNear(x: number, z: number, radius: number): Gate[] {
  const out: Gate[] = [];
  for (const f of featuresIn(x - radius, z - radius, x + radius, z + radius, [])) {
    if (f.kind !== 'lagoon') continue;
    const L = f.lag;
    // the pass is fully open within 0.08·430/R rad of its axis (see lagoonHeight): marks just inside that
    const half = (0.075 * 430) / L.radius;
    for (const a of L.passes) {
      // point on the (elliptical) reef line at angle b
      const onRing = (b: number, k = 1) => {
        const t = (L.radius * k) / Math.hypot(Math.cos(b) / L.ellipse, Math.sin(b));
        return [L.x + Math.cos(b) * t, L.z + Math.sin(b) * t];
      };
      const [cx, cz] = onRing(a);
      // entering = heading toward the lagoon centre; port side = left of that heading (y up: left = (fz, −fx))
      const fx = L.x - cx, fz = L.z - cz;
      for (const side of [-1, 1]) {
        let [gx, gz] = onRing(a + side * half);
        // keep the mark in navigable water: slide toward the pass axis if it sits on the reef
        for (let k = 0; k < 8 && terrainHeight(gx, gz) > -2.5; k++) {
          gx += (cx - gx) * 0.2;
          gz += (cz - gz) * 0.2;
        }
        out.push({ x: gx, z: gz, port: (gx - cx) * fz - (gz - cz) * fx > 0 });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- surface colour (vertex colours)

// sRGB → linear, once (the renderer works in linear)
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const C = (r: number, g: number, b: number): [number, number, number] => [lin(r), lin(g), lin(b)];
const SAND = C(0.86, 0.77, 0.58), WET_SAND = C(0.74, 0.65, 0.48), SEABED = C(0.8, 0.75, 0.6), WEED = C(0.3, 0.36, 0.2);
const CORAL = C(0.62, 0.52, 0.47), GRASS = C(0.24, 0.36, 0.12), JUNGLE = C(0.12, 0.22, 0.07), ROCK = C(0.46, 0.43, 0.39);
const DEEP = C(0.5, 0.52, 0.5);

const mix3 = (o: number[], b: readonly number[], t: number) => { o[0] += (b[0] - o[0]) * t; o[1] += (b[1] - o[1]) * t; o[2] += (b[2] - o[2]) * t; };
const set3 = (o: number[], a: readonly number[], k = 1) => { o[0] = a[0] * k; o[1] = a[1] * k; o[2] = a[2] * k; };
const scale3 = (o: number[], k: number) => { o[0] *= k; o[1] *= k; o[2] *= k; };

/** linear RGB of the ground at (x, z) with height h and normal-y ny, written to out[0..2] */
export function terrainColor(x: number, z: number, h: number, ny: number, out: number[]): void {
  const n1 = fbm(x / 12, z / 12, 3), n2 = vnoise(x / 3, z / 3);
  if (h < -0.4) {
    set3(out, SEABED, 0.85 + 0.3 * n2);
    const w = smoothstep(0.55, 0.75, fbm(x / 35 + 7, z / 35 - 3, 3)) * smoothstep(-1.5, -3.5, h);
    mix3(out, WEED, w * 0.85);
    const cor = smoothstep(0.72, 0.9, fbm(x / 26 + 40, z / 26 - 13, 3));
    if (cor > 0) {
      // coral tinted a little per head (the old HSL offset, approximately)
      const t = 0.08 * (n1 - 0.5) * 6;
      const c = [CORAL[0] * (1 + t), CORAL[1] * (1 - 0.3 * t) * (1 + 0.1 * n2), CORAL[2] * (1 - t)];
      mix3(out, c, cor * 0.9);
    }
    if (h < -8) mix3(out, DEEP, smoothstep(-8, -18, h));
  } else if (h < 1.7) {
    set3(out, WET_SAND);
    mix3(out, SAND, smoothstep(0.1, 0.9, h));
    scale3(out, 0.92 + 0.16 * n2);
  } else {
    set3(out, GRASS);
    mix3(out, JUNGLE, smoothstep(0.35, 0.7, n1));
    scale3(out, 0.8 + 0.4 * n2);
    mix3(out, SAND, smoothstep(2.4, 1.7, h));
  }
  const steep = smoothstep(0.82, 0.6, ny) * smoothstep(-0.2, 0.8, h);
  const k = 0.8 + 0.4 * n1;
  mix3(out, [ROCK[0] * k, ROCK[1] * k, ROCK[2] * k], steep);
}
