import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/*
 * First-person models, built from primitives: the sailor's right hand closed round a grip, the forearm in a
 * loose linen shirt sleeve, a flintlock pistol and a swept-hilt rapier. Sizes are real (metres), so they sit
 * right in the view at arm's length.
 *
 * Conventions: a hand is built round a grip along its local +Y (centred at the origin, radius `rg`), palm on
 * the +X side, fingers wrapping round the front (−Z) — so it can be put on any grip by turning +Y onto the
 * grip's axis. Weapons point along −Z with the top up, the way the camera looks.
 */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

export const MATERIALS = {
  // (a sailor's weathered, sun-browned skin)
  skin: new THREE.MeshStandardMaterial({ color: srgb(0.76, 0.54, 0.41), roughness: 0.55 }),
  linen: new THREE.MeshStandardMaterial({ color: srgb(0.86, 0.82, 0.73), roughness: 0.97, side: THREE.DoubleSide, vertexColors: true }),
  walnut: new THREE.MeshStandardMaterial({ color: srgb(0.26, 0.13, 0.06), roughness: 0.62 }),
  brass: new THREE.MeshStandardMaterial({ color: srgb(0.85, 0.66, 0.3), roughness: 0.32, metalness: 1 }),
  iron: new THREE.MeshStandardMaterial({ color: srgb(0.22, 0.22, 0.23), roughness: 0.42, metalness: 1 }),
  blade: new THREE.MeshStandardMaterial({ color: srgb(0.72, 0.72, 0.72), roughness: 0.3, metalness: 1, envMapIntensity: 0.7 }),
  wire: new THREE.MeshStandardMaterial({ color: srgb(0.42, 0.36, 0.28), roughness: 0.35, metalness: 0.9 }),
};

/** a capsule of radius r from a to b */
function capsule(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CapsuleGeometry(r, Math.max(d.length(), 1e-4), 4, 10);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * The right hand closed round a grip of radius `rg` (see the conventions above). `trigger`: the index finger
 * lies along the trigger instead of wrapping. Returns the hand mesh and where its wrist is and which way the
 * forearm leaves it (hand frame).
 */
export function makeHand(rg: number, trigger = false, forearm = new THREE.Vector3(0.28, -0.42, 1)): { mesh: THREE.Mesh; wrist: THREE.Vector3; forearm: THREE.Vector3 } {
  const parts: THREE.BufferGeometry[] = [];
  const radius = [0.0082, 0.0088, 0.0083, 0.0072];               // index … little finger
  const phal = [[0.044, 0.026, 0.02], [0.048, 0.029, 0.021], [0.045, 0.027, 0.02], [0.036, 0.021, 0.017]];
  const ys = [0.029, 0.011, -0.007, -0.024];
  for (let f = 0; f < 4; f++) {
    const R = rg + radius[f] + 0.001;
    // knuckle at the palm's front edge; each joint bends a little more (a fist, not a coil)
    let a = -0.32;
    let p = new THREE.Vector3(Math.cos(a) * (R + 0.006), ys[f], Math.sin(a) * (R + 0.006));
    if (f === 0 && trigger) {
      // index along the trigger: out forward and a little down, then the last joint hooked
      const q1 = p.clone().add(new THREE.Vector3(-0.012, -0.004, -0.04));
      const q2 = q1.clone().add(new THREE.Vector3(-0.008, -0.012, -0.018));
      parts.push(capsule(p, q1, radius[f]), capsule(q1, q2, radius[f] * 0.95));
      continue;
    }
    phal[f].forEach((len, k) => {
      const da = (len / R) * (1 + 0.12 * k);
      a -= da;
      const q = new THREE.Vector3(Math.cos(a) * R, ys[f] - 0.002 * k, Math.sin(a) * R);
      parts.push(capsule(p, q, radius[f] * (1 - 0.06 * k)));
      p = q;
    });
  }
  // palm: a flattened capsule behind the grip, then the heel of the hand down to the wrist
  const palm = new THREE.CapsuleGeometry(0.021, 0.05, 4, 12);
  palm.scale(0.62, 1, 1.35);
  palm.rotateX(-0.12);
  palm.translate(rg + 0.017, 0.002, 0.008);
  parts.push(palm);
  const wrist = new THREE.Vector3(rg + 0.022, -0.042, 0.036);
  parts.push(capsule(new THREE.Vector3(rg + 0.016, -0.02, 0.014), wrist, 0.022));
  // thumb: from the ball of the thumb round the back of the grip and down its far side
  const t0 = new THREE.Vector3(rg + 0.012, 0.024, 0.024), t1 = new THREE.Vector3(0.004, 0.042, rg + 0.012), t2 = new THREE.Vector3(-rg - 0.006, 0.04, 0.004);
  parts.push(capsule(t0, t1, 0.0105), capsule(t1, t2, 0.0095));
  const geo = mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g; }))!;
  const mesh = new THREE.Mesh(geo, MATERIALS.skin);
  return { mesh, wrist, forearm: forearm.clone().normalize() };
}

/** forearm and loose linen sleeve, from the wrist (origin) along +Y */
export function makeArm(): THREE.Group {
  const g = new THREE.Group();
  // forearm: slightly flattened, widening toward the elbow
  const arm = new THREE.LatheGeometry([0.0, 0.021, 0.023, 0.027, 0.031, 0.035, 0.037].map((r, i) => new THREE.Vector2(r, [0, 0, 0.04, 0.09, 0.15, 0.24, 0.34][i])), 18);
  arm.scale(1.2, 1, 0.95);
  g.add(new THREE.Mesh(arm, MATERIALS.skin));
  // sleeve: loose and folded, a turned-back cuff a hand's breadth up from the wrist
  const prof = [[0.047, 0.1], [0.052, 0.108], [0.056, 0.14], [0.06, 0.2], [0.064, 0.27], [0.067, 0.36], [0.068, 0.45]].map(([r, y]) => new THREE.Vector2(r, y));
  const sleeve = new THREE.LatheGeometry(prof, 36, 0, Math.PI * 2);
  const pos = sleeve.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const fold = 0.6 * Math.sin(a * 6 + y * 22) + 0.4 * Math.sin(a * 11 - y * 9 + 1.3);
    const sag = Math.max(0, -Math.sin(a)) * 0.08 * Math.min(1, (y - 0.1) * 6); // the cloth hangs below the arm
    const k = 1 + 0.06 * fold + sag;
    pos.setXYZ(i, x * k * 1.1, y, z * k);
    const shade = 0.82 + 0.18 * (0.5 + 0.5 * fold);
    col[i * 3] = shade; col[i * 3 + 1] = shade; col[i * 3 + 2] = shade * 0.98;
  }
  sleeve.setAttribute('color', new THREE.BufferAttribute(col, 3));
  sleeve.computeVertexNormals();
  g.add(new THREE.Mesh(sleeve, MATERIALS.linen));
  // the cuff's rolled edge
  const cuff = new THREE.TorusGeometry(0.049, 0.006, 6, 30);
  cuff.rotateX(Math.PI / 2);
  cuff.scale(1.1, 1, 1);
  cuff.translate(0, 0.1, 0);
  const cc = new Float32Array((cuff.attributes.position.count) * 3).fill(0.9);
  cuff.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  g.add(new THREE.Mesh(cuff, MATERIALS.linen));
  return g;
}

/**
 * hand + sleeve holding a grip: `gripAt` / `gripAxis` in the weapon's frame; `forearm` (hand frame) is the
 * way the arm leaves the wrist — across the grip for a pistol, back along it for a sword
 */
export function makeGrip(rg: number, gripAt: THREE.Vector3, gripAxis: THREE.Vector3, trigger = false, forearm?: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const hand = makeHand(rg, trigger, forearm);
  const arm = makeArm();
  arm.position.copy(hand.wrist);
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hand.forearm);
  g.add(hand.mesh, arm);
  g.position.copy(gripAt);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gripAxis.clone().normalize());
  return g;
}

export interface Pistol {
  group: THREE.Group;
  /** muzzle and priming pan, in the pistol's frame */
  muzzle: THREE.Object3D;
  pan: THREE.Object3D;
  cock: THREE.Object3D;
}

/** a flintlock pistol: walnut stock with a brass butt cap, octagonal-to-round iron barrel, lock on the right */
export function makePistol(): Pistol {
  const group = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = group) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };
  // stock: a side profile (s forward, v up), extruded across and turned so s → −Z
  const P: [number, number][] = [[0.255, 0.004], [0.12, 0.006], [0.03, 0.01], [0.0, 0.014], [-0.028, 0.004], [-0.058, -0.028], [-0.086, -0.066],
    [-0.108, -0.106], [-0.118, -0.124], [-0.1, -0.138], [-0.072, -0.13], [-0.054, -0.098], [-0.036, -0.066], [-0.016, -0.038], [0.012, -0.024],
    [0.06, -0.018], [0.255, -0.011]];
  const shape = new THREE.Shape(P.map(([s, v]) => new THREE.Vector2(s, v)));
  const stock = new THREE.ExtrudeGeometry(shape, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 6 });
  stock.rotateY(Math.PI / 2);
  stock.translate(-0.013, 0, 0);
  add(stock, MATERIALS.walnut);
  // barrel: octagonal at the breech, round beyond, a brass ring at the muzzle
  const breech = new THREE.CylinderGeometry(0.0125, 0.0128, 0.09, 8);
  breech.rotateX(Math.PI / 2);
  breech.translate(0, 0.017, -0.045);
  add(breech, MATERIALS.iron);
  const tube = new THREE.CylinderGeometry(0.0098, 0.011, 0.215, 16, 1, true);
  tube.rotateX(Math.PI / 2);
  tube.translate(0, 0.017, -0.197);
  add(tube, MATERIALS.iron);
  const ring = new THREE.CylinderGeometry(0.0118, 0.0118, 0.01, 16);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0.017, -0.298);
  add(ring, MATERIALS.brass);
  const bore = new THREE.CircleGeometry(0.006, 12);
  bore.translate(0, 0.017, -0.3035);
  add(bore, new THREE.MeshBasicMaterial({ color: 0x050505 }));
  // ramrod under the barrel
  const rod = new THREE.CylinderGeometry(0.0033, 0.0033, 0.23, 6);
  rod.rotateX(Math.PI / 2);
  rod.translate(0, -0.003, -0.16);
  add(rod, MATERIALS.walnut);
  // lock on the right side: plate, pan, frizzen, and the cock (a child, so it can fall)
  const plate = new THREE.BoxGeometry(0.004, 0.024, 0.078);
  plate.translate(0.016, 0.005, -0.03);
  add(plate, MATERIALS.iron);
  const panG = new THREE.BoxGeometry(0.012, 0.005, 0.014);
  panG.translate(0.02, 0.019, -0.04);
  add(panG, MATERIALS.brass);
  const frizzen = new THREE.BoxGeometry(0.006, 0.026, 0.006);
  frizzen.rotateX(0.35);
  frizzen.translate(0.02, 0.033, -0.047);
  add(frizzen, MATERIALS.iron);
  const cock = new THREE.Group();
  cock.position.set(0.02, 0.012, -0.004);
  const neck = new THREE.BoxGeometry(0.005, 0.03, 0.009);
  neck.translate(0, 0.015, 0);
  add(neck, MATERIALS.iron, cock);
  const jaw = new THREE.BoxGeometry(0.007, 0.007, 0.02);
  jaw.translate(0, 0.03, -0.008);
  add(jaw, MATERIALS.iron, cock);
  cock.rotation.x = 0.55; // drawn back (cocked)
  group.add(cock);
  // trigger guard (a brass half-ring) and trigger
  const guard = new THREE.TorusGeometry(0.02, 0.0024, 6, 18, Math.PI);
  guard.rotateZ(Math.PI);
  guard.rotateY(Math.PI / 2);
  guard.translate(0, -0.022, -0.02);
  add(guard, MATERIALS.brass);
  const trig = new THREE.BoxGeometry(0.003, 0.018, 0.004);
  trig.rotateX(-0.3);
  trig.translate(0, -0.028, -0.016);
  add(trig, MATERIALS.iron);
  // brass butt cap
  const cap = new THREE.SphereGeometry(0.021, 14, 10);
  cap.scale(0.85, 0.75, 1.05);
  cap.translate(0, -0.126, 0.106);
  add(cap, MATERIALS.brass);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.017, -0.305); group.add(muzzle);
  const pan = new THREE.Object3D(); pan.position.set(0.02, 0.024, -0.04); group.add(pan);
  // the hand on the grip, index finger on the trigger
  group.add(makeGrip(0.0155, new THREE.Vector3(0, -0.07, 0.066), new THREE.Vector3(0, 0.07, -0.075), true));
  return { group, muzzle, pan, cock };
}

export interface Rapier {
  group: THREE.Group;
  /** blade base and tip, in the rapier's frame (for the swing trail) */
  base: THREE.Object3D;
  tip: THREE.Object3D;
}

/** a swept-hilt rapier: long narrow blade, wire-bound grip, quillons, side rings and a knuckle bow */
export function makeRapier(): Rapier {
  const group = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => { const m = new THREE.Mesh(geo, mat); group.add(m); return m; };
  // blade: a flattened diamond section tapering to a point, along −Z
  const blade = new THREE.CylinderGeometry(0.0012, 0.0115, 0.95, 4, 8);
  blade.rotateY(Math.PI / 4);
  blade.scale(1, 1, 0.32);
  blade.rotateX(-Math.PI / 2);
  blade.translate(0, 0, -0.035 - 0.475);
  add(blade, MATERIALS.blade);
  const ricasso = new THREE.BoxGeometry(0.014, 0.006, 0.04);
  ricasso.translate(0, 0, -0.02);
  add(ricasso, MATERIALS.blade);
  // grip: wire-bound, with ferrules, and a round pommel
  const grip = new THREE.CylinderGeometry(0.0115, 0.0125, 0.1, 12);
  grip.rotateX(Math.PI / 2);
  grip.translate(0, 0, 0.055);
  add(grip, MATERIALS.wire);
  for (const z of [0.006, 0.104]) {
    const f = new THREE.CylinderGeometry(0.0138, 0.0138, 0.008, 12);
    f.rotateX(Math.PI / 2);
    f.translate(0, 0, z);
    add(f, MATERIALS.iron);
  }
  const pommel = new THREE.SphereGeometry(0.019, 16, 12);
  pommel.scale(1, 1, 1.15);
  pommel.translate(0, 0, 0.125);
  add(pommel, MATERIALS.iron);
  // quillons, with knobs
  const quil = new THREE.CylinderGeometry(0.0048, 0.0048, 0.2, 8);
  quil.rotateZ(Math.PI / 2);
  quil.translate(0, 0, 0.0);
  add(quil, MATERIALS.iron);
  for (const x of [-0.1, 0.1]) { const k = new THREE.SphereGeometry(0.009, 10, 8); k.translate(x, 0, 0); add(k, MATERIALS.iron); }
  // side rings round the blade's base, and a knuckle bow down over the fingers to the pommel
  for (const [r, z] of [[0.03, -0.028], [0.021, -0.012]]) {
    const ringG = new THREE.TorusGeometry(r, 0.0032, 6, 26);
    ringG.rotateX(Math.PI / 2);
    ringG.scale(1, 1, 0.7);
    ringG.translate(0, 0, z);
    add(ringG, MATERIALS.iron);
  }
  const bow = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.004, -0.004), new THREE.Vector3(0, -0.042, 0.02), new THREE.Vector3(0, -0.05, 0.065), new THREE.Vector3(0, -0.028, 0.112), new THREE.Vector3(0, -0.012, 0.122),
  ]), 20, 0.0034, 6, false);
  add(bow, MATERIALS.iron);
  for (const m of group.children) (m as THREE.Mesh).geometry.computeVertexNormals();
  const base = new THREE.Object3D(); base.position.set(0, 0, -0.05); group.add(base);
  const tip = new THREE.Object3D(); tip.position.set(0, 0, -0.98); group.add(tip);
  // the hand round the grip; its fingers come out under the grip, inside the knuckle bow
  group.add(makeGrip(0.012, new THREE.Vector3(0, 0, 0.056), new THREE.Vector3(0, 0, -1), false, new THREE.Vector3(0.35, -0.85, -0.3)));
  return { group, base, tip };
}
