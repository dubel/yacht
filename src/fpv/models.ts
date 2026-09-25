import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/*
 * First-person pieces, from models (optimised copies in assets/fpv, npm run optimize-weapons; all CC-BY-4.0,
 * see the README): "Flintlock Colonial Pistol" by inciprocal, "Revolver" by barmatunishka, "Spanish Rapier"
 * by Lathander, "Metal hanging lantern" by Irina.Tuchna and "Skull lantern" by brendan wood. Each is scaled to real size and set in the frame the poses and animations
 * of Weapons expect: pointing along −Z with its top up, the way the camera looks. The arm and hand that hold
 * them are a model of their own (Hands), put on each piece's grip frame.
 *
 * A grip frame has the grip along its local +Y (little finger → index), the palm on the +X side, the
 * fingers wrapping round the front (−Z).
 *
 * The parts that move are re-hung on hinges: the flintlock's cock (cut out of its single mesh) and the
 * revolver's hammer (they fall, and are drawn back), the revolver's cylinder (it turns a chamber as the
 * hammer comes back); a lantern's body swings under the hand. The points
 * below (hinges, grips, the flame) were measured on the models, in their own units and axes.
 */

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

async function load(name: string): Promise<THREE.Group> {
  const scene = (await loader.loadAsync(`assets/fpv/${name}.glb`)).scene;
  scene.updateMatrixWorld(true);
  return scene;
}

/** a rotation that takes the model's `fwd` to −Z and (as near as it can) its `up` to +Y */
function facing(fwd: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const f = fwd.clone().normalize();
  const u = up.clone().addScaledVector(f, -up.dot(f)).normalize();
  const r = new THREE.Vector3().crossVectors(f, u);
  // (the basis maps the target axes into the model; its inverse maps the model onto them)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, f.negate())).invert();
}

/**
 * The model in a group of its own: scaled by `s`, turned by `q`, with its point `at` (model units) put at
 * `to` (metres, the group's frame). Returns the group and a function mapping model points into it.
 */
function place(model: THREE.Object3D, s: number, q: THREE.Quaternion, at: THREE.Vector3, to = new THREE.Vector3()) {
  const inner = new THREE.Group();
  inner.add(model);
  inner.scale.setScalar(s);
  inner.quaternion.copy(q);
  inner.position.copy(to).sub(at.clone().multiplyScalar(s).applyQuaternion(q));
  const group = new THREE.Group();
  group.add(inner);
  inner.updateMatrix();
  const toGroup = (p: THREE.Vector3) => p.clone().applyMatrix4(inner.matrix);
  return { group, toGroup };
}

/**
 * Re-hang part `name` of a loaded model on a hinge at `pivot` turning about `axis` (both in the model's
 * space, as loaded): returns a setter for the hinge's angle.
 */
function hinge(model: THREE.Object3D, name: string, pivot: THREE.Vector3, axis: THREE.Vector3): (angle: number) => void {
  const part = model.getObjectByName(name);
  if (!part?.parent) throw new Error(`models: no part ${name}`);
  model.updateMatrixWorld(true);
  const parent = part.parent, h = new THREE.Group();
  parent.add(h);
  h.position.copy(parent.worldToLocal(pivot.clone()));
  h.updateMatrixWorld(true);
  h.attach(part);
  const local = axis.clone().normalize().applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert());
  return (angle) => h.quaternion.setFromAxisAngle(local, angle);
}

/**
 * Cut a part out of a single-mesh model: the triangles of `mesh` lying wholly inside `boxes` (model space, the
 * model as loaded) move to a new mesh named `name`, beside it and sharing its attributes and material — so
 * it can be hung on a hinge of its own. Returns the number of triangles moved.
 */
export function splitPart(mesh: THREE.Mesh, boxes: THREE.Box3[], name: string): number {
  const g = mesh.geometry, pos = g.getAttribute('position');
  mesh.updateWorldMatrix(true, false);
  const inside: boolean[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); inside.push(boxes.some((b) => b.containsPoint(v))); }
  const idx = g.index ? Array.from(g.index.array) : [...Array(pos.count).keys()];
  const keep: number[] = [], move: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    (tri.every((k) => inside[k]) ? move : keep).push(...tri);
  }
  if (!move.length) return 0;
  g.setIndex(keep);
  const part = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(g.attributes)) part.setAttribute(k, a);
  part.setIndex(move);
  const m = new THREE.Mesh(part, mesh.material);
  m.name = name;
  m.position.copy(mesh.position); m.quaternion.copy(mesh.quaternion); m.scale.copy(mesh.scale);
  mesh.parent!.add(m);
  return move.length / 3;
}

/** a grip frame at `at` with its +Y along `axis` (the piece's frame), its +X (the palm) toward `palm` if given */
function gripFrame(at: THREE.Vector3, axis: THREE.Vector3, palm?: THREE.Vector3): THREE.Object3D {
  const g = new THREE.Object3D();
  g.position.copy(at);
  const y = axis.clone().normalize();
  if (palm) {
    const x = palm.clone().addScaledVector(y, -palm.dot(y)).normalize();
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)));
  } else g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), y);
  return g;
}

/** lit in the overlay: a little of the sky, not a mirror of it; never culled (it is always in view) */
function tame(model: THREE.Object3D): void {
  model.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m?.isMeshStandardMaterial) m.envMapIntensity = 0.7;
    o.frustumCulled = false;
  });
}

export interface Pistol {
  group: THREE.Group;
  /** the muzzle, in the pistol's frame (−Z out of the bore) */
  muzzle: THREE.Object3D;
  grip: THREE.Object3D;
  /** the hammer: 0 down (fired) … 1 drawn back (cocked) */
  setHammer(k: number): void;
  /** the cylinder turned by `angle` (rad) from its first chamber */
  setCylinder(angle: number): void;
  /** chambers in the cylinder */
  chambers: number;
  /** hammer fall → shot (s): a flintlock's pan flashes first, a percussion cap goes off at once */
  hang: number;
  /** loading all the chambers again (s) */
  reload: number;
}

/**
 * A flintlock pistol of the early 18th century: walnut stock, the lock on the right, a grotesque mask on the
 * butt cap. One shot, then loading it again — powder, ball, ramrod, priming the pan.
 */
/** how much more upright than the butt the hand holds it (rad), and how far up the butt (0 low … 1 under the lock) */
const FLINT_UPRIGHT = 0.17, FLINT_HOLD = 0.75;

export async function makeFlintlock(): Promise<Pistol> {
  const m = await load('flintlock');
  // (model: metres, the muzzle toward −x, the lock on the −z side, one mesh — the cock cut out of it)
  let mesh: THREE.Mesh | null = null;
  m.traverse((o) => { if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh; });
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  splitPart(mesh!, [box(-0.004, 0.028, -0.035, 0.03, 0.075, -0.011), box(-0.004, 0.04, -0.011, 0.03, 0.075, 0.006)], 'cock');
  const setCock = hinge(m, 'cock', new THREE.Vector3(0.02, 0.032, -0.02), new THREE.Vector3(0, 0, 1));
  tame(m);
  const bore = new THREE.Vector3(-1, 0, 0);
  const muzzleM = new THREE.Vector3(-0.2165, 0.022, 0);
  const { group, toGroup } = place(m, 1, facing(bore, new THREE.Vector3(0, 1, 0)), muzzleM, new THREE.Vector3(0, 0.017, -0.305));
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(toGroup(muzzleM));
  group.add(muzzle);
  // the grip: the butt, rising forward to the lock; held high, the palm on its right (+X)
  const g0 = toGroup(new THREE.Vector3(0.112, -0.058, 0)), g1 = toGroup(new THREE.Vector3(0.058, -0.008, 0));
  // (the butt is raked more than a hand likes to hold it: the hand closes on it a little more upright and
  //  lower down, so the forearm runs low and the wrist is barely bent — as it is on the revolver)
  const axis = g1.clone().sub(g0).normalize().applyAxisAngle(new THREE.Vector3(1, 0, 0), FLINT_UPRIGHT);
  const grip = gripFrame(g0.clone().lerp(g1, FLINT_HOLD), axis, new THREE.Vector3(1, 0, 0));
  group.add(grip);
  return {
    group, muzzle, grip, chambers: 1, hang: 0.085, reload: 3,
    // (the model has the cock drawn back: it falls forward onto the frizzen)
    setHammer: (k) => setCock(0.65 * (1 - k)),
    setCylinder: () => {},
  };
}

/** a cap-and-ball revolver: the barrel along −Z, the hammer and the cylinder on hinges */
export async function makePistol(): Promise<Pistol> {
  const m = await load('revolver');
  // (model: ~dm units, the bore along +x tilted up ~15° and a little aside, the top +y)
  const bore = new THREE.Vector3(0.9634, 0.2637, -0.0476).normalize();
  const pin = new THREE.Vector3(0, 0, 1).addScaledVector(bore, -bore.z).normalize();
  const setHammer = hinge(m, 'trigger_1_low', new THREE.Vector3(-0.4, -0.24, 0.03), pin);
  const setCyl = hinge(m, 'barrel_low', new THREE.Vector3(-0.087, 0.016, -0.003), bore);
  tame(m);
  // the muzzle where the old pistol's was, so the poses still frame it
  const muzzleM = new THREE.Vector3(1.834, 0.531, -0.096).addScaledVector(bore, 0.06);
  const { group, toGroup } = place(m, 0.1, facing(bore, new THREE.Vector3(0, 1, 0)), muzzleM, new THREE.Vector3(0, 0.017, -0.305));
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(toGroup(muzzleM));
  group.add(muzzle);
  // the grip: the walnut butt, rising forward to the frame; the palm on its right (+X)
  const g0 = toGroup(new THREE.Vector3(-0.725, -0.8, 0.03)), g1 = toGroup(new THREE.Vector3(-0.725 + 0.364, -0.8 + 0.917, 0.03));
  // (held high on the butt, the web of the hand up under the hammer)
  const grip = gripFrame(g0.clone().lerp(g1, 0.2), g1.clone().sub(g0), new THREE.Vector3(1, 0, 0));
  group.add(grip);
  return {
    group, muzzle, grip, chambers: 6, hang: 0.012, reload: 3.5,
    // (the model has it drawn back: fired, it lies forward on the cap)
    setHammer: (k) => setHammer(-0.5 * (1 - k)),
    setCylinder: (a) => setCyl(a),
  };
}

export interface Rapier {
  group: THREE.Group;
  /** blade base and tip, in the rapier's frame (for the swing trail) */
  base: THREE.Object3D;
  tip: THREE.Object3D;
  grip: THREE.Object3D;
}

/** a Spanish cup-hilt rapier: the blade along −Z, its edges up and down, the knuckle bow under the fingers (−Y) */
export async function makeRapier(): Promise<Rapier> {
  const m = await load('rapier');
  tame(m);
  // (polished steel an arm's length from the eye mirrors the whole bright sky: less of it)
  m.traverse((o) => { const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (mat?.isMeshStandardMaterial) mat.envMapIntensity = 0.35; });
  // (model: the tip at z −1, the pommel at +1, the knuckle bow toward −x; ~1.24 m overall at this scale)
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const { group, toGroup } = place(m, 0.62, q, new THREE.Vector3(0.0045, 0, 0.805), new THREE.Vector3(0, 0, 0.056));
  const base = new THREE.Object3D(); base.position.copy(toGroup(new THREE.Vector3(0, 0, 0.52))); group.add(base);
  const tip = new THREE.Object3D(); tip.position.copy(toGroup(new THREE.Vector3(0, 0, -1))); group.add(tip);
  const grip = gripFrame(new THREE.Vector3(0, 0, 0.056), new THREE.Vector3(0, 0, -1));
  group.add(grip);
  return { group, base, tip, grip };
}

export interface Lantern {
  group: THREE.Group;
  /** the part that swings (everything below the hand), pivoting on the handle */
  body: THREE.Group;
  /** where the flame is: its light hangs here */
  flame: THREE.Object3D;
  /** what glows with the flame (their emissive intensity flickers round `glowBase`) */
  glow: THREE.MeshStandardMaterial[];
  glowBase: number;
  /** its light: colour, strength (× the flicker) and reach (m) */
  light: { color: THREE.Color; intensity: number; distance: number };
  grip: THREE.Object3D;
}

/**
 * A ship's hand lantern: a green-painted iron body round panes of horn-pale glass, a peaked bail on top, a
 * candle burning in its dish at the bottom. Held overhand by the peak of the bail.
 */
export async function makeLantern(): Promise<Lantern> {
  const m = await load('candle_lantern');
  tame(m);
  // (model: ~2 units tall, the peak of the bail at y 0.99, the candle's wick at y −0.72; ~0.3 m tall here)
  const s = 0.15;
  const { group: body, toGroup } = place(m, s, new THREE.Quaternion(), new THREE.Vector3(0, 0.99, 0));
  // the candle's flame: a small teardrop of fire over the wick, glowing — and the light hangs in it
  const flameMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.62, 0.25), emissiveIntensity: 6 });
  const fl = new THREE.SphereGeometry(0.0042, 12, 10);
  fl.scale(1, 2.3, 1);
  fl.translate(0, 0.0085, 0);
  const flameMesh = new THREE.Mesh(fl, flameMat);
  flameMesh.position.copy(toGroup(new THREE.Vector3(0, -0.72, 0)));
  body.add(flameMesh);
  const flame = new THREE.Object3D();
  flame.position.copy(flameMesh.position).add(new THREE.Vector3(0, 0.009, 0));
  body.add(flame);
  const group = new THREE.Group();
  group.add(body);
  const grip = gripFrame(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0, 0));
  group.add(grip);
  return { group, body, flame, glow: [flameMat], glowBase: 6, light: { color: new THREE.Color(0xffb060), intensity: 42, distance: 38 }, grip };
}

/**
 * The dark lantern: a skull hung by a braided cord, its jaw slung below on chains round a candle — and the
 * candle burns with a cold, sickly green flame that lights only a little way round.
 */
export async function makeSkullLantern(): Promise<Lantern> {
  const m = await load('skull_lantern');
  tame(m);
  // the flame: a card with a flame's picture over the candle, lit from within and added to the light
  const glow: THREE.MeshStandardMaterial[] = [];
  m.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (mat?.name === 'Daco_5128727' && !glow.includes(mat)) {
      mat.emissive.setRGB(0.55, 1, 0.65);
      mat.emissiveMap = mat.map;
      mat.emissiveIntensity = 4;
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
      glow.push(mat);
    }
  });
  // ~0.36 m from the top of the cord to the jaw; the top of the cord at the origin
  const { group: body, toGroup } = place(m, 0.02, new THREE.Quaternion(), new THREE.Vector3(-0.074, 17.2, -1.43));
  const flame = new THREE.Object3D();
  flame.position.copy(toGroup(new THREE.Vector3(0.0875, 5.4, 0.251)));
  body.add(flame);
  const group = new THREE.Group();
  group.add(body);
  const grip = gripFrame(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0, 0));
  group.add(grip);
  return { group, body, flame, glow, glowBase: 4, light: { color: new THREE.Color(0x7dff9a), intensity: 16, distance: 20 }, grip };
}

export interface RumBottle {
  group: THREE.Group;
  grip: THREE.Object3D;
  cork: THREE.Object3D;
  /** once per frame, after the bottle is posed: the rum's surface follows the sloshing `up` (world, unit) */
  setLiquid(fill: number, up: THREE.Vector3): void;
}

/**
 * A bottle of Brazilian rum from the J. Haberfeld factory ("Bottle of Brazilian Rum", Virtual Museums of
 * Małopolska, CC-BY-4.0): a squat, square green flask, a paper label, a cork. The group's origin is its
 * mouth (so a pose puts the mouth where it wants it: at his lips, drinking), the bottle standing on +Y below.
 *
 * The rum in it is a box filling the body, cut off above its surface — a plane through the box at the
 * height that leaves `fill` of it below, square to the `up` it is given (the world's, swinging as the rum
 * sloshes). Its inside faces, seen through the cut, are drawn lighter: the surface. Tilted, the rum runs to
 * whatever is lowest — into the neck as he drinks.
 */
export async function makeRum(): Promise<RumBottle> {
  const m = await load('rum');
  tame(m);
  // (the glass as scanned is near black: thinner and clearer, the rum showing through)
  m.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (mat?.transparent && o.parent?.name.includes('Butelka')) { mat.opacity = 0.42; mat.roughness = 0.08; mat.depthWrite = false; mat.envMapIntensity = 1.1; }
  });
  const cork = m.getObjectByName('MZ_25_d_korek_edit06_4') ?? new THREE.Object3D();
  // (model: ~1 unit tall, the mouth at y 0.567; the body x ±0.18, z ±0.15, y −0.43…0.24; ~26 cm tall here)
  const s = 0.26;
  const { group, toGroup } = place(m, s, new THREE.Quaternion(), new THREE.Vector3(0, 0.567, 0));
  // the rum
  const W = 0.32, H = 0.56, D = 0.26, cy = -0.07;
  // (rounded like the flask's own corners)
  const geo = new RoundedBoxGeometry(W, H, D, 4, 0.07);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.36, 0.1, 0.012), roughness: 0.1, metalness: 0, side: THREE.DoubleSide,
    emissive: new THREE.Color(0.08, 0.025, 0.003),
    // (rum is clear: the fingers round the back of the flask show through it, darkened amber)
    transparent: true, opacity: 0.72, depthWrite: false });
  const uniforms = { uN: { value: new THREE.Vector3(0, 1, 0) }, uC: { value: new THREE.Vector3() }, uH: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'varying vec3 vRumW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRumW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform vec3 uN, uC; uniform float uH; varying vec3 vRumW;\n' + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (dot(vRumW - uC, uN) > uH) discard;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  if (!gl_FrontFacing) totalEmissiveRadiance += vec3(0.2, 0.08, 0.015);');
  };
  const rum = new THREE.Mesh(geo, mat);
  rum.position.copy(toGroup(new THREE.Vector3(0, cy, 0)));
  rum.scale.setScalar(s);
  group.add(rum);
  // held round the body, the index finger up by the shoulder, the palm on its right
  // (the palm on the flask's narrow side, turned a little toward its back: the fingers reach round it)
  const pa = -0.3;
  const grip = gripFrame(toGroup(new THREE.Vector3(0, -0.12, 0)), new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.cos(pa), 0, Math.sin(pa)));
  group.add(grip);
  const q = new THREE.Quaternion(), ax = new THREE.Vector3(), half = [W / 2, H / 2, D / 2].map((v) => v * s);
  return {
    group, grip, cork,
    setLiquid(fill, up) {
      rum.updateWorldMatrix(true, false);
      rum.getWorldPosition(uniforms.uC.value);
      rum.getWorldQuaternion(q);
      // how far the box reaches along `up` either side of its middle; the surface where `fill` of it lies below
      let e = 0;
      for (let k = 0; k < 3; k++) e += half[k] * Math.abs(ax.set(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(q).dot(up));
      uniforms.uN.value.copy(up);
      uniforms.uH.value = -e + 2 * e * Math.min(1, Math.max(0, fill)) - (fill <= 0.001 ? 1 : 0);
    },
  };
}
