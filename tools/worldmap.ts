// Top-down map of the procedural world: npx tsx tools/worldmap.ts [halfSizeMeters] [px] [seed] → .shots/worldmap.png
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { terrainHeight, setWorldSeed, boxIsOpenOcean } from '../src/world/WorldGen';
const [half = 12000, N = 800, seed] = process.argv.slice(2).map(Number);
if (seed) setWorldSeed(seed);
const px = Buffer.alloc(N * N * 3);
const t0 = performance.now();
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const x = -half + (i + 0.5) * (2 * half / N), z = -half + (j + 0.5) * (2 * half / N);
  const h = terrainHeight(x, z);
  let c: number[];
  if (h > 1.7) c = [60 + h * 3, 110 + h * 2, 50];
  else if (h > 0) c = [230, 210, 160];
  else if (h > -1.5) c = [120, 220, 210];
  else if (h > -8) c = [60, 170, 200];
  else if (h > -30) c = [30, 90, 160];
  else c = [15, 40, 90];
  // tiles the renderer would skip (256 m grid)
  const tx = Math.floor(x / 256), tz = Math.floor(z / 256);
  if (!boxIsOpenOcean(tx * 256, tz * 256, tx * 256 + 256, tz * 256 + 256) && h < -30) c = [25, 55, 110];
  px.set(c.map((v) => Math.max(0, Math.min(255, v))), (j * N + i) * 3);
}
console.log('map', (performance.now() - t0).toFixed(0), 'ms');
mkdirSync('.shots', { recursive: true });
writeFileSync('.shots/worldmap.ppm', Buffer.concat([Buffer.from(`P6 ${N} ${N} 255\n`), px]));
execSync(`python3 -c "from PIL import Image; Image.open('.shots/worldmap.ppm').save('.shots/worldmap.png')"`);
