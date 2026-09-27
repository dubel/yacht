// For models the optimizer's simplifier can't bring down (hundreds of small parts, UV seams everywhere):
// parts sharing a material joined, vertices welded, simplified; and if that is still far over budget, the
// "sloppy" simplifier, which ignores topology. Writes an intermediate file for optimize-town.mjs to finish.
// usage: node tools/simplify-hard.mjs <in.glb> <out.glb> <triangle budget> [nosloppy,keep] [error]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join, weld, simplify, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [inp, out, budgetS, mode, errS] = process.argv.slice(2);
const budget = +budgetS;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const doc = await io.read(inp);
const count = () => doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);
const t0 = count();
// ("keep" in the mode: the nodes left as they are — a pack whose models are picked out by name)
const keep = (mode ?? '').includes('keep');
await doc.transform(dedup(), ...(keep ? [] : [flatten(), join({ keepNamed: false })]), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, budget / t0), error: errS ? +errS : 0.08, lockBorder: false }), prune());
let t1 = count();
if (t1 > budget * 1.3 && !(mode ?? "").includes("nosloppy")) {
  const k = budget / t1;
  for (const mesh of doc.getRoot().listMeshes())
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices(), pos = p.getAttribute('POSITION');
      if (!idx || !pos) continue;
      const src = new Uint32Array(idx.getArray()), n = pos.getCount(), P = new Float32Array(n * 3), v = [];
      for (let i = 0; i < n; i++) { pos.getElement(i, v); P.set(v, i * 3); }
      const target = Math.max(3, Math.floor((src.length * k) / 3) * 3);
      const [res] = MeshoptSimplifier.simplifySloppy(src, P, 3, null, target, 0.2);
      idx.setArray(new Uint32Array(res));
    }
  t1 = count();
}
await io.write(out, doc);
console.log(`${inp}: ${Math.round(t0)} → ${Math.round(t1)} tris`);
