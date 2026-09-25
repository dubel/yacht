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
 * solved to it). Its frame is the model's own; `gripFrame` gives, for a grip of radius r, where that grip
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
  /** radius of the grip (m) */
  radius: number;
}

export class Hands {
  /** put it in the eye's frame (the overlay root that follows the camera) */
  readonly root = new THREE.Group();
  loaded = false;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<string, THREE.Quaternion>();
  private readonly restPos = new Map<string, THREE.Vector3>();
  /** grip frame → hand bone, for a grip of radius r (cached by r) */
  private readonly gripCache = new Map<number, THREE.Matrix4>();
  private upperLen = 0.25;
  private foreLen = 0.28;
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
   * The grip frame in the hand bone's frame, for a grip of radius r: its axis along the line of the knuckles
   * (little finger → index), in front of the palm by the grip's radius and a little more.
   */
  private gripFrame(r: number): THREE.Matrix4 {
    const key = Math.round(r * 1e4);
    const hit = this.gripCache.get(key);
    if (hit) return hit;
    // knuckles and wrist in the hand bone's frame (they don't move with the fingers)
    const hand = this.bone(B.hand);
    hand.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(hand.matrixWorld).invert();
    const at = (n: string) => this.bone(n).getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const idx = at(FINGERS.index[0]), pky = at(FINGERS.pinky[0]), mid = at(FINGERS.middle[0]);
    const wrist = new THREE.Vector3();
    const y = idx.clone().sub(pky).normalize();
    // along the hand, wrist → knuckles, square to the grip
    const along = mid.clone().sub(wrist);
    along.addScaledVector(y, -along.dot(y)).normalize();
    // the palm faces y × along for a right hand (palm down, fingers ahead: the index to the left, so
    // left × ahead = down): the grip lies on that side
    const toGrip = new THREE.Vector3().crossVectors(y, along).normalize();
    const knuckles = idx.clone().add(pky).multiplyScalar(0.5);
    const origin = knuckles.addScaledVector(toGrip, r + 0.016).addScaledVector(along, -0.022);
    // grip frame axes in the hand's frame: X toward the palm, Y along the grip, Z = X × Y
    const X = toGrip.clone().negate(), Z = new THREE.Vector3().crossVectors(X, y);
    const g = new THREE.Matrix4().makeBasis(X, y, Z).setPosition(origin);
    this.gripCache.set(key, g);
    return g;
  }

  /**
   * Once per frame, after the held piece is posed: the hand on `grip` (an object in the eye's frame whose
   * world matrix is the grip frame), the fingers in `grasp`, the arm solved to it. null: hidden.
   */
  update(grip: THREE.Object3D | null, grasp: Grasp | null): void {
    if (!this.loaded) return;
    this.root.visible = !!grip && !!grasp;
    if (!grip || !grasp) return;
    // back to rest, then the grasp
    for (const n of [B.shoulder, B.elbow, B.twist, B.hand, ...Object.values(FINGERS).flat()]) {
      const r = this.rest.get(n);
      if (r) this.bone(n).quaternion.copy(r);
    }
    this.bone(B.shoulder).position.copy(this.restPos.get(B.shoulder)!);
    const bend = (f: Finger, a: [number, number, number]) => a.forEach((k, i) => this.bone(FINGERS[f][i]).quaternion.multiply(this.q.setFromAxisAngle(Z_AXIS, k)));
    bend('index', grasp.index); bend('middle', grasp.middle); bend('ring', grasp.ring); bend('pinky', grasp.pinky);
    bend('thumb', grasp.thumb);
    this.bone(FINGERS.thumb[0]).quaternion.multiply(this.q.setFromAxisAngle(X_AXIS, grasp.thumbAcross));

    // the hand: its world matrix = grip · (grip frame in the hand)⁻¹
    const hand = this.bone(B.hand);
    grip.updateWorldMatrix(true, false);
    const want = this.m.copy(grip.matrixWorld).multiply(new THREE.Matrix4().copy(this.gripFrame(grasp.radius)).invert());
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
    const eye = this.root.matrixWorld;
    const pole = ELBOW_POLE.clone().transformDirection(eye);
    const toW = W.clone().sub(S);
    const d = THREE.MathUtils.clamp(toW.length(), 0.05, this.upperLen + this.foreLen - 1e-3);
    const dir = toW.normalize();
    const a = (this.upperLen ** 2 - this.foreLen ** 2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.upperLen ** 2 - a * a));
    const side = pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const E = S.clone().addScaledVector(dir, a).addScaledVector(side, h);
    this.aim(B.shoulder, B.elbow, E);
    this.aim(B.elbow, B.wrist, W);
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
const Z_AXIS = new THREE.Vector3(0, 0, 1);
