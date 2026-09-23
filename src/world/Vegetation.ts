import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, mulberry32, smoothstep } from '../core/noise';

/*
 * Procedural island vegetation (SKETCH §18, first pass): palms along the beaches, rounded jungle trees
 * inland, scrub in between. Each kind is one InstancedMesh (one draw call). Everything sways with the
 * shared Wind — the vertex shader bends instances in world space by height².
 */

function colored(g: THREE.BufferGeometry, fn: (p: THREE.Vector3, c: THREE.Color) => void): THREE.BufferGeometry {
  g = g.index ? g.toNonIndexed() : g;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    fn(p, c);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

function palmGeometry(rnd: () => number): THREE.BufferGeometry {
  const H = 7.5;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.35, H * 0.35, 0),
    new THREE.Vector3(1.1, H * 0.7, 0),
    new THREE.Vector3(1.9, H, 0),
  ]);
  const bark = srgb(0.46, 0.4, 0.32), barkDark = srgb(0.3, 0.26, 0.2);
  const trunk = colored(new THREE.TubeGeometry(curve, 10, 0.17, 6, false), (p, c) => {
    c.copy(bark).lerp(barkDark, 0.5 + 0.5 * Math.sin(p.y * 9));
  });
  const top = curve.getPoint(1);
  const parts: THREE.BufferGeometry[] = [trunk];
  const leafA = srgb(0.22, 0.42, 0.12), leafB = srgb(0.45, 0.55, 0.2);
  const fronds = 10;
  for (let i = 0; i < fronds; i++) {
    const L = 3.4 + rnd() * 1.0, W = 0.8;
    const seg = 7;
    const verts: number[] = [];
    const cols: number[] = [];
    const ang = (i / fronds) * Math.PI * 2 + rnd() * 0.4;
    const droop = 0.5 + rnd() * 0.5;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const pt = (s: number, side: number) => {
      const r = s * L;
      const y = r * 0.45 - droop * r * r * 0.28; // rises then droops
      const w = W * Math.sin(Math.PI * Math.min(1, s * 1.15)) * side;
      const fold = Math.abs(side) * 0.18 * Math.sin(Math.PI * s); // V-fold along the rib
      const x = r, z = w;
      return [top.x + x * ca - z * sa, top.y + y - fold, top.z + x * sa + z * ca];
    };
    for (let k = 0; k < seg; k++) {
      const s0 = k / seg, s1 = (k + 1) / seg;
      const a = pt(s0, 0), b = pt(s1, 0), cL = pt(s0, 1), dL = pt(s1, 1), cR = pt(s0, -1), dR = pt(s1, -1);
      verts.push(...a, ...cL, ...b, ...b, ...cL, ...dL, ...a, ...b, ...cR, ...b, ...dR, ...cR);
      const col = leafA.clone().lerp(leafB, s0 * 0.8);
      for (let q = 0; q < 12; q++) cols.push(col.r, col.g, col.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  // coconuts
  const nut = colored(new THREE.IcosahedronGeometry(0.22, 0), (_p, c) => c.copy(srgb(0.33, 0.3, 0.15)));
  for (let i = 0; i < 3; i++) parts.push(nut.clone().translate(top.x + Math.cos(i * 2.1) * 0.25, top.y - 0.3, top.z + Math.sin(i * 2.1) * 0.25));
  for (const p of parts) if (!p.attributes.normal) p.computeVertexNormals();
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

function blobTree(rnd: () => number, trunkH: number, crown: number, dark: THREE.Color, light: THREE.Color): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (trunkH > 0) parts.push(colored(new THREE.CylinderGeometry(0.16, 0.26, trunkH, 6).translate(0, trunkH / 2, 0), (_p, c) => c.copy(srgb(0.33, 0.26, 0.18))));
  const blobs = 5;
  for (let i = 0; i < blobs; i++) {
    const r = crown * (0.55 + rnd() * 0.35);
    const g = new THREE.IcosahedronGeometry(r, 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const f = 1 + 0.18 * (fbm(pos.getX(k) * 1.7 + i * 3, pos.getY(k) * 1.7 + pos.getZ(k), 2) - 0.5) * 2;
      pos.setXYZ(k, pos.getX(k) * f, pos.getY(k) * f * 0.85, pos.getZ(k) * f);
    }
    const a = (i / blobs) * Math.PI * 2;
    const off = i === 0 ? 0 : crown * 0.55;
    g.translate(Math.cos(a) * off, trunkH + crown * (i === 0 ? 0.9 : 0.55 + rnd() * 0.3), Math.sin(a) * off);
    g.computeVertexNormals();
    parts.push(colored(g, (p, c) => c.copy(dark).lerp(light, THREE.MathUtils.clamp((p.y - trunkH) / (crown * 2), 0, 1) * 0.8 + 0.2 * rnd())));
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

export class Vegetation {
  readonly group = new THREE.Group();
  readonly uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1, 0, 0) } };

  constructor(heightAt: (x: number, z: number) => number, extent: number) {
    const rnd = mulberry32(42);
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uWind; // xz = direction × strength')
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float hgt = max(mvPosition.y - base.y, 0.0);
  float ph = dot(base.xz, vec2(0.13, 0.071));
  float gust = 0.65 + 0.35*sin(uTime*0.7 + ph*0.3);
  float sway = sin(uTime*1.6 + ph) * 0.35 + sin(uTime*3.7 + ph*2.3) * 0.12;
  mvPosition.xz += uWind.xz * (gust + sway) * hgt*hgt * 0.0035;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,
        );
    };

    const kinds = [
      { geo: palmGeometry(rnd), place: (h: number, ny: number, n: number) => h > 1.4 && h < 7 && ny > 0.8 && n > 0.35 ? 0.55 : 0, scale: [0.75, 1.25] },
      { geo: blobTree(rnd, 3.2, 2.4, srgb(0.1, 0.2, 0.06), srgb(0.28, 0.42, 0.14)), place: (h: number, ny: number, n: number) => h > 3.5 && ny > 0.62 ? smoothstep(0.35, 0.6, n) * 0.85 : 0, scale: [0.8, 1.5] },
      { geo: blobTree(rnd, 0, 1.1, srgb(0.16, 0.24, 0.08), srgb(0.36, 0.44, 0.16)), place: (h: number, ny: number, n: number) => h > 1.9 && ny > 0.6 ? 0.25 + 0.3 * n : 0, scale: [0.6, 1.3] },
    ];
    const step = 4.2;
    const buckets: THREE.Matrix4[][] = kinds.map(() => []);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let x = -extent; x < extent; x += step)
      for (let z = -extent; z < extent; z += step) {
        const px = x + (rnd() - 0.5) * step, pz = z + (rnd() - 0.5) * step;
        const h = heightAt(px, pz);
        if (h < 1.3) continue;
        const e = 0.8;
        const nx = heightAt(px - e, pz) - heightAt(px + e, pz), nz = heightAt(px, pz - e) - heightAt(px, pz + e);
        const ny = (2 * e) / Math.hypot(nx, 2 * e, nz);
        const n = fbm(px / 30, pz / 30, 3);
        const r = rnd();
        let acc = 0;
        for (let k = 0; k < kinds.length; k++) {
          acc += kinds[k].place(h, ny, n);
          if (r < acc * 0.6) {
            const [s0, s1] = kinds[k].scale;
            const sc = s0 + (s1 - s0) * rnd();
            q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.12, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.12));
            s.setScalar(sc);
            p.set(px, h - 0.15, pz);
            buckets[k].push(m.compose(p, q, s).clone());
            break;
          }
        }
      }
    kinds.forEach((k, i) => {
      const list = buckets[i];
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(k.geo, material, list.length);
      list.forEach((mm, j) => mesh.setMatrixAt(j, mm));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    });
    this.group.name = 'vegetation';
  }

  get count(): number {
    return this.group.children.reduce((a, c) => a + (c as THREE.InstancedMesh).count, 0);
  }

  update(t: number, windX: number, windZ: number, speed: number): void {
    this.uniforms.uTime.value = t;
    this.uniforms.uWind.value.set(windX * speed * 0.15, 0, windZ * speed * 0.15);
  }
}
