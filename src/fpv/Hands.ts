import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/*
 * The sailor's arm and hand in first person: "Hands model rigged" by SomeOne34321 (Sketchfab, CC-BY-4.0), a
 * skinned mesh of both arms (npm run optimize-hands). Only the right is used — the left arm and hand are
 * folded away to nothing. The right hand is put on the grip of whatever is held, its fingers curled to that
 * grip's pose; the arm follows it by two-bone IK from a shoulder fixed below and behind the eye, the elbow
 * down and out to the side.
 *
 * In the rig the hand bone is not a child of the forearm (a first-person rig: the hand is placed, the arm is
 * solved to it). Its frame is the model's own; `fitted` gives, for a grasp, where the grip
 * lies in the hand — in the convention of the weapons' grips (models.ts): the grip along +Y (little finger
 * → index), the palm on the +X side, the fingers wrapping round the front (−Z).
 */

const B = {
  shoulder: 'Bone_02', elbow: 'Bone001_03', twist: 'Bone018_04', wrist: 'Bone018_end_041', hand: 'Bone020_024',
  lShoulder: 'Bone1_05', lHand: 'Bone182_07',
};
/** the fingers of the right hand, knuckle to last joint (and the tip) */
const FINGERS = {
  thumb: ['Bone015_038', 'Bone016_039', 'Bone017_040', 'Bone017_end_052'],
  index: ['Bone012_035', 'Bone013_036', 'Bone014_037', 'Bone014_end_051'],
  middle: ['Bone009_032', 'Bone010_033', 'Bone011_034', 'Bone011_end_050'],
  ring: ['Bone006_029', 'Bone007_030', 'Bone008_031', 'Bone008_end_049'],
  pinky: ['Bone003_026', 'Bone004_027', 'Bone005_028', 'Bone005_end_048'],
};
type Finger = keyof typeof FINGERS;

/** the shoulder, in the eye's frame (right, down, a little behind) */
const SHOULDER = new THREE.Vector3(0.2, -0.26, 0.1);
/** which way the elbow goes (eye frame): down and out */
const ELBOW_POLE = new THREE.Vector3(0.9, -1, 0.3).normalize();

/**
 * How the hand holds something: for each finger, the extra bend (rad) at its three joints over the model's
 * rest pose (+ closes); the thumb also turns across the palm (`thumbAcross`, rad at its base).
 */
export interface Grasp {
  index: [number, number, number];
  middle: [number, number, number];
  ring: [number, number, number];
  pinky: [number, number, number];
  thumb: [number, number, number];
  thumbAcross: number;
  /** radius of the grip (m): the fingers close until they lie on it (see fitted) */
  radius: number;
  /** false: too big to close a fist round (a bottle's body) — the palm laid on its side, `radius` out from the
   *  grip's axis, the fingers bent as given */
  fit?: boolean;
}

export class Hands {
  /** put it in the eye's frame (the overlay root that follows the camera) */
  readonly root = new THREE.Group();
  loaded = false;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<string, THREE.Quaternion>();
  private readonly restPos = new Map<string, THREE.Vector3>();
  /** how far the fingers close on each grasp and the grip frame in the hand then (see fitted) */
  private readonly gripCache = new WeakMap<Grasp, { k: number; frame: THREE.Matrix4 }>();
  private upperLen = 0.25;
  private foreLen = 0.28;
  /** at rest (the wrist straight): the forearm's way back from the wrist, in the hand's frame, and the hand's
   *  turn relative to the forearm (for spreading a twist along it) */
  private readonly foreInHand = new THREE.Vector3(0, -1, 0);
  private readonly handInFore = new THREE.Quaternion();
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const model = (await loader.loadAsync(url)).scene;
    // the model looks along +x with +z to its right; the eye looks along −z with +x to its right
    model.rotation.y = Math.PI / 2;
    this.root.add(model);
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        this.bones.set(o.name, o as THREE.Bone);
        this.rest.set(o.name, o.quaternion.clone());
        this.restPos.set(o.name, o.position.clone());
      }
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        o.frustumCulled = false; // (posed far from its bind box)
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
        // a sailor's arm: the texture's pale skin weathered and sun-browned (a tint over it), and no metal
        mat.color.setRGB(0.78, 0.6, 0.47, THREE.SRGBColorSpace);
        mat.metalness = 0;
        mat.envMapIntensity = 0.6;
      }
    });
    // the shoulder where it belongs in the eye's frame
    this.root.updateMatrixWorld(true);
    const s = this.bone(B.shoulder).getWorldPosition(new THREE.Vector3()).applyMatrix4(this.m.copy(this.root.matrixWorld).invert());
    model.position.copy(SHOULDER).sub(s);
    this.root.updateMatrixWorld(true);
    const pos = (n: string) => this.bone(n).getWorldPosition(new THREE.Vector3());
    this.upperLen = pos(B.shoulder).distanceTo(pos(B.elbow));
    this.foreLen = pos(B.elbow).distanceTo(pos(B.wrist));
    const qHand = this.bone(B.hand).getWorldQuaternion(new THREE.Quaternion());
    const qFore = this.bone(B.twist).getWorldQuaternion(new THREE.Quaternion());
    this.foreInHand.copy(pos(B.elbow).sub(pos(B.wrist)).normalize().applyQuaternion(qHand.clone().invert()));
    this.handInFore.copy(qFore.invert().multiply(qHand));
    // the left arm and hand folded away to nothing
    for (const n of [B.lShoulder, B.lHand]) this.bone(n).scale.setScalar(1e-4);
    this.loaded = true;
  }

  private bone(n: string): THREE.Bone {
    const b = this.bones.get(n);
    if (!b) throw new Error(`hands: no bone ${n}`);
    return b;
  }

  /**
   * The fist as the fingers are now: the grip frame in the hand bone's frame — its axis along the line of the
   * knuckles (little finger → index), its centre in the middle of the fist: the centre of the circle the
   * middle, ring and little fingers' joints lie on, seen down that axis — and that circle's radius. A hand
   * too open to make a fist falls back to a grip of `radius` in front of the palm (R: Infinity).
   */
  private fist(radius: number): { frame: THREE.Matrix4; R: number } {
    const hand = this.bone(B.hand);
    hand.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(hand.matrixWorld).invert();
    const at = (n: string) => this.bone(n).getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const idx = at(FINGERS.index[0]), pky = at(FINGERS.pinky[0]), mid = at(FINGERS.middle[0]);
    const y = idx.clone().sub(pky).normalize();
    // along the hand, wrist (the bone's origin) → knuckles, square to the grip
    const along = mid.clone().addScaledVector(y, -mid.dot(y)).normalize();
    // the palm faces y × along for a right hand (palm down, fingers ahead: the index to the left, so
    // left × ahead = down): the grip lies on that side
    const toGrip = new THREE.Vector3().crossVectors(y, along).normalize();
    const knuckles = idx.clone().add(pky).multiplyScalar(0.5);
    // a circle fitted (least squares, Kåsa) to the finger joints in the plane square to the grip
    const pts: [number, number][] = [];
    for (const f of ['middle', 'ring', 'pinky'] as const) for (const n of FINGERS[f]) { const p = at(n); pts.push([p.dot(along), p.dot(toGrip)]); }
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    for (const [u, v] of pts) { const z = u * u + v * v; sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v; sxz += u * z; syz += v * z; sz += z; }
    // [sxx sxy sx; sxy syy sy; sx sy N]·[D E F] = −[sxz syz sz]
    const A = new THREE.Matrix3().set(sxx, sxy, sx, sxy, syy, sy, sx, sy, pts.length);
    const sol = new THREE.Vector3(-sxz, -syz, -sz).applyMatrix3(A.clone().invert());
    const cu = -sol.x / 2, cv = -sol.y / 2;
    let R = Math.sqrt(Math.max(0, cu * cu + cv * cv - sol.z));
    const origin = knuckles.clone().addScaledVector(along, -knuckles.dot(along)).addScaledVector(toGrip, -knuckles.dot(toGrip));
    // (a fist round anything from a wire to a bottle's body)
    if (Number.isFinite(R) && R > 0.01 && R < 0.12) origin.addScaledVector(along, cu).addScaledVector(toGrip, cv);
    else { origin.copy(knuckles).addScaledVector(toGrip, radius + 0.016).addScaledVector(along, -0.022); R = Infinity; }
    // grip frame axes in the hand's frame: X toward the palm, Y along the grip, Z = X × Y
    const X = toGrip.clone().negate(), Z = new THREE.Vector3().crossVectors(X, y);
    return { frame: new THREE.Matrix4().makeBasis(X, y, Z).setPosition(origin), R };
  }

  /** the grip frame for something held against the palm: its axis along the knuckles, `r` out in front of the palm */
  private palmFrame(r: number): THREE.Matrix4 {
    const hand = this.bone(B.hand);
    hand.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(hand.matrixWorld).invert();
    const at = (n: string) => this.bone(n).getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const idx = at(FINGERS.index[0]), pky = at(FINGERS.pinky[0]), mid = at(FINGERS.middle[0]);
    const y = idx.clone().sub(pky).normalize();
    const along = mid.clone().addScaledVector(y, -mid.dot(y)).normalize();
    const toGrip = new THREE.Vector3().crossVectors(y, along).normalize();
    // (the palm's middle: back from the knuckles toward the wrist, and the object's middle `r` out from it)
    const origin = idx.clone().add(pky).multiplyScalar(0.5).addScaledVector(along, -0.035).addScaledVector(toGrip, r + 0.012);
    const X = toGrip.clone().negate(), Z = new THREE.Vector3().crossVectors(X, y);
    return new THREE.Matrix4().makeBasis(X, y, Z).setPosition(origin);
  }

  /** the fingers back to rest, then bent to `grasp` — its four fingers' bends scaled by `k`, the thumb as given */
  private curl(grasp: Grasp, k: number): void {
    for (const n of Object.values(FINGERS).flat()) { const r = this.rest.get(n); if (r) this.bone(n).quaternion.copy(r); }
    const bend = (f: Finger, a: [number, number, number], s: number) => a.forEach((b, i) => this.bone(FINGERS[f][i]).quaternion.multiply(this.q.setFromAxisAngle(Z_AXIS, b * s)));
    bend('index', grasp.index, k); bend('middle', grasp.middle, k); bend('ring', grasp.ring, k); bend('pinky', grasp.pinky, k);
    bend('thumb', grasp.thumb, 1);
    this.bone(FINGERS.thumb[0]).quaternion.multiply(this.q.setFromAxisAngle(X_AXIS, grasp.thumbAcross));
  }

  /**
   * How far to close the fingers on this grasp, and the grip frame then: the fingers close (their bends
   * scaled together) until the fist is as round as the grip — its joints a finger's thickness out from its
   * surface — so the fingertips lie on the grip, not in it. Found once per grasp (bisection).
   */
  private fitted(grasp: Grasp): { k: number; frame: THREE.Matrix4 } {
    const hit = this.gripCache.get(grasp);
    if (hit) return hit;
    if (grasp.fit === false) {
      this.curl(grasp, 1);
      const fit = { k: 1, frame: this.palmFrame(grasp.radius) };
      this.gripCache.set(grasp, fit);
      return fit;
    }
    const target = grasp.radius + FINGER;
    let lo = 0.2, hi = 2;
    for (let n = 0; n < 14; n++) {
      const k = (lo + hi) / 2;
      this.curl(grasp, k);
      // (more bend, a smaller fist)
      if (this.fist(grasp.radius).R > target) lo = k; else hi = k;
    }
    const k = (lo + hi) / 2;
    this.curl(grasp, k);
    const fit = { k, frame: this.fist(grasp.radius).frame };
    this.gripCache.set(grasp, fit);
    return fit;
  }

  /**
   * Once per frame, after the held piece is posed: the hand on `grip` (an object in the eye's frame whose
   * world matrix is the grip frame), the fingers in `grasp`, the arm solved to it. null: hidden.
   */
  update(grip: THREE.Object3D | null, grasp: Grasp | null): void {
    if (!this.loaded) return;
    this.root.visible = !!grip && !!grasp;
    if (!grip || !grasp) return;
    // back to rest, then the grasp, the fingers closed round the grip
    for (const n of [B.shoulder, B.elbow, B.twist, B.hand]) this.bone(n).quaternion.copy(this.rest.get(n)!);
    this.bone(B.shoulder).position.copy(this.restPos.get(B.shoulder)!);
    const fit = this.fitted(grasp);
    this.curl(grasp, fit.k);

    // the hand: its world matrix = grip · (grip frame in the hand)⁻¹
    const hand = this.bone(B.hand);
    grip.updateWorldMatrix(true, false);
    const want = this.m.copy(grip.matrixWorld).multiply(new THREE.Matrix4().copy(fit.frame).invert());
    hand.parent!.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4().copy(hand.parent!.matrixWorld).invert().multiply(want);
    local.decompose(hand.position, hand.quaternion, this.v);

    // the arm: two-bone IK from the shoulder to the wrist, the elbow toward the pole
    this.root.updateMatrixWorld(true);
    const wpos = (n: string) => this.bone(n).getWorldPosition(new THREE.Vector3());
    let S = wpos(B.shoulder);
    const W = wpos(B.hand);
    // out of reach (a long cut, a lantern held up high): the shoulder goes after the hand, as it does
    const reach = (this.upperLen + this.foreLen) * 0.97, excess = S.distanceTo(W) - reach;
    if (excess > 0) {
      const sh = this.bone(B.shoulder), toHand = W.clone().sub(S).normalize().multiplyScalar(excess);
      const moved = S.clone().add(toHand);
      sh.position.copy(sh.parent!.worldToLocal(moved.clone()));
      sh.updateWorldMatrix(false, true);
      S = moved;
    }
    const toW = W.clone().sub(S);
    const d = THREE.MathUtils.clamp(toW.length(), 0.05, this.upperLen + this.foreLen - 1e-3);
    const dir = toW.normalize();
    const a = (this.upperLen ** 2 - this.foreLen ** 2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.upperLen ** 2 - a * a));
    // the elbow: where the forearm would lie with the wrist straight (back from the wrist along the hand), as
    // near as the arm can bring it — leaning a little to the natural down-and-out
    const qHand = hand.getWorldQuaternion(new THREE.Quaternion());
    const straight = W.clone().addScaledVector(this.foreInHand.clone().applyQuaternion(qHand), this.foreLen).sub(S);
    const toStraight = straight.addScaledVector(dir, -straight.dot(dir));
    const natural = ELBOW_POLE.clone().transformDirection(this.root.matrixWorld);
    natural.addScaledVector(dir, -natural.dot(dir)).normalize();
    const side = toStraight.lengthSq() > 1e-8 ? toStraight.normalize().multiplyScalar(0.8).addScaledVector(natural, 0.2).normalize() : natural;
    const E = S.clone().addScaledVector(dir, a).addScaledVector(side, h);
    this.aim(B.shoulder, B.elbow, E);
    this.aim(B.elbow, B.wrist, W);
    // the hand's turn about the forearm spread along it, half at the elbow and half in the twist bone, as a
    // forearm turns — not all in the wrist, which would wring the skin
    const fore = this.bone(B.twist);
    fore.updateWorldMatrix(true, false);
    const qFore = fore.getWorldQuaternion(new THREE.Quaternion());
    // (the forearm as it would be to carry the hand with the wrist as at rest, in the forearm's own frame)
    const rel = qFore.clone().invert().multiply(qHand).multiply(this.handInFore.clone().invert());
    // its twist about the bone (local +y)
    // (q and −q are the same turn: take the one with w ≥ 0, so the angle is the short way round, within ±180°)
    const sgn = rel.w < 0 ? -1 : 1;
    const twist = 2 * Math.atan2(rel.y * sgn, rel.w * sgn);
    for (const n of [B.elbow, B.twist]) this.bone(n).quaternion.multiply(this.q.setFromAxisAngle(Y_AXIS, twist / 2));
    // (the hand keeps its place: it is not the forearm's child)
    this.bone(B.elbow).updateWorldMatrix(false, true);
  }

  /** turn bone `n` (in world terms) so that its child `c` lies toward `target` */
  private aim(n: string, c: string, target: THREE.Vector3): void {
    const b = this.bone(n);
    b.updateWorldMatrix(true, true);
    const from = b.getWorldPosition(new THREE.Vector3());
    const cur = this.bone(c).getWorldPosition(new THREE.Vector3()).sub(from).normalize();
    const want = target.clone().sub(from).normalize();
    const delta = new THREE.Quaternion().setFromUnitVectors(cur, want);
    const world = b.getWorldQuaternion(new THREE.Quaternion());
    const parent = b.parent!.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(parent.invert().multiply(delta.multiply(world)));
    b.updateWorldMatrix(false, true);
  }
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** a finger's joints lie this far (m) out from what it closes on: the finger's half-thickness */
const FINGER = 0.0085;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
