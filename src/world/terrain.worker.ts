import { INVISIBLE_DEPTH, setWorldSeed, terrainColor, terrainHeight } from './WorldGen';
import { perimeter } from './tileGrid';

/*
 * Terrain tile builder, off the main thread. For a square tile it samples the world heightfield on an
 * (n+1)² grid (plus a one-sample ring so normals are continuous across tile edges), and returns local
 * positions, normals and vertex colours, followed by a skirt ring hanging below the edge that hides the
 * cracks between neighbouring tiles of different detail. Tiles that are entirely deep water come back empty.
 */

export interface TileRequest {
  id: number;
  x0: number;
  z0: number;
  size: number;
  /** segments per side */
  n: number;
  skirt: number;
}

export interface TileResult {
  id: number;
  empty: boolean;
  minY: number;
  maxY: number;
  position?: Float32Array;
  normal?: Float32Array;
  color?: Float32Array;
}

// (typed by hand: the "webworker" lib would replace the DOM types for the whole project)
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<TileRequest | { seed: number }>) => void) | null;
  postMessage(m: TileResult, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const m = e.data;
  if ('seed' in m) { setWorldSeed(m.seed); return; }
  const { id, x0, z0, size, n, skirt } = m;
  const step = size / n, W = n + 3;
  // heights with a 1-sample ring: H[(j+1)*W + (i+1)] is grid vertex (i, j)
  const H = new Float32Array(W * W);
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < W; j++)
    for (let i = 0; i < W; i++) {
      const h = terrainHeight(x0 + (i - 1) * step, z0 + (j - 1) * step);
      H[j * W + i] = h;
      if (i > 0 && j > 0 && i < W - 1 && j < W - 1) { if (h < minY) minY = h; if (h > maxY) maxY = h; }
    }
  if (maxY < INVISIBLE_DEPTH) { ctx.postMessage({ id, empty: true, minY, maxY } satisfies TileResult); return; }

  const V = (n + 1) * (n + 1), S = 4 * n;
  const position = new Float32Array((V + S) * 3), normal = new Float32Array((V + S) * 3), color = new Float32Array((V + S) * 3);
  const c = [0, 0, 0];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const k = j * (n + 1) + i, g = (j + 1) * W + (i + 1);
      const h = H[g];
      const nx = H[g - 1] - H[g + 1], nz = H[g - W] - H[g + W], ny = 2 * step;
      const l = Math.hypot(nx, ny, nz);
      position[k * 3] = i * step; position[k * 3 + 1] = h; position[k * 3 + 2] = j * step;
      normal[k * 3] = nx / l; normal[k * 3 + 1] = ny / l; normal[k * 3 + 2] = nz / l;
      terrainColor(x0 + i * step, z0 + j * step, h, ny / l, c);
      color[k * 3] = c[0]; color[k * 3 + 1] = c[1]; color[k * 3 + 2] = c[2];
    }
  // skirt: a copy of the edge ring (same order as perimeter() on the main thread), pushed down
  const ring = perimeter(n);
  for (let s = 0; s < S; s++) {
    const src = ring[s], dst = V + s;
    for (let a = 0; a < 3; a++) { position[dst * 3 + a] = position[src * 3 + a]; normal[dst * 3 + a] = normal[src * 3 + a]; color[dst * 3 + a] = color[src * 3 + a]; }
    position[dst * 3 + 1] -= skirt;
  }
  ctx.postMessage({ id, empty: false, minY, maxY, position, normal, color } satisfies TileResult, [position.buffer, normal.buffer, color.buffer]);
};
