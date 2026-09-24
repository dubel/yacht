import * as THREE from 'three';
import { GERSTNER_GLSL } from '../environment/WaveField';
import { passOpening, reefsNear, terrainHeight, type Lagoon } from './WorldGen';

/*
 * Surf on the reefs: the ocean swell breaking on a lagoon's barrier reef, a white line all round it — broken
 * only where a pass cuts through, deep water where nothing breaks. That dark gap in the white is how a
 * sailor finds the way in, so no marks are needed.
 *
 * For each lagoon near the camera, a band of triangles follows the reef crest (from a little inside it to
 * ~30 m out on the ocean side), left out where a pass opens and where the reef carries dry land (a motu).
 * It rides the same Gerstner waves as the sea, and its shader rolls breaking fronts in from the ocean over
 * a churn of foam on the crest. It is drawn after the water surface (the pipeline's late pass), hidden by
 * whatever of the scene stands in front of it (the hull), fogged like the sea.
 */

const BAND_OUT = 30, BAND_IN = 6;
const ROWS = 8;
const STEP = 6; // m of reef per segment

function reefStrip(L: Lagoon): THREE.BufferGeometry | null {
  const segs = Math.ceil((2 * Math.PI * L.radius * Math.max(1, L.ellipse)) / STEP);
  const pos: number[] = [], across: number[] = [], along: number[] = [], keep: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const open = passOpening(L, a);
    for (let r = 0; r < ROWS; r++) {
      const k = r / (ROWS - 1);                    // 0 ocean edge … 1 lagoon edge
      const rd = L.radius + BAND_OUT - k * (BAND_OUT + BAND_IN);
      const x = L.x + Math.cos(a) * rd * L.ellipse, z = L.z + Math.sin(a) * rd;
      pos.push(x, 0, z);
      across.push(k);
      along.push(a * L.radius);
      // no surf in a pass, nor on dry land
      const land = THREE.MathUtils.smoothstep(terrainHeight(x, z), 0.1, 0.6);
      keep.push((1 - THREE.MathUtils.smoothstep(open, 0.15, 0.7)) * (1 - land));
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < segs; i++)
    for (let r = 0; r < ROWS - 1; r++) {
      const v = i * ROWS + r, w = (i + 1) * ROWS + r;
      // skip quads with no surf at all
      if (keep[v] + keep[v + 1] + keep[w] + keep[w + 1] < 0.01) continue;
      idx.push(v, w, v + 1, v + 1, w, w + 1);
    }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aAcross', new THREE.Float32BufferAttribute(across, 1));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setAttribute('aKeep', new THREE.Float32BufferAttribute(keep, 1));
  g.setIndex(idx);
  return g;
}

export class Surf {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly reefs = new Map<string, THREE.Mesh>();
  private last = new THREE.Vector2(Infinity, Infinity);
  readonly uniforms: Record<string, THREE.IUniform>;

  /** `waves`: the water's wave uniforms (uWaveA, uWaveB, uWaveTime), shared so the surf rides the same sea */
  constructor(waves: { uWaveA: THREE.IUniform; uWaveB: THREE.IUniform; uWaveTime: THREE.IUniform }) {
    this.uniforms = {
      ...waves,
      uTime: { value: 0 }, uStrength: { value: 1 },
      uSun: { value: new THREE.Vector3(1, 1, 1) }, uSky: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0.001 },
      uDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 1000 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      // (not tested against the water's depth: the water's own small chop and ripples rise above the smooth
      //  Gerstner surface the surf is laid on and would swallow it; what should hide it — the hull, the land —
      //  is in the scene's depth, tested by hand below)
      depthTest: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
${GERSTNER_GLSL}
uniform float uTime, uStrength;
attribute float aAcross, aAlong, aKeep;
varying float vAcross, vAlong, vKeep, vViewZ, vDist;
void main(){
  vec2 p = position.xz;
  vec3 g = gerstnerDisplace(p);
  vec3 w = vec3(p.x + g.x, g.y + 0.12, p.y + g.z);
  // the swell stands up as it meets the reef: a wall of water along the crest, rising and falling in sets
  float crest = smoothstep(0.1, 0.4, aAcross)*(1.0 - smoothstep(0.55, 0.85, aAcross));
  float sets = 0.55 + 0.45*sin(aAlong*0.045 - uTime*0.7) * sin(aAlong*0.013 + uTime*0.23);
  w.y += crest*sets*(0.45 + 0.3*uStrength)*aKeep;
  vAcross = aAcross; vAlong = aAlong; vKeep = aKeep;
  vec4 mv = viewMatrix*vec4(w, 1.0);
  vViewZ = -mv.z;
  vDist = length(w - cameraPosition);
  gl_Position = projectionMatrix*mv;
}`,
      fragmentShader: /* glsl */ `
uniform float uTime, uStrength, uFogDensity, uNear, uFar;
uniform vec3 uSun, uSky, uFogColor;
uniform sampler2D uDepth;
uniform vec2 uRes;
varying float vAcross, vAlong, vKeep, vViewZ, vDist;
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx)*0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), u.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), u.x), u.y); }
void main(){
  // hidden by the scene in front (the hull), as the water is
  float d = texture(uDepth, gl_FragCoord.xy/uRes).x*2.0 - 1.0;
  float sceneZ = 2.0*uNear*uFar/(uFar + uNear - d*(uFar - uNear));
  if (sceneZ < vViewZ - 0.3) discard;
  float x = vAcross;
  // where the foam is: breaking fronts rolling in from the ocean (bent and broken along the reef), and the
  // white water churning over the crest (the middle of the band)
  float n1 = vn(vec2(vAlong*0.045 + uTime*0.05, x*2.0));
  float front = fract(x*2.2 - uTime*0.12 + n1*0.9);
  float line = smoothstep(0.0, 0.04, front)*(1.0 - smoothstep(0.08, 0.5, front));
  float churn = smoothstep(0.2, 0.45, x)*(1.0 - smoothstep(0.72, 0.95, x));
  float cover = clamp(max(line, churn*0.85)*uStrength, 0.0, 1.0);
  cover *= smoothstep(0.0, 0.1, x)*(1.0 - smoothstep(0.88, 1.0, x));   // soft band edges
  // what it looks like: lace — a fine, drifting texture cut at the coverage, crisp-edged like the wake's foam
  float tex = vn(vec2(vAlong*0.7 - uTime*0.3, x*22.0 + uTime*0.8))*0.55 + vn(vec2(vAlong*2.3 + uTime*0.5, x*64.0 - uTime))*0.3
            + vn(vec2(vAlong*6.0, x*150.0 + uTime*2.0))*0.15;
  float foam = smoothstep(1.0 - cover, 1.0 - cover + 0.14, tex);
  float a = clamp(foam*vKeep, 0.0, 0.95);
  if (a < 0.01) discard;
  vec3 col = uSky*1.9 + uSun*0.38;
  float fog = 1.0 - exp(-uFogDensity*uFogDensity*vDist*vDist);
  gl_FragColor = vec4(mix(col, uFogColor, fog), a*(1.0 - fog*0.6));
}`,
    });
    this.group.name = 'reef surf';
  }

  /**
   * Once per frame: keep strips for the reefs near `focus`, animate. `strength` from the sea state; light and
   * fog like the water's; `depth`/`res`/camera for hiding behind the hull.
   */
  update(dt: number, focus: THREE.Vector3, strength: number, sun: THREE.Vector3, sky: THREE.Vector3, fogColor: THREE.Color, fogDensity: number,
    depth: THREE.Texture, res: THREE.Vector2, camera: THREE.PerspectiveCamera): void {
    if (Math.hypot(focus.x - this.last.x, focus.z - this.last.y) > 200) {
      this.last.set(focus.x, focus.z);
      const keep = new Set<string>();
      for (const L of reefsNear(focus.x, focus.z, 3500)) {
        const key = `${L.x.toFixed(0)},${L.z.toFixed(0)}`;
        keep.add(key);
        if (this.reefs.has(key)) continue;
        const g = reefStrip(L);
        if (!g) continue;
        const m = new THREE.Mesh(g, this.material);
        m.frustumCulled = false; // (displaced on the GPU; a reef ring is one draw)
        this.reefs.set(key, m);
        this.group.add(m);
      }
      for (const [k, m] of this.reefs) if (!keep.has(k)) { this.group.remove(m); m.geometry.dispose(); this.reefs.delete(k); }
    }
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uStrength.value = strength;
    u.uSun.value.copy(sun);
    u.uSky.value.copy(sky);
    u.uFogColor.value.copy(fogColor);
    u.uFogDensity.value = fogDensity;
    u.uDepth.value = depth;
    u.uRes.value.copy(res);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
  }
}
