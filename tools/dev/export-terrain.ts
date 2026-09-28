// Unity spike: sample the home lagoon's heightfield + vertex colours on a regular grid (three.js world coords).
// usage: npx tsx tools/dev/export-terrain.ts [half=640] [step=1]
// → unity-spike/Import/terrain.bin (float32: n*n heights, then n*n*3 linear rgb) + terrain.json
import { writeFileSync } from 'node:fs';
import { setWorldSeed, terrainColor, terrainHeight } from '../../src/world/WorldGen';

const half = Number(process.argv[2] ?? 640), step = Number(process.argv[3] ?? 1);
setWorldSeed(1337, false);
const n = Math.round((2 * half) / step) + 1, x0 = -half, z0 = -half;
const H = new Float32Array((n + 2) * (n + 2));
for (let j = 0; j < n + 2; j++)
  for (let i = 0; i < n + 2; i++) H[j * (n + 2) + i] = terrainHeight(x0 + (i - 1) * step, z0 + (j - 1) * step);
const out = new Float32Array(n * n * 4);
const c = [0, 0, 0];
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) {
    const g = (j + 1) * (n + 2) + (i + 1), h = H[g];
    const nx = H[g - 1] - H[g + 1], nz = H[g - (n + 2)] - H[g + (n + 2)], ny = 2 * step;
    terrainColor(x0 + i * step, z0 + j * step, h, ny / Math.hypot(nx, ny, nz), c);
    const k = j * n + i;
    out[k] = h;
    out.set(c, n * n + k * 3);
  }
writeFileSync('unity-spike/Import/terrain.bin', Buffer.from(out.buffer, 0, n * n * 4 * 4));
writeFileSync('unity-spike/Import/terrain.json', JSON.stringify({ n, x0, z0, step }));
console.log(`terrain ${n}×${n}, step ${step} m, from (${x0}, ${z0})`);
