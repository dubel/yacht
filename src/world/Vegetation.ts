import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, mulberry32 } from '../core/noise';
import { CLOUD_SHADOW_GLSL, cloudShadowUniforms } from '../environment/Clouds';

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

function palmGeometry(rnd: () => number, low = false): THREE.BufferGeometry {
  const H = 7.5;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.35, H * 0.35, 0),
    new THREE.Vector3(1.1, H * 0.7, 0),
    new THREE.Vector3(1.9, H, 0),
  ]);
  const bark = srgb(0.46, 0.4, 0.32), barkDark = srgb(0.3, 0.26, 0.2);
  const trunk = colored(new THREE.TubeGeometry(curve, low ? 3 : 10, low ? 0.2 : 0.17, low ? 4 : 6, false), (p, c) => {
    c.copy(bark).lerp(barkDark, 0.5 + 0.5 * Math.sin(p.y * 9));
  });
  const top = curve.getPoint(1);
  const parts: THREE.BufferGeometry[] = [trunk];
  const leafA = srgb(0.22, 0.42, 0.12), leafB = srgb(0.45, 0.55, 0.2);
  const fronds = low ? 6 : 10;
  for (let i = 0; i < fronds; i++) {
    const L = 3.4 + rnd() * 1.0, W = low ? 1.0 : 0.8;
    const seg = low ? 2 : 7;
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
  if (!low) for (let i = 0; i < 3; i++) parts.push(nut.clone().translate(top.x + Math.cos(i * 2.1) * 0.25, top.y - 0.3, top.z + Math.sin(i * 2.1) * 0.25));
  for (const p of parts) if (!p.attributes.normal) p.computeVertexNormals();
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

function blobTree(rnd: () => number, trunkH: number, crown: number, dark: THREE.Color, light: THREE.Color, low = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (trunkH > 0) parts.push(colored(new THREE.CylinderGeometry(0.16, 0.26, trunkH, low ? 4 : 6, 1, low).translate(0, trunkH / 2, 0), (_p, c) => c.copy(srgb(0.33, 0.26, 0.18))));
  const blobs = low ? 2 : 5;
  for (let i = 0; i < blobs; i++) {
    // (the low version: two bigger, coarser blobs cover the same crown)
    const r = crown * (0.55 + rnd() * 0.35) * (low ? 1.3 : 1);
    const g = new THREE.IcosahedronGeometry(r, low ? 0 : 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const f = 1 + 0.18 * (fbm(pos.getX(k) * 1.7 + i * 3, pos.getY(k) * 1.7 + pos.getZ(k), 2) - 0.5) * 2;
      pos.setXYZ(k, pos.getX(k) * f, pos.getY(k) * f * 0.85, pos.getZ(k) * f);
    }
    const a = (i / blobs) * Math.PI * 2;
    const off = i === 0 ? 0 : crown * (low ? 0.35 : 0.55);
    g.translate(Math.cos(a) * off, trunkH + crown * (i === 0 ? 0.9 : 0.55 + rnd() * 0.3), Math.sin(a) * off);
    g.computeVertexNormals();
    parts.push(colored(g, (p, c) => c.copy(dark).lerp(light, THREE.MathUtils.clamp((p.y - trunkH) / (crown * 2), 0, 1) * 0.8 + 0.2 * rnd())));
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

/**
 * Plant models and their wind-swayed material. Placement is done per terrain tile in the worker
 * (vegetationPlacement.ts) and the Terrain streamer makes the instanced meshes: full models close by,
 * low-poly ones further out (`geometry(kind, low)`).
 */
export class Vegetation {
  readonly uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1, 0, 0) } };
  readonly material: THREE.MeshStandardMaterial;
  /** [kind][0 = full, 1 = low] */
  private readonly geos: THREE.BufferGeometry[][];

  constructor() {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms, cloudShadowUniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCloudWP;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWP;\n' + CLOUD_SHADOW_GLSL)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= cloudShadow(vCloudWP);');
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
vCloudWP = (modelMatrix * mvPosition).xyz;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,
        );
    };

    this.material = material;
    // the same seeds for both levels, so a far tree and its close-up look alike
    const tree = [srgb(0.1, 0.2, 0.06), srgb(0.28, 0.42, 0.14)] as const, bush = [srgb(0.16, 0.24, 0.08), srgb(0.36, 0.44, 0.16)] as const;
    this.geos = [false, true].map((low) => [
      palmGeometry(mulberry32(42), low),
      blobTree(mulberry32(43), 3.2, 2.4, tree[0], tree[1], low),
      blobTree(mulberry32(44), 0, 1.1, bush[0], bush[1], low),
    ]);
  }

  geometry(kind: number, low: boolean): THREE.BufferGeometry {
    return this.geos[low ? 1 : 0][kind];
  }

  /** triangles per plant, [kind][full, low] (debug) */
  get triangles(): number[][] {
    return [0, 1, 2].map((k) => [0, 1].map((l) => this.geos[l][k].attributes.position.count / 3));
  }

  update(t: number, windX: number, windZ: number, speed: number): void {
    this.uniforms.uTime.value = t;
    this.uniforms.uWind.value.set(windX * speed * 0.15, 0, windZ * speed * 0.15);
  }
}
