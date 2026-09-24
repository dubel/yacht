import { fbm, smoothstep } from '../core/noise';
import { terrainHeight } from './WorldGen';

/*
 * Where plants grow (runs in the terrain worker): palms along the beaches, rounded jungle trees on the
 * higher ground, scrub in between. Candidates sit on a jittered grid anchored to the world (not to the
 * tile), with per-cell hashes instead of a running random sequence, so every tile places exactly the same
 * plants whichever order tiles are built in and neighbouring tiles join without seams. Output: one
 * array of 4×4 instance matrices (column-major, like three.js) per kind.
 */

export const VEG_KINDS = 3; // palm, tree, bush
const STEP = 4.2;
/** lowest ground that carries plants (m); a tile entirely below it gets none */
export const VEG_MIN_H = 1.3;

function hash(i: number, j: number, k: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const PLACE = [
  (h: number, ny: number, n: number) => (h > 1.4 && h < 7 && ny > 0.8 && n > 0.35 ? 0.55 : 0),
  (h: number, ny: number, n: number) => (h > 3.5 && ny > 0.62 ? smoothstep(0.35, 0.6, n) * 0.85 : 0),
  (h: number, ny: number, n: number) => (h > 1.9 && ny > 0.6 ? 0.25 + 0.3 * n : 0),
];
const SCALE: [number, number][] = [[0.75, 1.25], [0.8, 1.5], [0.6, 1.3]];

/** instance matrices of every plant in the square [x0, x0+size) × [z0, z0+size) */
export function placeVegetation(x0: number, z0: number, size: number): Float32Array[] {
  const out: number[][] = [[], [], []];
  const i0 = Math.ceil(x0 / STEP), i1 = Math.ceil((x0 + size) / STEP), j0 = Math.ceil(z0 / STEP), j1 = Math.ceil((z0 + size) / STEP);
  for (let j = j0; j < j1; j++)
    for (let i = i0; i < i1; i++) {
      const px = (i + hash(i, j, 1) - 0.5) * STEP, pz = (j + hash(i, j, 2) - 0.5) * STEP;
      const h = terrainHeight(px, pz);
      if (h < VEG_MIN_H) continue;
      const e = 0.8;
      const nx = terrainHeight(px - e, pz) - terrainHeight(px + e, pz), nz = terrainHeight(px, pz - e) - terrainHeight(px, pz + e);
      const ny = (2 * e) / Math.hypot(nx, 2 * e, nz);
      const n = fbm(px / 30, pz / 30, 3);
      const r = hash(i, j, 3);
      let acc = 0;
      for (let k = 0; k < VEG_KINDS; k++) {
        acc += PLACE[k](h, ny, n);
        if (r >= acc * 0.6) continue;
        const [s0, s1] = SCALE[k];
        const s = s0 + (s1 - s0) * hash(i, j, 4);
        // Euler XYZ (three's default): a slight random lean, any heading
        const ax = (hash(i, j, 5) - 0.5) * 0.12, ay = hash(i, j, 6) * Math.PI * 2, az = (hash(i, j, 7) - 0.5) * 0.12;
        const a = Math.cos(ax), b = Math.sin(ax), c = Math.cos(ay), d = Math.sin(ay), ee = Math.cos(az), f = Math.sin(az);
        const ae = a * ee, af = a * f, be = b * ee, bf = b * f;
        out[k].push(
          c * ee * s, (af + be * d) * s, (bf - ae * d) * s, 0,
          -c * f * s, (ae - bf * d) * s, (be + af * d) * s, 0,
          d * s, -b * c * s, a * c * s, 0,
          px, h - 0.15, pz, 1,
        );
        break;
      }
    }
  return out.map((a) => new Float32Array(a));
}
