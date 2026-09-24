import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Boat } from '../boat/Boat';

/*
 * The boat's guns, taken out of the model. The swivel guns on the rails (material "SwivelGun") come as one
 * merged mesh; here its triangles are split by side and position along the hull into single pieces, each
 * rebuilt as its own mesh (same material and textures) pivoting on its swivel — the yoke on the rail — so a
 * manned gun can train left and right and elevate after the sight. The original merged mesh is hidden.
 *
 * For each gun: muzzle and breech, barrel direction, the spot a gunner stands at — all in the boat's frame
 * (+Z bow, +Y up, +X port) and at rest — and a red outline shell (its own triangles pushed out along the
 * normals) that pulses when the sailor walks up to it.
 */

export interface Gun {
  side: 'port' | 'starboard';
  /** muzzle and breech at rest, boat frame */
  muzzle: THREE.Vector3;
  breech: THREE.Vector3;
  /** barrel direction at rest (outward, horizontal), boat frame */
  dir: THREE.Vector3;
  /** where the gunner stands (deck, boat frame x/z) */
  stand: THREE.Vector2;
  /** the piece itself, pivoting on its swivel (a child of the boat) */
  mesh: THREE.Mesh;
  outline: THREE.Mesh;
  /** current training and elevation (rad), see aim() */
  yaw: number;
  pitch: number;
}

/** where along the barrel (breech 0 … muzzle 1) the swivel pin sits: at the rail */
const PIVOT = 0.62;

export class Guns {
  readonly list: Gun[] = [];
  private readonly outlineMat: THREE.ShaderMaterial;

  constructor(boat: Boat) {
    this.outlineMat = new THREE.ShaderMaterial({
      uniforms: { uPulse: { value: 0 } },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uPulse;
        void main(){
          vec3 p = position + normal*(0.018 + 0.012*uPulse);
          gl_Position = projectionMatrix*modelViewMatrix*vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uPulse;
        void main(){ gl_FragColor = vec4(vec3(1.0, 0.08, 0.04)*(2.0 + 3.0*uPulse), 0.55 + 0.45*uPulse); }`,
    });

    // all gun triangles in the boat frame, every attribute kept (the model is still at the origin here)
    boat.root.updateMatrixWorld(true);
    const toBoat = boat.root.matrixWorld.clone().invert();
    const parts: { geo: THREE.BufferGeometry; material: THREE.Material }[] = [];
    boat.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material) || !/SwivelGun/.test(m.material.name)) return;
      // (the model is meshopt-compressed: positions are normalised 16-bit ints in interleaved buffers, which
      //  would clamp anything transformed into them — go to plain floats first)
      const flat = toFloat(m.geometry);
      const g = (flat.index ? flat.toNonIndexed() : flat).applyMatrix4(toBoat.clone().multiply(m.matrixWorld));
      parts.push({ geo: g, material: m.material });
      m.visible = false; // replaced by the pieces below
    });
    if (!parts.length) return;
    const material = parts[0].material;
    const src = parts.length === 1 ? parts[0].geo : mergeAll(parts.map((p) => p.geo));
    const pos = src.attributes.position as THREE.BufferAttribute;

    // triangle → piece: side (sign of x) × station along the hull (z, 0.6 m bins)
    const tri = pos.count / 3;
    const keyOf = new Array<string>(tri);
    const count = new Map<string, number>();
    for (let t = 0; t < tri; t++) {
      const cx = (pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2)) / 3, cz = (pos.getZ(t * 3) + pos.getZ(t * 3 + 1) + pos.getZ(t * 3 + 2)) / 3;
      keyOf[t] = `${cx > 0 ? 'p' : 's'}${Math.round(cz / 0.6)}`;
      count.set(keyOf[t], (count.get(keyOf[t]) ?? 0) + 1);
    }
    const pieces = [...count].filter(([, n]) => n >= 40).map(([k]) => k);
    // stray bits go to the nearest real piece on the same side, so nothing disappears with the hidden mesh
    for (let t = 0; t < tri; t++) {
      if (pieces.includes(keyOf[t])) continue;
      const side = keyOf[t][0], st = Number(keyOf[t].slice(1));
      const near = pieces.filter((k) => k[0] === side).sort((a, b) => Math.abs(Number(a.slice(1)) - st) - Math.abs(Number(b.slice(1)) - st))[0];
      if (near) keyOf[t] = near;
    }

    for (const key of pieces) {
      const tris: number[] = [];
      for (let t = 0; t < tri; t++) if (keyOf[t] === key) tris.push(t);
      const geo = pick(src, tris);
      const side = key[0] === 'p' ? 'port' : 'starboard';
      const s = side === 'port' ? 1 : -1;
      // barrel extent along x (outward), mean height and station
      const gp = geo.attributes.position as THREE.BufferAttribute;
      let xmin = Infinity, xmax = -Infinity, y = 0, z = 0;
      for (let i = 0; i < gp.count; i++) { const x = gp.getX(i) * s; xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); y += gp.getY(i); z += gp.getZ(i); }
      y /= gp.count; z /= gp.count;
      const pivot = new THREE.Vector3((xmin + (xmax - xmin) * PIVOT) * s, y, z);
      geo.translate(-pivot.x, -pivot.y, -pivot.z);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.copy(pivot);
      mesh.rotation.order = 'YZX';
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = `gun ${side} ${z.toFixed(1)}`;
      boat.root.add(mesh);
      // outline: smooth normals (shared vertices) so the pushed-out shell has no cracks
      const og = mergeVertices(new THREE.BufferGeometry().setAttribute('position', geo.attributes.position.clone()), 1e-4);
      og.computeVertexNormals();
      const outline = new THREE.Mesh(og, this.outlineMat);
      outline.visible = false;
      outline.renderOrder = 5;
      mesh.add(outline);
      this.list.push({
        side, mesh, outline, yaw: 0, pitch: 0,
        muzzle: new THREE.Vector3(xmax * s, y, z),
        breech: new THREE.Vector3(xmin * s, y, z),
        dir: new THREE.Vector3(s, 0, 0),
        stand: new THREE.Vector2((xmin - 0.55) * s, z),
      });
    }
    // bow to stern within each side (a broadside fires in order)
    this.list.sort((a, b) => (a.side === b.side ? b.muzzle.z - a.muzzle.z : a.side === 'port' ? -1 : 1));
  }

  /**
   * Train gun `i`: `yaw` turns the barrel about the vertical (in the same sense as the sight's yaw, so the
   * piece follows the cross), `pitch` raises the muzzle. `ease` < 1 glides toward it (a gun let go of
   * swings back to rest).
   */
  aim(i: number, yaw: number, pitch: number, ease = 1): void {
    const g = this.list[i];
    g.yaw += (yaw - g.yaw) * ease;
    g.pitch += (pitch - g.pitch) * ease;
    // elevation turns about the axis across the barrel (z): up for a port gun is +z rotation, for starboard −z
    g.mesh.rotation.set(0, g.yaw, (g.side === 'port' ? 1 : -1) * g.pitch);
  }

  /** muzzle of gun `i` as it is trained now, world space */
  muzzleWorld(i: number): THREE.Vector3 {
    const g = this.list[i];
    g.mesh.updateWorldMatrix(true, false);
    // the piece's own frame is the boat frame shifted to the pivot (then turned by the training)
    return g.mesh.localToWorld(g.muzzle.clone().sub(g.mesh.position));
  }

  /** the gun (if any) a sailor standing at deck point (x, z) is close enough to man */
  near(x: number, z: number, reach = 1.1): number {
    let best = -1, bd = reach;
    this.list.forEach((g, i) => { const d = Math.hypot(g.stand.x - x, g.stand.y - z); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  /** show the pulsing outline on gun `i` (−1: none) */
  highlight(i: number, t: number): void {
    this.outlineMat.uniforms.uPulse.value = 0.5 + 0.5 * Math.sin(t * 6);
    this.list.forEach((g, k) => (g.outline.visible = k === i));
  }

  /** guns nobody is manning swing back to rest */
  relax(dt: number, manned: number): void {
    const k = 1 - Math.exp(-dt * 3);
    this.list.forEach((g, i) => { if (i !== manned && (g.yaw !== 0 || g.pitch !== 0)) this.aim(i, 0, 0, k); });
  }
}

/** the same geometry with every attribute as plain, non-interleaved, non-normalised floats */
function toFloat(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    const a = attr as THREE.BufferAttribute, n = a.itemSize;
    const arr = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) arr[i * n + c] = a.getComponent(i, c);
    out.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  if (src.index) out.setIndex(src.index.clone());
  return out;
}

/** a new geometry with triangles `tris` (indices into a non-indexed geometry), every attribute copied */
function pick(src: THREE.BufferGeometry, tris: number[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    const a = attr as THREE.BufferAttribute, n = a.itemSize;
    const arr = new Float32Array(tris.length * 3 * n);
    tris.forEach((t, k) => { for (let v = 0; v < 3; v++) for (let c = 0; c < n; c++) arr[(k * 3 + v) * n + c] = a.getComponent(t * 3 + v, c); });
    out.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  return out;
}

/** concatenate non-indexed geometries that share the same attributes */
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geos[0].attributes)) {
    if (!geos.every((g) => g.attributes[name])) continue;
    const n = (geos[0].attributes[name] as THREE.BufferAttribute).itemSize;
    const total = geos.reduce((s, g) => s + g.attributes[name].count, 0);
    const arr = new Float32Array(total * n);
    let o = 0;
    for (const g of geos) { const a = g.attributes[name] as THREE.BufferAttribute; for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) arr[o++] = a.getComponent(i, c); }
    out.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  return out;
}
