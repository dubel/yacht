import * as THREE from 'three';
import { fbm, smoothstep, vnoise } from '../core/noise';
import { patchUnderwater } from '../render/water/underwaterLight';

/**
 * Lagoon heightfield: islands, beaches, coral heads, a barrier reef and the ocean drop-off outside it.
 * Analytic (deterministic) so physics can query `heightAt` without reading back GPU data.
 * Heights are metres relative to mean water level (y = 0).
 */
interface Island {
  x: number;
  z: number;
  radius: number;
  peak: number;
  /** 0 = soft jungle hill, 1 = craggy rock */
  rock: number;
  /** elongation along a direction (sandbars) */
  stretch?: [number, number, number];
  /** height of the shoreline shelf above water (m) */
  shore?: number;
}

const ISLANDS: Island[] = [
  { x: -175, z: -130, radius: 95, peak: 38, rock: 0.35 },
  { x: 195, z: -45, radius: 55, peak: 16, rock: 0.15 },
  { x: 40, z: -240, radius: 17, peak: 9, rock: 1 },
  { x: 95, z: 120, radius: 26, peak: 0.25, rock: 0, stretch: [0.8, 0.6, 2.4], shore: 0.35 },
  { x: -70, z: 235, radius: 40, peak: 13, rock: 0.25 },
  { x: -250, z: 120, radius: 12, peak: 6, rock: 0.9 },
];

const REEF_RADIUS = 430;
const LAGOON_FLOOR = -4.6;

const smax = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

function islandHeight(isl: Island, x: number, z: number): number {
  let dx = x - isl.x, dz = z - isl.z;
  if (isl.stretch) {
    const [cx, cz, s] = isl.stretch;
    const a = dx * cx + dz * cz, b = -dx * cz + dz * cx;
    dx = a / s;
    dz = b;
  }
  // wobbly coastline
  const wob = 1 + 0.42 * (fbm(x / 55 + isl.x, z / 55 + isl.z, 3) - 0.5);
  const d = Math.hypot(dx, dz) / wob;
  const R = isl.radius;
  const shore = isl.shore ?? 1.1;
  if (d < R) {
    const r = d / R;
    const dome = Math.pow(1 - r * r, 1.4);
    const bumps = fbm(x / 22, z / 22, 4) - 0.5;
    const crag = isl.rock * Math.abs(fbm(x / 9, z / 9, 3) - 0.5) * 2;
    return shore + isl.peak * dome * (0.8 + 0.5 * bumps + 0.35 * crag);
  }
  // underwater shoulder: gentle beach shelf, then steeper
  const o = d - R;
  return shore - o * 0.1 - Math.max(0, o - 14) * 0.22 * (1 + isl.rock);
}

export function terrainHeight(x: number, z: number): number {
  // lagoon floor: broad undulation + sand waves + scattered coral heads
  let h = LAGOON_FLOOR + 1.4 * (fbm(x / 140, z / 140, 3) - 0.5) + 0.35 * (vnoise(x / 18, z / 18) - 0.5);
  const coral = smoothstep(0.72, 0.9, fbm(x / 26 + 40, z / 26 - 13, 3));
  h += coral * 3.1;

  // keep the start area and a channel to the east open and navigable
  const startClear = smoothstep(80, 25, Math.hypot(x, z));
  h = h - startClear * Math.max(0, h + 3.2);

  for (const isl of ISLANDS) h = smax(h, islandHeight(isl, x, z), 4);

  // barrier reef ring (slightly elliptical), with a pass to the south-east
  const rd = Math.hypot(x / 1.08, z * 1.0);
  const ang = Math.atan2(z, x);
  const pass = smoothstep(0.22, 0.08, Math.abs(ang - 0.62));
  const crest = -0.35 + 0.8 * (fbm(x / 30, z / 30, 3) - 0.5) - pass * 5.5;
  const reef = crest - Math.pow(Math.abs(rd - REEF_RADIUS) / 22, 2) * 3.2;
  h = smax(h, reef, 3);
  // ocean outside the reef
  const outside = smoothstep(REEF_RADIUS + 10, REEF_RADIUS + 70, rd);
  h = h * (1 - outside) + Math.min(h, -26 + 6 * fbm(x / 80, z / 80, 2)) * outside;
  return h;
}

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly pebbles: THREE.IUniform<THREE.Texture>;

  constructor(size: number, segments: number, pebbles: THREE.Texture) {
    this.pebbles = { value: pebbles };
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), h = pos.getY(i);
      this.colorAt(x, z, h, nrm.getY(i), c);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    this.material.onBeforeCompile = (sh) => this.patchShader(sh);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
  }

  heightAt(x: number, z: number): number {
    return terrainHeight(x, z);
  }

  private colorAt(x: number, z: number, h: number, ny: number, out: THREE.Color): void {
    const n1 = fbm(x / 12, z / 12, 3), n2 = vnoise(x / 3, z / 3);
    const sand = new THREE.Color().setRGB(0.86, 0.77, 0.58, THREE.SRGBColorSpace);
    const wetSand = new THREE.Color().setRGB(0.74, 0.65, 0.48, THREE.SRGBColorSpace);
    const seabed = new THREE.Color().setRGB(0.8, 0.75, 0.6, THREE.SRGBColorSpace);
    const weed = new THREE.Color().setRGB(0.3, 0.36, 0.2, THREE.SRGBColorSpace);
    const coral = new THREE.Color().setRGB(0.62, 0.52, 0.47, THREE.SRGBColorSpace);
    const grass = new THREE.Color().setRGB(0.24, 0.36, 0.12, THREE.SRGBColorSpace);
    const jungle = new THREE.Color().setRGB(0.12, 0.22, 0.07, THREE.SRGBColorSpace);
    const rock = new THREE.Color().setRGB(0.46, 0.43, 0.39, THREE.SRGBColorSpace);

    if (h < -0.4) {
      out.copy(seabed).multiplyScalar(0.85 + 0.3 * n2);
      const w = smoothstep(0.55, 0.75, fbm(x / 35 + 7, z / 35 - 3, 3)) * smoothstep(-1.5, -3.5, h);
      out.lerp(weed, w * 0.85);
      const cor = smoothstep(0.72, 0.9, fbm(x / 26 + 40, z / 26 - 13, 3));
      out.lerp(coral.clone().offsetHSL(0.08 * (n1 - 0.5), 0.1 * n2, 0), cor * 0.9);
      if (h < -8) out.lerp(new THREE.Color().setRGB(0.5, 0.52, 0.5, THREE.SRGBColorSpace), smoothstep(-8, -18, h));
    } else if (h < 1.7) {
      out.copy(wetSand).lerp(sand, smoothstep(0.1, 0.9, h)).multiplyScalar(0.92 + 0.16 * n2);
    } else {
      out.copy(grass).lerp(jungle, smoothstep(0.35, 0.7, n1)).multiplyScalar(0.8 + 0.4 * n2);
      out.lerp(sand, smoothstep(2.4, 1.7, h));
    }
    const steep = smoothstep(0.82, 0.6, ny) * smoothstep(-0.2, 0.8, h);
    out.lerp(rock.clone().multiplyScalar(0.8 + 0.4 * n1), steep);
  }

  private patchShader(sh: THREE.WebGLProgramParametersWithUniforms): void {
    sh.uniforms.uPeb = this.pebbles;
    patchUnderwater(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uPeb;
float tHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float tNoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(tHash(i),tHash(i+vec2(1,0)),u.x), mix(tHash(i+vec2(0,1)),tHash(i+vec2(1,1)),u.x), u.y); }
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  // seabed detail: Clearwater's pebble texture in patches, rippled sand elsewhere (texture-bombed to hide tiling)
  float under = smoothstep(0.6, -0.2, vWPos.y);
  vec2 xz = vWPos.xz;
  float k = tNoise(xz*0.21);
  float l = k*8.0; float ia = floor(l), fa = fract(l);
  vec2 oa = sin(vec2(3.0,7.0)*ia), ob = sin(vec2(3.0,7.0)*(ia+1.0));
  vec2 puv = xz/1.3;
  vec3 pa = texture(uPeb, puv+oa).rgb, pb = texture(uPeb, puv+ob).rgb;
  vec3 peb = mix(pa, pb, smoothstep(0.2, 0.8, fa));
  float pebZone = smoothstep(0.45, 0.7, tNoise(xz*0.05 + 3.0)) * under;
  // wave-formed ripple marks only below the water line; dry sand gets grain + wind-blown patches
  float marks = (0.5 + 0.5*sin(dot(xz, vec2(0.93, 0.37))*5.0 + 3.0*tNoise(xz*0.3))) * smoothstep(0.0, -0.4, vWPos.y);
  float grain = tNoise(xz*9.0)*0.6 + tNoise(xz*31.0)*0.4;
  float patches = tNoise(xz*0.35)*0.6 + tNoise(xz*1.7)*0.4;
  vec3 sandDetail = vec3(0.88 + 0.12*marks + 0.12*grain) * mix(vec3(0.92, 0.9, 0.86), vec3(1.05, 1.02, 0.97), patches);
  vec3 pebDetail = peb*2.4;
  diffuseColor.rgb *= mix(vec3(1.0), mix(sandDetail, pebDetail, pebZone), smoothstep(1.8, 0.0, vWPos.y));
  // land: break up the vertex colours (grass, scrub, bare earth)
  float land = smoothstep(1.6, 2.4, vWPos.y);
  float ln = tNoise(xz*0.9)*0.5 + tNoise(xz*3.3)*0.3 + tNoise(xz*11.0)*0.2;
  vec3 earth = vec3(0.32, 0.26, 0.17);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb*(0.7 + 0.6*ln), earth, smoothstep(0.62, 0.8, ln)*0.6), land);
  // wet band on beaches
  float wet = smoothstep(0.7, 0.05, vWPos.y) * smoothstep(-0.3, 0.05, vWPos.y);
  diffuseColor.rgb *= 1.0 - 0.18*wet;
}`,
      );
  }
}
