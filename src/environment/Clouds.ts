import * as THREE from 'three';
import { Blitter, makeRT, passMaterial } from '../render/gpu';

/*
 * Volumetric clouds.
 *
 * A layer of clouds on a curved earth is ray-marched from the camera into a *direction map* of the upper
 * hemisphere (stereographic projection: more resolution toward the horizon). Because it is indexed by
 * direction, the same clouds are seen by the main camera, the water reflection, the IBL bake and the fog
 * probe — the sky shader just looks them up. The map is refreshed in bands (clouds move
 * slowly — a sixth per frame), with a per-frame jitter that the bilinear lookup blends away.
 *
 * Density: tileable Perlin-Worley shape noise eroded by Worley detail noise, shaped by a height profile
 * that goes from flat-bottomed fair-weather cumulus to towering storm cells (after Schneider & Vos,
 * "The real-time volumetric cloudscapes of Horizon: Zero Dawn", 2015). Lighting: sun/moon light marched
 * through the cloud (Beer + multiple-scattering term + powder), dual-lobe Henyey–Greenstein phase,
 * ambient from the sky, energy-conserving integration (Hillaire 2016).
 *
 * A second small pass marches the light direction from the ground up through the layer and stores the
 * transmittance: the cloud shadow map used by every lit surface and the water.
 */

// ---------------------------------------------------------------- tileable noise (CPU, once)

function makeRandom(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** feature points of a tileable Worley grid with `cells`³ cells */
function worleyPoints(cells: number, seed: number): Float32Array {
  const r = makeRandom(seed);
  const p = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < p.length; i++) p[i] = r();
  return p;
}

/** 1 − distance to the nearest feature point (in cell units), tileable over [0,1)³ */
function worley(x: number, y: number, z: number, cells: number, pts: Float32Array): number {
  const fx = x * cells, fy = y * cells, fz = z * cells;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells, wz = ((cz % cells) + cells) % cells;
        const o = ((wz * cells + wy) * cells + wx) * 3;
        const px = cx + pts[o] - fx, py = cy + pts[o + 1] - fy, pz = cz + pts[o + 2] - fz;
        const d = px * px + py * py + pz * pz;
        if (d < best) best = d;
      }
  return 1 - Math.min(1, Math.sqrt(best));
}

/** tileable gradient noise in [-1,1] with integer period */
function perlin(x: number, y: number, z: number, period: number, grad: Float32Array): number {
  const fx = x * period, fy = y * period, fz = z * period;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(tx), v = fade(ty), w = fade(tz);
  const g = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) => {
    const wx = ((cx % period) + period) % period, wy = ((cy % period) + period) % period, wz = ((cz % period) + period) % period;
    const o = ((wz * 64 + wy) * 64 + wx) * 3;
    return grad[o] * dx + grad[o + 1] * dy + grad[o + 2] * dz;
  };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(g(ix, iy, iz, tx, ty, tz), g(ix + 1, iy, iz, tx - 1, ty, tz), u), l(g(ix, iy + 1, iz, tx, ty - 1, tz), g(ix + 1, iy + 1, iz, tx - 1, ty - 1, tz), u), v),
    l(l(g(ix, iy, iz + 1, tx, ty, tz - 1), g(ix + 1, iy, iz + 1, tx - 1, ty, tz - 1), u), l(g(ix, iy + 1, iz + 1, tx, ty - 1, tz - 1), g(ix + 1, iy + 1, iz + 1, tx - 1, ty - 1, tz - 1), u), v),
    w,
  );
}

function makeTexture3D(size: number, fill: (x: number, y: number, z: number, out: number[]) => void): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  const out = [0, 0, 0, 0];
  let o = 0;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        fill((x + 0.5) / size, (y + 0.5) / size, (z + 0.5) / size, out);
        for (let c = 0; c < 4; c++) data[o++] = Math.max(0, Math.min(255, Math.round(out[c] * 255)));
      }
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** R: Perlin-Worley (billowy shape), G/B/A: Worley at 4/8/16 cells */
function shapeNoise(size = 64): THREE.Data3DTexture {
  const r = makeRandom(11);
  const grad = new Float32Array(64 * 64 * 64 * 3);
  for (let i = 0; i < 64 * 64 * 64; i++) {
    const t = r() * Math.PI * 2, u = r() * 2 - 1, s = Math.sqrt(1 - u * u);
    grad[i * 3] = s * Math.cos(t); grad[i * 3 + 1] = s * Math.sin(t); grad[i * 3 + 2] = u;
  }
  const w4 = worleyPoints(4, 21), w8 = worleyPoints(8, 22), w16 = worleyPoints(16, 23);
  return makeTexture3D(size, (x, y, z, out) => {
    const a = worley(x, y, z, 4, w4), b = worley(x, y, z, 8, w8), c = worley(x, y, z, 16, w16);
    const wf = a * 0.625 + b * 0.25 + c * 0.125;
    const p = perlin(x, y, z, 4, grad) * 0.6 + perlin(x, y, z, 8, grad) * 0.3 + perlin(x, y, z, 16, grad) * 0.1;
    const pn = THREE.MathUtils.clamp(p * 0.7 + 0.5, 0, 1);
    // Perlin-Worley: remap perlin by the worley fbm → round, billowy blobs
    const pw = THREE.MathUtils.clamp((pn - (wf - 1)) / (1 - (wf - 1)) - 0.0, 0, 1);
    out[0] = pw; out[1] = a; out[2] = b; out[3] = c;
  });
}

/** RGB: Worley at 4/8/16 cells (erodes the edges into wisps) */
function detailNoise(size = 32): THREE.Data3DTexture {
  const w4 = worleyPoints(4, 31), w8 = worleyPoints(8, 32), w16 = worleyPoints(16, 33);
  return makeTexture3D(size, (x, y, z, out) => {
    out[0] = worley(x, y, z, 4, w4); out[1] = worley(x, y, z, 8, w8); out[2] = worley(x, y, z, 16, w16); out[3] = 1;
  });
}

// ---------------------------------------------------------------- GLSL shared by both passes

const CLOUD_GLSL = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uShape, uDetail;
uniform vec3 uCam;
uniform vec2 uWindOffset;
uniform float uTime, uCoverage, uDensity, uBase, uTop, uType;
uniform vec3 uLightDir, uLightColor, uAmbient, uFlashDir;
uniform float uFlash;
const float EARTH_R = 6371000.0;

float remap(float v, float l0, float h0, float l1, float h1){ return l1 + (v - l0)*(h1 - l1)/(h0 - l0); }

// Distance along a ray (starting at altitude h0, direction with vertical component mu) to the spherical
// shell at altitude H > h0. Written without subtracting huge numbers: the naive ray–sphere test with
// the Earth's radius loses all float32 precision.
float shellT(float h0, float mu, float H){
  float a = (EARTH_R + h0)*mu;
  float k = (H - h0)*(2.0*EARTH_R + H + h0);
  float s = sqrt(a*a + k);
  return a >= 0.0 ? k/(a + s) : s - a;
}

// altitude above the curved sea surface, relative to the camera's ground point (exact to <1 m within 100 km)
float heightFrac(vec3 p){
  vec2 d = p.xz - uCam.xz;
  float alt = p.y + dot(d, d)/(2.0*EARTH_R);
  return (alt - uBase) / (uTop - uBase);
}

// height profile: flat bottoms, rounded tops; storm cells (type 1) keep their bulk up high
float heightProfile(float h){
  float bottom = smoothstep(0.0, mix(0.07, 0.12, uType), h);
  float top = smoothstep(1.0, mix(0.45, 0.85, uType), h);
  return bottom*top;
}

// detail-erosion strength; the map pass lowers it with distance so far clouds don't alias into speckle
float gDetail = 1.0;

// Large-scale domain warp of the shape noise. The noise tiles every 4.2 km, and a long ray running along a
// lattice direction (the ±x/±z axes, the diagonals) would sample the same line of it over and over: all
// cloud or all gap, i.e. radial streaks toward those points of the horizon. A slowly drifting offset of a
// few km breaks that. It varies over ~60 km, so it is set once per march step (gWarp) and reused by the
// short light march.
vec2 gWarp = vec2(0.0);
vec2 cloudWarp(vec3 p){
  vec2 q = (p.xz + uWindOffset)/64000.0;
  return (vec2(texture(uShape, vec3(q, 0.63)).g, texture(uShape, vec3(q.yx + 0.37, 0.17)).g) - 0.5)*5000.0;
}

float cloudDensity(vec3 p, float h, bool detail){
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec3 q = p + vec3(uWindOffset.x, 0.0, uWindOffset.y);
  // large-scale coverage variation: clumps and clear gaps drifting with the wind
  float covMap = texture(uShape, vec3(q.x/42000.0, 0.31, q.z/42000.0)).r;
  // scaled (not offset) by the coverage map: a clear sky stays clear with the odd cloud, a storm keeps gaps
  float cov = clamp(uCoverage*(0.45 + 1.1*covMap), 0.0, 1.0);
  // skew upward toward the wind so towers lean
  q.xz += h*h*vec2(260.0, 90.0) + gWarp;
  q.y += uTime*3.0;
  vec4 s = texture(uShape, q/4200.0);
  float wfbm = s.g*0.625 + s.b*0.25 + s.a*0.125;
  float shape = remap(s.r, wfbm - 1.0, 1.0, 0.0, 1.0);
  shape *= heightProfile(h);
  float base = clamp(remap(shape, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
  if (base <= 0.0 || !detail || gDetail < 0.01) return base*uDensity;
  vec3 d = texture(uDetail, q/520.0 + vec3(0.0, uTime*0.004, 0.0)).rgb;
  float dfbm = d.r*0.625 + d.g*0.25 + d.b*0.125;
  // wispy bottoms, billowy tops
  float dmod = mix(dfbm, 1.0 - dfbm, clamp(h*6.0, 0.0, 1.0));
  base = clamp(remap(base, dmod*0.38*gDetail, 1.0, 0.0, 1.0), 0.0, 1.0);
  return base*uDensity;
}

float hg(float mu, float g){ float g2 = g*g; return (1.0 - g2)/(12.566371*pow(1.0 + g2 - 2.0*g*mu, 1.5)); }
`;

// stereographic mapping of the upper hemisphere into [0,1]²: horizon on the unit circle
export const CLOUD_MAP_GLSL = /* glsl */ `
vec2 cloudMapUV(vec3 d){ return d.xz/(1.0 + max(d.y, 0.0))*0.5 + 0.5; }
`;

export interface CloudLayer {
  coverage: number;
  density: number;
  base: number;
  top: number;
  type: number;
}

/** the direction map is refreshed in this many horizontal bands, one per frame */
export const BANDS = 6;

export class Clouds {
  readonly map: THREE.WebGLRenderTarget;
  readonly shadow: THREE.WebGLRenderTarget;
  /** world xz centre and size (m) of the shadow map */
  readonly shadowCenter = new THREE.Vector2();
  readonly shadowSize = 5000;
  private readonly mapMat: THREE.RawShaderMaterial;
  private readonly shadowMat: THREE.RawShaderMaterial;
  private band = 0;
  private readonly windOffset = new THREE.Vector2();
  private frame = 0;

  constructor(private readonly blit: Blitter, mapSize = 768) {
    const shape = shapeNoise(64), detail = detailNoise(32);
    this.map = makeRT(mapSize, mapSize);
    this.shadow = makeRT(256, 256);
    const shared = {
      uShape: { value: shape }, uDetail: { value: detail },
      uCam: { value: new THREE.Vector3() }, uWindOffset: { value: this.windOffset },
      uTime: { value: 0 }, uCoverage: { value: 0.4 }, uDensity: { value: 1 }, uBase: { value: 900 }, uTop: { value: 2200 }, uType: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uLightColor: { value: new THREE.Vector3(6, 6, 6) },
      uAmbient: { value: new THREE.Vector3(0.4, 0.45, 0.5) }, uFlash: { value: 0 }, uFlashDir: { value: new THREE.Vector3(1, 0, 0) },
    };

    this.mapMat = passMaterial(
      CLOUD_GLSL + /* glsl */ `
uniform float uFrame;
void main(){
  vec2 p = vUv*2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.1) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // a guard ring just outside the disc repeats the horizon, so filtered lookups at the horizon don't
  // blend in empty texels (a bright line along the horizon)
  if (r2 > 1.0) { p *= inversesqrt(r2); r2 = 1.0; }
  vec3 rd = normalize(vec3(2.0*p.x, 1.0 - r2, 2.0*p.y));
  vec3 ro = vec3(uCam.x, max(uCam.y, 1.0), uCam.z);
  float t0 = shellT(ro.y, rd.y, uBase), t1 = shellT(ro.y, rd.y, uTop);
  // marched all the way to the horizon (~110 km away): far clouds flatten into streaks as they should;
  // the sky shader fades them with aerial perspective
  if (t1 <= t0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t1 = min(t1, t0 + 24000.0);
  // far rays: fewer, cheaper light samples (the light march is lost in the haze there anyway)
  int NL = t0 > 30000.0 ? 3 : 5;
  float horizon = 1.0 - rd.y;
  int N = int(mix(36.0, 56.0, horizon*horizon));
  float dt = (t1 - t0)/float(N);
  // per-texel, per-frame jitter (interleaved gradient noise) hides step banding
  float j = fract(52.9829189*fract(dot(gl_FragCoord.xy + uFrame*5.588, vec2(0.06711056, 0.00583715))));
  float mu = dot(rd, uLightDir);
  float phase = mix(hg(mu, 0.62), hg(mu, -0.25), 0.3) + 0.02;
  vec3 L = vec3(0.0);
  float T = 1.0;
  float tHit = -1.0;
  for (int i=0;i<64;i++){
    if (i >= N || T < 0.015) break;
    float t = t0 + (float(i) + j)*dt;
    vec3 pos = ro + rd*t;
    // one texel of the map covers ~t·0.004 m: fade the ~500 m detail noise out before it aliases
    gDetail = 1.0 - smoothstep(2500.0, 7000.0, t);
    float h = heightFrac(pos);
    gWarp = cloudWarp(pos);
    float dens = cloudDensity(pos, h, true);
    if (dens > 0.001){
      if (tHit < 0.0) tHit = t;
      // light march toward the sun / moon through the cloud
      float od = 0.0;
      float ls = 55.0;
      vec3 lp = pos;
      for (int k=0;k<5;k++){
        if (k >= NL) break;
        lp += uLightDir*ls;
        od += cloudDensity(lp, heightFrac(lp), k < 2)*ls;
        ls *= 1.9;
      }
      float sigma = 0.045;
      float Tl = exp(-sigma*od) + 0.5*exp(-sigma*od*0.18);      // single + cheap multiple scattering
      float powder = 1.0 - exp(-2.0*sigma*dens*120.0);
      vec3 sun = uLightColor*Tl*phase*mix(0.6, 1.0, powder)*6.2832;
      // sky light from above, plus sunlight bounced off the bright lagoon onto the cloud bases
      vec3 amb = uAmbient*mix(0.6, 1.3, h) + uLightColor*0.035*(1.0 - h);
      // lightning lights the cloud from inside
      vec3 flash = vec3(0.7, 0.75, 1.0)*uFlash*14.0*exp(-od*0.004)*pow(max(dot(rd, uFlashDir), 0.0), 6.0);
      vec3 S = (sun + amb + flash)*sigma*dens;
      float st = sigma*dens;
      float Ts = exp(-st*dt);
      L += T*(S - S*Ts)/max(st, 1e-6);
      T *= Ts;
    }
  }
  // aerial perspective of the far layer is applied by the sky shader, which knows the sky colour
  o = vec4(L, T);
}`,
      { ...shared, uFrame: { value: 0 } },
    );

    this.shadowMat = passMaterial(
      CLOUD_GLSL + /* glsl */ `
uniform vec2 uCenter; uniform float uSize;
void main(){
  vec3 g = vec3(uCenter.x + (vUv.x - 0.5)*uSize, 0.0, uCenter.y + (vUv.y - 0.5)*uSize);
  vec3 ld = uLightDir.y < 0.05 ? normalize(vec3(uLightDir.x, 0.05, uLightDir.z)) : uLightDir;
  float t0 = shellT(0.0, ld.y, uBase), t1 = min(shellT(0.0, ld.y, uTop), t0 + 8000.0);
  float od = 0.0;
  const int N = 14;
  float dt = (t1 - t0)/float(N);
  for (int i=0;i<N;i++){
    vec3 p = g + ld*(t0 + (float(i) + 0.5)*dt);
    gWarp = cloudWarp(p);
    od += cloudDensity(p, heightFrac(p), false)*dt;
  }
  o = vec4(exp(-0.045*od*0.7), 0.0, 0.0, 1.0);
}`,
      { ...shared, uCenter: { value: this.shadowCenter }, uSize: { value: this.shadowSize } },
    );
    // temporal accumulation without reading the target: blend each band update into what is there
    // (constant-alpha blending), so every texel averages several jittered marches
    Object.assign(this.mapMat, {
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
      blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
      blendSrcAlpha: THREE.ConstantAlphaFactor, blendDstAlpha: THREE.OneMinusConstantAlphaFactor,
      blendAlpha: 1,
    });
    // both materials share the same uniform objects
    for (const k of Object.keys(shared)) this.shadowMat.uniforms[k] = this.mapMat.uniforms[k];
    this.shadow.texture.wrapS = this.shadow.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  update(dt: number, cam: THREE.Vector3, layer: CloudLayer, wind: { x: number; z: number }, light: {
    dir: THREE.Vector3; color: THREE.Vector3; ambient: THREE.Vector3; flash: number; flashDir: THREE.Vector3;
  }): void {
    const u = this.mapMat.uniforms;
    // upper-level wind carries the clouds faster than the surface wind
    this.windOffset.x -= wind.x * 2.2 * dt;
    this.windOffset.y -= wind.z * 2.2 * dt;
    u.uTime.value += dt;
    u.uCam.value.copy(cam);
    u.uCoverage.value = layer.coverage;
    u.uDensity.value = layer.density;
    u.uBase.value = layer.base;
    u.uTop.value = layer.top;
    u.uType.value = layer.type;
    u.uLightDir.value.copy(light.dir);
    u.uLightColor.value.copy(light.color);
    u.uAmbient.value.copy(light.ambient);
    u.uFlash.value = light.flash;
    u.uFlashDir.value.copy(light.flashDir);
    u.uFrame.value = this.frame++ % 64;
    // the first pass over each band overwrites (start-up fill), later ones accumulate
    this.mapMat.blendAlpha = this.frame <= BANDS ? 1 : 0.34;

    // a sixth of the direction map per frame
    const S = this.map.height, bandH = Math.ceil(S / BANDS);
    this.map.scissor.set(0, this.band * bandH, S, bandH);
    this.map.scissorTest = true;
    this.blit.run(this.mapMat, this.map);
    this.map.scissorTest = false;
    this.band = (this.band + 1) % BANDS;

    // cloud shadow map around the camera (snapped to texels so it doesn't swim)
    const texel = this.shadowSize / 256;
    this.shadowCenter.set(Math.round(cam.x / texel) * texel, Math.round(cam.z / texel) * texel);
    this.blit.run(this.shadowMat, this.shadow);
  }
}

/** GLSL for lit surfaces: transmittance of the direct light through the cloud layer at a world point */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uCloudShadow;
uniform vec3 uCloudShadowRect; // xy centre, z size
float cloudShadow(vec3 wp){
  vec2 uv = (wp.xz - uCloudShadowRect.xy)/uCloudShadowRect.z + 0.5;
  float s = texture(uCloudShadow, uv).r;
  float edge = smoothstep(0.5, 0.42, max(abs(uv.x - 0.5), abs(uv.y - 0.5)));
  return mix(0.75, s, edge);
}
`;

export const cloudShadowUniforms = {
  uCloudShadow: { value: null as THREE.Texture | null },
  uCloudShadowRect: { value: new THREE.Vector3(0, 0, 5000) },
};
