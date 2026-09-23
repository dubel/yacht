import * as THREE from 'three';
import { Blitter, makeRT, passMaterial } from '../gpu';

/*
 * Local wave-equation field — ported from Clearwater (MIT, © 2026 Lumaris), "Interactive ripples".
 * Changes: the window is much larger (boat wake instead of finger taps), the wave speed is an explicit
 * physical parameter (sets the wake cone angle), steps run at a fixed 60 Hz, and a moving hull
 * footprint acts as a pressure disturbance.
 */
export interface HullDisturbance {
  /** world xz of hull centre */
  x: number;
  z: number;
  /** heading unit vector (bow direction) in world xz */
  fx: number;
  fz: number;
  halfLength: number;
  halfBeam: number;
  /** pressure strength (m per step-ish); 0 = no wake */
  strength: number;
}

export class Ripples {
  readonly N: number;
  readonly size: number;
  /** (h, dh/dx, dh/dz, foam) in world metres */
  readonly field: THREE.WebGLRenderTarget;
  readonly center = new THREE.Vector2();

  private readonly sim: THREE.WebGLRenderTarget[];
  private idx = 0;
  private acc = 0;
  private readonly stepMat: THREE.RawShaderMaterial;
  private readonly normMat: THREE.RawShaderMaterial;
  private readonly drops: THREE.Vector4[] = [];

  constructor(private readonly blit: Blitter, renderer: THREE.WebGLRenderer, N: number, size: number, speed: number) {
    this.N = N;
    this.size = size;
    this.sim = [0, 1].map(() => makeRT(N, N));
    this.field = makeRT(N, N);
    const dx = size / N, dt = 1 / 60;
    const K = Math.min(1.6, (4 * speed * speed * dt * dt) / (dx * dx));

    this.stepMat = passMaterial(
      /* glsl */ `
uniform sampler2D uSrc; uniform vec2 uShift; uniform vec4 uDrop; uniform float uK;
uniform vec4 uHull;   // xy centre (uv), zw forward unit
uniform vec3 uHullS;  // x half-length (uv), y half-beam (uv), z strength
uniform float uTime;
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
void main(){
  vec2 px = 1.0/vec2(textureSize(uSrc,0));
  vec2 uv = vUv + uShift;
  vec4 c = texture(uSrc, uv);
  float avg = 0.25*(texture(uSrc, uv+vec2(px.x,0)).r + texture(uSrc, uv-vec2(px.x,0)).r + texture(uSrc, uv+vec2(0,px.y)).r + texture(uSrc, uv-vec2(0,px.y)).r);
  float v = c.g + (avg - c.r)*uK;
  v *= 0.996;
  float h = c.r + v;
  h *= 0.9988;
  // foam: carried in world space by the window shift, slowly spreads and fades
  float favg = 0.25*(texture(uSrc, uv+vec2(px.x,0)).b + texture(uSrc, uv-vec2(px.x,0)).b + texture(uSrc, uv+vec2(0,px.y)).b + texture(uSrc, uv-vec2(0,px.y)).b);
  float foam = mix(c.b, favg, 0.1) * 0.9968;
  if (uDrop.w != 0.0){ float d = length(vUv - uDrop.xy); float r = uDrop.z; if (d < r){ float f = 0.5+0.5*cos(3.14159*d/r); h -= uDrop.w*f; } }
  if (uHullS.z != 0.0){
    vec2 d = vUv - uHull.xy;
    vec2 q = vec2(dot(d, uHull.zw), dot(d, vec2(-uHull.w, uHull.z)));
    float along = q.x/uHullS.x, across = q.y/uHullS.y;
    // pointy bow, fuller stern
    float beam = 1.0 - 0.55*max(along,0.0)*max(along,0.0);
    float e = along*along + (across/beam)*(across/beam);
    // bow pushes water down/out, the stern quarter wave follows
    float bow = exp(-((along-0.72)*(along-0.72)*22.0 + across*across*2.5));
    float stern = exp(-((along+0.9)*(along+0.9)*22.0 + across*across*2.5));
    h -= uHullS.z*(bow - 0.45*stern);
    // turbulence along the waterline radiates short ripples
    float ring = smoothstep(1.35, 0.95, e)*smoothstep(0.55, 0.95, e);
    float n = hash(floor(vUv*512.0) + floor(uTime*30.0)) - 0.5;
    h += uHullS.z*1.6*ring*n;
    // foam: along the waterline (mostly forward) and the churned water behind the transom
    float aft = smoothstep(-0.7, -0.95, along)*smoothstep(-1.45, -1.1, along)*smoothstep(1.0, 0.3, abs(across));
    foam += uHullS.z*(ring*(0.1 + 0.25*max(along,0.0)) + 1.25*aft);
  }
  // fade out near borders so the local field blends into open water
  vec2 e = min(vUv, 1.0-vUv); float edge = smoothstep(0.0, 0.08, min(e.x,e.y));
  h *= mix(0.92, 1.0, edge); v *= mix(0.92, 1.0, edge); foam *= edge;
  if (uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.) { h=0.; v=0.; foam=0.; }
  o = vec4(h, v, min(foam, 4.0), 1);
}`,
      {
        uSrc: { value: null },
        uShift: { value: new THREE.Vector2() },
        uDrop: { value: new THREE.Vector4() },
        uK: { value: K },
        uHull: { value: new THREE.Vector4() },
        uHullS: { value: new THREE.Vector3() },
        uTime: { value: 0 },
      },
    );

    this.normMat = passMaterial(
      /* glsl */ `
uniform sampler2D uSrc; uniform float uTexel;
void main(){
  vec2 px = 1.0/vec2(textureSize(uSrc,0));
  float r = texture(uSrc, vUv+vec2(px.x,0)).r, l = texture(uSrc, vUv-vec2(px.x,0)).r;
  float u = texture(uSrc, vUv+vec2(0,px.y)).r, d = texture(uSrc, vUv-vec2(0,px.y)).r;
  float h = texture(uSrc,vUv).r;
  o = vec4(h, (r-l)/(2.0*uTexel), (u-d)/(2.0*uTexel), texture(uSrc, vUv).b);
}`,
      { uSrc: { value: null }, uTexel: { value: dx } },
    );

    for (const rt of [...this.sim, this.field]) {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
  }

  /** splash at world xz; radius in m, strength in m */
  disturb(x: number, z: number, radius: number, strength: number): void {
    this.drops.push(new THREE.Vector4(x, z, radius, strength));
  }

  update(dt: number, follow: THREE.Vector2, hull: HullDisturbance | null): void {
    this.acc = Math.min(this.acc + dt, 0.1);
    const texel = this.size / this.N;
    while (this.acc >= 1 / 60) {
      this.acc -= 1 / 60;
      // keep the window centred on the target, snapped to whole texels
      const dxT = Math.round((follow.x - this.center.x) / texel);
      const dzT = Math.round((follow.y - this.center.y) / texel);
      const u = this.stepMat.uniforms;
      u.uShift.value.set(dxT / this.N, dzT / this.N);
      this.center.x += dxT * texel;
      this.center.y += dzT * texel;

      const d = this.drops.shift();
      if (d) u.uDrop.value.set((d.x - this.center.x) / this.size + 0.5, (d.y - this.center.y) / this.size + 0.5, d.z / this.size, d.w);
      else u.uDrop.value.set(0, 0, 0, 0);

      if (hull && hull.strength !== 0) {
        u.uHull.value.set((hull.x - this.center.x) / this.size + 0.5, (hull.z - this.center.y) / this.size + 0.5, hull.fx, hull.fz);
        u.uHullS.value.set(hull.halfLength / this.size, hull.halfBeam / this.size, hull.strength);
      } else u.uHullS.value.set(1, 1, 0);

      u.uTime.value += 1 / 60;
      u.uSrc.value = this.sim[this.idx].texture;
      this.blit.run(this.stepMat, this.sim[1 - this.idx]);
      this.idx = 1 - this.idx;
    }
    this.normMat.uniforms.uSrc.value = this.sim[this.idx].texture;
    this.blit.run(this.normMat, this.field);
  }
}
