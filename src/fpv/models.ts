import * as THREE from 'three';

/*
 * First-person models, built from primitives: a flintlock pistol, a swept-hilt rapier and a hand lantern.
 * Sizes are real (metres), so they sit right in the view at arm's length. The arm and hand that hold them
 * are a model of their own (Hands), put on each piece's grip frame.
 *
 * Conventions: a grip frame has the grip along its local +Y (little finger → index), the palm on the +X
 * side, the fingers wrapping round the front (−Z). Weapons point along −Z with the top up, the way the
 * camera looks.
 */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

export const MATERIALS = {
  walnut: new THREE.MeshStandardMaterial({ color: srgb(0.26, 0.13, 0.06), roughness: 0.62 }),
  brass: new THREE.MeshStandardMaterial({ color: srgb(0.85, 0.66, 0.3), roughness: 0.32, metalness: 1 }),
  iron: new THREE.MeshStandardMaterial({ color: srgb(0.22, 0.22, 0.23), roughness: 0.42, metalness: 1 }),
  blade: new THREE.MeshStandardMaterial({ color: srgb(0.72, 0.72, 0.72), roughness: 0.3, metalness: 1, envMapIntensity: 0.7 }),
  wire: new THREE.MeshStandardMaterial({ color: srgb(0.42, 0.36, 0.28), roughness: 0.35, metalness: 0.9 }),
};

/** the grip frame of a piece (see the conventions above): at `gripAt`, its +Y along `gripAxis` (weapon frame) */
function gripFrame(gripAt: THREE.Vector3, gripAxis: THREE.Vector3): THREE.Object3D {
  const g = new THREE.Object3D();
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
  /** the grip frame (see the conventions above): where the hand holds it */
  grip: THREE.Object3D;
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
  // where the hand holds it: round the butt, the index finger along the trigger
  const grip = gripFrame(new THREE.Vector3(0, -0.07, 0.066), new THREE.Vector3(0, 0.07, -0.075));
  group.add(grip);
  return { group, muzzle, pan, cock, grip };
}

export interface Rapier {
  group: THREE.Group;
  /** blade base and tip, in the rapier's frame (for the swing trail) */
  base: THREE.Object3D;
  tip: THREE.Object3D;
  grip: THREE.Object3D;
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
  const wound = new THREE.CylinderGeometry(0.0115, 0.0125, 0.1, 12);
  wound.rotateX(Math.PI / 2);
  wound.translate(0, 0, 0.055);
  add(wound, MATERIALS.wire);
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
  // where the hand holds it: round the grip, the fingers inside the knuckle bow
  const grip = gripFrame(new THREE.Vector3(0, 0, 0.056), new THREE.Vector3(0, 0, -1));
  group.add(grip);
  return { group, base, tip, grip };
}

export interface Lantern {
  group: THREE.Group;
  /** the part that swings (everything below the hand), pivoting on the bail */
  body: THREE.Group;
  flame: THREE.Mesh;
  glass: THREE.MeshStandardMaterial;
  grip: THREE.Object3D;
}

/**
 * A ship's hand lantern, held overhand by its bail: a brass cap with a chimney, a glass chimney-globe in a
 * wire cage, a candle burning inside, a brass base. The bail's top is at the origin, running along X; the
 * lantern hangs below it.
 */
export function makeLantern(): Lantern {
  const group = new THREE.Group(), body = new THREE.Group();
  group.add(body);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => { const m = new THREE.Mesh(geo, mat); body.add(m); return m; };
  // bail: a half ring up from the cap's sides to the hand
  const bail = new THREE.TorusGeometry(0.036, 0.0032, 6, 18, Math.PI);
  bail.translate(0, -0.036, 0);
  add(bail, MATERIALS.iron);
  // cap with a little chimney
  const cap = new THREE.CylinderGeometry(0.022, 0.056, 0.045, 18, 1);
  cap.translate(0, -0.06, 0);
  add(cap, MATERIALS.brass);
  const chim = new THREE.CylinderGeometry(0.012, 0.014, 0.022, 12);
  chim.translate(0, -0.03, 0);
  add(chim, MATERIALS.brass);
  const rim = new THREE.TorusGeometry(0.052, 0.004, 6, 24);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, -0.083, 0);
  add(rim, MATERIALS.brass);
  // the glass, lit from inside
  // (clear, faintly amber glass: the candle shows through, the glass itself only glows a little)
  const glass = new THREE.MeshStandardMaterial({ color: srgb(0.9, 0.8, 0.6), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22,
    emissive: new THREE.Color(1, 0.55, 0.2), emissiveIntensity: 0.3, depthWrite: false });
  const globe = new THREE.CylinderGeometry(0.046, 0.046, 0.12, 24, 1, true);
  globe.translate(0, -0.145, 0);
  add(globe, glass);
  // cage: four wires and a mid band
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const w = new THREE.CylinderGeometry(0.0022, 0.0022, 0.125, 5);
    w.translate(Math.cos(a) * 0.05, -0.145, Math.sin(a) * 0.05);
    add(w, MATERIALS.iron);
  }
  const band = new THREE.TorusGeometry(0.05, 0.0022, 5, 24);
  band.rotateX(Math.PI / 2);
  band.translate(0, -0.145, 0);
  add(band, MATERIALS.iron);
  // base
  const base = new THREE.CylinderGeometry(0.055, 0.05, 0.022, 20);
  base.translate(0, -0.215, 0);
  add(base, MATERIALS.brass);
  // the candle and its flame
  const candle = new THREE.CylinderGeometry(0.011, 0.012, 0.05, 12);
  candle.translate(0, -0.18, 0);
  add(candle, new THREE.MeshStandardMaterial({ color: srgb(0.93, 0.88, 0.72), roughness: 0.7, emissive: new THREE.Color(0.5, 0.3, 0.1), emissiveIntensity: 0.6 }));
  const fl = new THREE.SphereGeometry(0.008, 10, 8);
  fl.scale(1, 2.2, 1);
  fl.translate(0, 0.016, 0);
  const flame = new THREE.Mesh(fl, new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.6, 1.2) }));
  flame.position.set(0, -0.155, 0);
  body.add(flame);
  // held overhand: palm on top of the bail, fingers round its front, the arm back and down to the right
  const grip = gripFrame(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0, 0));
  group.add(grip);
  return { group, body, flame, glass, grip };
}
