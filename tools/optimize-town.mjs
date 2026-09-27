// Optimise Tortuga's town models (assets/tortuga/*.glb → public/assets/town/): each simplified to a triangle
// budget and its textures shrunk. usage: node tools/optimize-town.mjs [name…]   (npm run optimize-town)
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
// name: [source file, triangle budget, texture size, hard?] — hard: through tools/simplify-hard.mjs first, for
// models the optimizer can't bring down (its mode: '' joins parts and may go sloppy; 'nosloppy,keep' keeps the
// nodes, for a pack picked apart by name)
const MODELS = {
  tavern: ['medieval_tavern', 40000, 1024, ''],
  noble: ['middle_age_noble_house', 25000, 1024],
  smithy: ['medieval_blacksmith', 25000, 1024],
  woodhouse: ['game_ready_wooden_house', 12000, 512],
  store: ['medieval_house', 12000, 512],
  house1: ['medieval_house (1)', 12000, 512],
  timber: ['medieval_house_again_other', 15000, 1024],
  oldhouse: ['medieval_house_another', 12000, 512],
  cabin: ['wooden_cabin', 12000, 512],
  logcabin: ['wooden_log_cabin', 12000, 512],
  oldcabin: ['old_wooden_cabin__house', 12000, 512],
  home: ['wooden_home', 12000, 512],
  woodhouse2: ['wooden_house_3d_model__game-ready_environment', 12000, 512],
  thatched: ['thatched_hut', 12000, 512],
  foresthut: ['forest_hut_gameready', 12000, 512],
  oldhut: ['old_forest_hut', 12000, 512],
  ruin: ['broken_house', 12000, 512],
  shed: ['outbuilding', 12000, 512],
  shack: ['pirate_wooden_shack_-_mobile_game_asset', 12000, 512],
  medieval: ['medieval', 12000, 512],
  lowpoly: ['low-poly_medieval_wooden_and_plaster_houses', 20000, 512],
  props: ['medieval_tavern_asset_pack', 8000, 512, 'nosloppy,keep'],
  feast: ['medieval_tavern_table', 8000, 512],
  well: ['medieval_stone_well_-_game_prop', 6000, 512, ''],
  stall: ['medieval_market_stall', 10000, 512],
  stall2: ['medieval_stall', 8000, 512],
  butcher: ['the_butchers_table', 6000, 512, ''],
  tools: ['blacksmithing_tools.', 6000, 512],
};
const tris = (p) => {
  const b = readFileSync(p), n = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + n).toString());
  let t = 0;
  for (const m of j.meshes) for (const pr of m.primitives) t += j.accessors[pr.indices ?? pr.attributes.POSITION].count / 3;
  return t;
};
const only = process.argv.slice(2);
for (const [name, [src, budget, tex, hard]] of Object.entries(MODELS)) {
  if (only.length && !only.includes(name)) continue;
  const orig = `assets/tortuga/${src}.glb`, out = `public/assets/town/${name}.glb`;
  if (!existsSync(orig)) { console.log(`${name}: missing ${orig}`); continue; }
  let inp = orig;
  if (hard !== undefined) {
    inp = `${tmpdir()}/town-${name}.glb`;
    execFileSync('node', ['tools/simplify-hard.mjs', orig, inp, String(budget), ...(hard ? [hard, hard.includes('keep') ? '0.1' : '0.08'] : [])], { stdio: 'pipe' });
  }
  const t = tris(orig), ratio = hard !== undefined ? 1 : Math.min(1, budget / tris(inp));
  const base = ['gltf-transform', 'optimize', inp, out, '--texture-compress', 'webp', '--texture-size', String(tex), '--compress', 'meshopt',
    '--flatten', 'false', '--join', 'false', '--prune', 'false'];
  try {
    // the simplifier stops at an error limit before the budget on dense models: loosen it till it fits
    for (const err of ratio < 1 ? ['0.005', '0.02', '0.06', '0.15'] : [null]) {
      execFileSync('npx', err ? [...base, '--simplify-ratio', ratio.toFixed(4), '--simplify-error', err] : [...base, '--simplify', 'false'], { stdio: 'pipe' });
      if (!err || tris(out) < budget * 1.3) break;
    }
    console.log(`${name.padEnd(11)} ${Math.round(t).toString().padStart(8)} → ${Math.round(tris(out)).toString().padStart(6)} tris  ${(readFileSync(out).length / 1e6).toFixed(2)} MB`);
  } catch (e) { console.log(`${name}: FAILED ${String(e.stderr ?? e).slice(0, 300)}`); }
}
