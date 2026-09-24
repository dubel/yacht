/*
 * Shared layout of a terrain tile's vertex buffer (used by the worker that fills it and the main thread
 * that indexes it): (n+1)² grid vertices, row-major (x fastest), then 4n skirt vertices, one below each
 * edge vertex in perimeter() order.
 */

/** grid-vertex indices around the edge of an n×n tile, counter-clockwise seen from above, 4n of them */
export function perimeter(n: number): Uint32Array {
  const r = new Uint32Array(4 * n);
  let k = 0;
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let i = 0; i < n; i++) r[k++] = v(i, 0);
  for (let j = 0; j < n; j++) r[k++] = v(n, j);
  for (let i = n; i > 0; i--) r[k++] = v(i, n);
  for (let j = n; j > 0; j--) r[k++] = v(0, j);
  return r;
}

/** triangle indices for the grid (facing up) and the skirt (both windings, so it hides cracks from any side) */
export function tileIndex(n: number): Uint32Array {
  const V = (n + 1) * (n + 1), S = 4 * n;
  const idx = new Uint32Array(n * n * 6 + S * 12);
  let k = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + n + 1, c = a + 1, d = b + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = c; idx[k++] = b; idx[k++] = d;
    }
  const ring = perimeter(n);
  for (let s = 0; s < S; s++) {
    const t = (s + 1) % S;
    const a = ring[s], b = ring[t], c = V + s, d = V + t;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  return idx;
}
