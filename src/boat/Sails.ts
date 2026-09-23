import * as THREE from 'three';

/*
 * Procedural sails for the Amadis rig (single mast: gaff mainsail, three square sails, two headsails).
 * The GLB only has the sails furled on their spars, so the set sails are generated here:
 * a grid per sail, deformed on the CPU every frame (≈2k vertices total) — billow from the apparent wind,
 * flogging when luffing, and furling toward the spar. Their forces come from BoatPhysics, not from
 * this geometry (SKETCH §14: visual cloth ≠ gameplay force).
 *
 * The model's boom, gaff and yards (+ the furled bundles on the yards) are cut out of the merged
 * meshes by region and re-parented to pivots so they swing with the trim.
 */

const MAST_Z = 1.85;
const YARDS = [12.7, 19.0, 22.95];
const YARD_HALF = [6.2, 4.6, 3.05];
/** square sails hang just forward of the mast */
const SQ_Z = MAST_Z + 0.35;

type Kind = 'gaff' | 'square' | 'head';

interface SailDef {
  kind: Kind;
  /** corners in boat frame (un-trimmed): luff-top, leech-top, leech-bottom, luff-bottom */
  corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  /** furl toward the top edge (square: to the yard) or toward the luff (gaff, headsails) */
  furl: 'top' | 'luff';
  maxCamber: number;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const DEFS: SailDef[] = [
  // gaff mainsail: throat, peak, clew (boom end), tack
  { kind: 'gaff', corners: [v(0, 12.3, MAST_Z - 0.35), v(0, 15.8, -5.1), v(0, 4.0, -10.4), v(0, 2.9, MAST_Z - 0.35)], furl: 'luff', maxCamber: 1.1 },
  // square sails hang from a yard to the yard below; the course to just above the deck
  { kind: 'square', corners: [v(3.0, YARDS[2] - 0.15, SQ_Z), v(-3.0, YARDS[2] - 0.15, SQ_Z), v(-4.5, YARDS[1] + 0.1, SQ_Z), v(4.5, YARDS[1] + 0.1, SQ_Z)], furl: 'top', maxCamber: 0.45 },
  { kind: 'square', corners: [v(4.5, YARDS[1] - 0.15, SQ_Z), v(-4.5, YARDS[1] - 0.15, SQ_Z), v(-6.0, YARDS[0] + 0.1, SQ_Z), v(6.0, YARDS[0] + 0.1, SQ_Z)], furl: 'top', maxCamber: 0.8 },
  { kind: 'square', corners: [v(6.0, YARDS[0] - 0.15, SQ_Z), v(-6.0, YARDS[0] - 0.15, SQ_Z), v(-6.2, 4.6, SQ_Z), v(6.2, 4.6, SQ_Z)], furl: 'top', maxCamber: 1.1 },
  // headsails: head, (head), clew, tack
  { kind: 'head', corners: [v(0, 21.5, 2.6), v(0, 21.5, 2.6), v(0, 4.4, 5.6), v(0, 4.9, 17.6)], furl: 'luff', maxCamber: 0.9 },
  { kind: 'head', corners: [v(0, 15.0, 2.7), v(0, 15.0, 2.7), v(0, 3.6, 4.2), v(0, 3.2, 10.5)], furl: 'luff', maxCamber: 0.6 },
];

const NU = 18, NV = 18;

class Sail {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly base: Float32Array; // flat sail positions (pivot-local)
  private readonly uv: Float32Array;
  readonly pivot = new THREE.Group();

  constructor(readonly def: SailDef, material: THREE.Material) {
    const [a, b, c, d] = def.corners;
    // pivot: mast axis for gaff + square sails, luff (stay) line for headsails
    if (def.kind === 'head') this.pivot.position.copy(d);
    else this.pivot.position.set(0, 0, def.kind === 'square' ? SQ_Z : MAST_Z);
    const base = new Float32Array((NU + 1) * (NV + 1) * 3);
    const uv = new Float32Array((NU + 1) * (NV + 1) * 2);
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    let o = 0;
    for (let j = 0; j <= NV; j++)
      for (let i = 0; i <= NU; i++) {
        const u = i / NU, w = j / NV; // u: luff→leech, w: top→bottom
        p.lerpVectors(a, b, u);
        q.lerpVectors(d, c, u);
        p.lerp(q, w).sub(this.pivot.position);
        base[o * 3] = p.x; base[o * 3 + 1] = p.y; base[o * 3 + 2] = p.z;
        uv[o * 2] = u; uv[o * 2 + 1] = w;
        o++;
      }
    const idx: number[] = [];
    for (let j = 0; j < NV; j++)
      for (let i = 0; i < NU; i++) {
        const k = j * (NU + 1) + i;
        idx.push(k, k + NU + 1, k + 1, k + 1, k + NU + 1, k + NU + 2);
      }
    this.base = base;
    this.uv = uv;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.pivot.add(this.mesh);
  }

  /**
   * @param flow apparent-wind direction in the pivot frame (unit, where the air goes)
   * @param camber 0..1 fullness
   * @param flog 0..1 flogging amplitude (luffing)
   * @param up 0..1 set / furled
   */
  deform(flow: THREE.Vector3, camber: number, flog: number, up: number, t: number): void {
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const { base, uv, def } = this;
    // sail plane normal (flat), oriented to where the wind pushes it
    const n = new THREE.Vector3();
    {
      const [a, b, , d] = def.corners;
      const e1 = new THREE.Vector3().subVectors(b.equals(a) ? def.corners[2] : b, a);
      const e2 = new THREE.Vector3().subVectors(d, a);
      n.crossVectors(e1, e2).normalize();
      if (n.dot(flow) < 0) n.negate();
    }
    const depth = def.maxCamber * camber;
    const top = def.furl === 'top';
    const [a0, , , d0] = def.corners;
    const luffTop = a0.clone().sub(this.pivot.position), luffBot = d0.clone().sub(this.pivot.position);
    for (let k = 0; k < base.length / 3; k++) {
      const u = uv[k * 2], w = uv[k * 2 + 1];
      let x = base[k * 3], y = base[k * 3 + 1], z = base[k * 3 + 2];
      // billow: deepest ~40% back from the luff, fading to the edges
      const shape = Math.sin(Math.PI * Math.pow(u, 0.8)) * (top ? Math.sin(Math.PI * (0.15 + 0.85 * w)) : 0.35 + 0.65 * Math.sin(Math.PI * w));
      let b = depth * shape;
      // flogging: travelling waves from luff to leech
      if (flog > 0) b += flog * 0.35 * u * Math.sin(u * 9 - t * 11 + w * 3) * (0.6 + 0.4 * Math.sin(t * 3.1 + w * 5));
      x += n.x * b; y += n.y * b; z += n.z * b;
      if (up < 1) {
        const f = 1 - up;
        if (top) {
          // gather up toward the yard, bunching into folds
          const yTop = base[1] + (base[(NU) * 3 + 1] - base[1]) * u;
          y = y + (yTop - y) * f;
          const fold = Math.sin(w * 40) * 0.25 * f * (1 - f);
          x += n.x * fold; z += n.z * fold;
        } else {
          // brail toward the luff (mast / stay)
          const lx = luffTop.x + (luffBot.x - luffTop.x) * w;
          const ly = luffTop.y + (luffBot.y - luffTop.y) * w;
          const lz = luffTop.z + (luffBot.z - luffTop.z) * w;
          x += (lx - x) * f; y += (ly - y) * f; z += (lz - z) * f;
        }
      }
      arr[k * 3] = x; arr[k * 3 + 1] = y; arr[k * 3 + 2] = z;
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.mesh.visible = up > 0.03;
  }
}

/** a spar cut out of the merged GLB and hung on a pivot */
function extractRegion(root: THREE.Object3D, boatRoot: THREE.Object3D, test: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, sail: boolean) => boolean, pivot: THREE.Object3D): void {
  boatRoot.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(boatRoot.matrixWorld).invert();
  const toBoat = new THREE.Matrix4();
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.extracted) meshes.push(o as THREE.Mesh); });
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const pivotInv = new THREE.Matrix4().makeTranslation(-pivot.position.x, -pivot.position.y, -pivot.position.z);
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry;
    if (!g.index) continue;
    const mat = m.material as THREE.MeshStandardMaterial;
    const sail = /Sail/.test(mat.name);
    toBoat.multiplyMatrices(inv, m.matrixWorld);
    const pos = g.attributes.position;
    const index = g.index.array;
    const keep: number[] = [], take: number[] = [];
    for (let i = 0; i < index.length; i += 3) {
      va.fromBufferAttribute(pos, index[i]).applyMatrix4(toBoat);
      vb.fromBufferAttribute(pos, index[i + 1]).applyMatrix4(toBoat);
      vc.fromBufferAttribute(pos, index[i + 2]).applyMatrix4(toBoat);
      (test(va, vb, vc, sail) ? take : keep).push(index[i], index[i + 1], index[i + 2]);
    }
    if (!take.length) continue;
    g.setIndex(keep);
    const ng = g.clone();
    ng.setIndex(take);
    // bake into the pivot frame
    ng.applyMatrix4(new THREE.Matrix4().multiplyMatrices(pivotInv, toBoat));
    const part = new THREE.Mesh(ng, mat);
    part.castShadow = part.receiveShadow = true;
    part.userData.extracted = true;
    if (sail) part.userData.furled = true;
    pivot.add(part);
  }
}

/** sailcloth: vertical cloths with darker seams, slight weave noise and a reinforced edge */
function clothTexture(): THREE.CanvasTexture {
  const W = 512, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(236,229,212)';
  g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) {
    const n = (Math.random() - 0.5) * 10 + Math.sin((i % W) * 0.9) * 2 + Math.sin(Math.floor(i / W) * 1.3) * 2;
    img.data[i * 4] += n; img.data[i * 4 + 1] += n; img.data[i * 4 + 2] += n * 0.9;
  }
  g.putImageData(img, 0, 0);
  const cloths = 14;
  for (let k = 0; k <= cloths; k++) {
    const x = (k / cloths) * W;
    g.fillStyle = 'rgba(120,105,80,0.28)';
    g.fillRect(x - 1.5, 0, 3, H);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(x + 1.5, 0, 1, H);
  }
  // tabling (doubled edges)
  g.fillStyle = 'rgba(150,135,105,0.3)';
  g.fillRect(0, 0, W, 10); g.fillRect(0, H - 10, W, 10); g.fillRect(0, 0, 8, H); g.fillRect(W - 8, 0, 8, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class Sails {
  readonly group = new THREE.Group();
  private readonly sails: Sail[] = [];
  /** pivots that swing the spars cut out of the model */
  private readonly mainSpars = new THREE.Group();
  private readonly yardSpars = new THREE.Group();
  private readonly furledOnYards: THREE.Object3D[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(modelRoot: THREE.Object3D, boatRoot: THREE.Object3D, clothMap: THREE.Texture | null) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.9, 0.87, 0.8, THREE.SRGBColorSpace),
      roughness: 0.9,
      side: THREE.DoubleSide,
      map: clothMap ?? clothTexture(),
    });
    // a little light through the cloth when backlit
    material.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.18 * max(-dot(normal, directionalLights[0].direction), 0.0) * directionalLights[0].color;`,
      );
    };
    for (const d of DEFS) {
      const s = new Sail(d, material);
      this.sails.push(s);
      this.group.add(s.pivot);
    }

    this.mainSpars.position.set(0, 0, MAST_Z);
    this.yardSpars.position.set(0, 0, SQ_Z);
    this.group.add(this.mainSpars, this.yardSpars);

    // boom + gaff: slim spars aft of the mast
    const onSegment = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number) => {
      const ab = this.tmp.subVectors(b, a);
      const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(p, a).dot(ab) / ab.lengthSq(), 0, 1);
      return p.distanceTo(a.clone().addScaledVector(ab, t)) < r;
    };
    const boomA = v(0, 2.75, MAST_Z - 0.5), boomB = v(0, 3.95, -11.2);
    const gaffA = v(0, 12.4, MAST_Z - 0.45), gaffB = v(0, 16.1, -5.3);
    extractRegion(modelRoot, boatRoot, (a, b, c, sail) =>
      !sail && [a, b, c].every((p) => onSegment(p, boomA, boomB, 0.32) || onSegment(p, gaffA, gaffB, 0.3)), this.mainSpars);
    // yards (+ the sails furled on them): thin horizontal slabs, skipping the mast itself
    extractRegion(modelRoot, boatRoot, (a, b, c, sail) => {
      const pts = [a, b, c];
      const maxX = Math.max(...pts.map((p) => Math.abs(p.x)));
      return YARDS.some((y, i) => pts.every((p) => p.y > y - (sail ? 1.1 : 0.4) && p.y < y + 0.4 && p.z > MAST_Z - 0.5 && p.z < MAST_Z + 1.2 && Math.abs(p.x) < YARD_HALF[i] + 0.3)) && maxX > 0.3;
    }, this.yardSpars);
    this.yardSpars.traverse((o) => { if (o.userData.furled) this.furledOnYards.push(o); });
  }

  /**
   * @param boom signed boom angle (rad, + = to port), from BoatPhysics
   * @param flowBody apparent wind flow direction in the boat frame (unit, where the air goes)
   * @param aws apparent wind speed
   * @param luffing sail flogging
   * @param up 0..1 set/furled
   */
  update(boom: number, flowBody: THREE.Vector3, aws: number, aoa: number, up: number, t: number): void {
    const beta = Math.abs(boom), sgn = Math.sign(boom) || 1;
    const mainYaw = boom; // boom end swings to the side of `boom` sign (see BoatPhysics)
    const yardYaw = sgn * THREE.MathUtils.clamp(Math.PI / 2 - beta, 0, 0.95);
    const headYaw = boom * 0.55;
    this.mainSpars.rotation.y = -mainYaw;
    this.yardSpars.rotation.y = yardYaw;
    const power = THREE.MathUtils.clamp(aws / 7, 0, 1.3);
    const aoaDeg = (aoa * 180) / Math.PI;
    const filled = THREE.MathUtils.smoothstep(aoaDeg, 2, 10);
    const camber = Math.min(1, 0.25 + power) * (0.3 + 0.7 * filled);
    const flog = up > 0.5 ? (1 - filled) * THREE.MathUtils.clamp(aws / 6, 0.2, 1) : 0;
    for (const s of this.sails) {
      const k = s.def.kind;
      s.pivot.rotation.set(0, 0, 0);
      if (k === 'gaff') s.pivot.rotation.y = -mainYaw;
      else if (k === 'square') s.pivot.rotation.y = yardYaw;
      else {
        // headsails swing about their stay (luff) line
        const [a, , , d] = s.def.corners;
        const axis = new THREE.Vector3().subVectors(a, d).normalize();
        s.pivot.quaternion.setFromAxisAngle(axis, -headYaw * Math.sign(axis.y));
      }
      s.pivot.updateMatrixWorld();
      const local = this.tmp.copy(flowBody).applyQuaternion(s.pivot.quaternion.clone().invert());
      s.deform(local, camber, flog, up, t + s.def.corners[0].y);
    }
    for (const f of this.furledOnYards) f.visible = up < 0.6;
  }
}
