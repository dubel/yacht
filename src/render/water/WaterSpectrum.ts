import * as THREE from 'three';
import { Blitter, makeRT, passMaterial } from '../gpu';
import { gauss, mulberry32 } from '../../core/noise';

/*
 * FFT ocean spectrum — ported from Clearwater (MIT, © 2026 Lumaris), "Ocean spectrum (FFT)".
 * H0 → time evolution → 2×log2(N) butterfly passes → resolve into (h, dh/dx, dh/dz, |slope|²).
 * The surface texture is mip-mapped; its alpha holds slope² so mips carry slope variance (LEAN glints).
 *
 * Changes vs. Clearwater: all spectral length scales are parameterised by the patch size L
 * (Clearwater's constants are for L = 4.6 m), and the wind direction is an input.
 */
export class WaterSpectrum {
  readonly N: number;
  readonly L: number;
  readonly surface: THREE.WebGLRenderTarget;

  private readonly h0: THREE.DataTexture;
  private readonly a: THREE.WebGLRenderTarget;
  private readonly b: THREE.WebGLRenderTarget;
  private readonly specMat: THREE.RawShaderMaterial;
  private readonly fftMat: THREE.RawShaderMaterial;
  private readonly resolveMat: THREE.RawShaderMaterial;

  constructor(private readonly blit: Blitter, N: number, L: number, targetSlope: number, windToward: [number, number]) {
    this.N = N;
    this.L = L;
    this.h0 = this.buildH0(targetSlope, windToward);
    const fftOpts = { type: THREE.FloatType, filter: THREE.NearestFilter, wrap: THREE.RepeatWrapping } as const;
    this.a = makeRT(N, N, fftOpts);
    this.b = makeRT(N, N, fftOpts);
    this.surface = makeRT(N, N, { wrap: THREE.RepeatWrapping, mipmaps: true, anisotropy: 8 });

    this.specMat = passMaterial(
      /* glsl */ `
uniform sampler2D uH0; uniform float uT, uL;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uH0, id, 0);
  vec2 n = vec2(id); n -= step(float(N/2), n) * float(N);
  vec2 k = 6.28318530718*n/uL; float kl = length(k);
  float w = sqrt(9.81*kl + 7.4e-5*kl*kl*kl);
  // gentle dispersion quantisation keeps the loop seamless over 120 s
  float w0 = 6.28318530718/120.0; w = floor(w/w0)*w0;
  float c = cos(w*uT), sn = sin(w*uT);
  vec2 H = cmul(s.xy, vec2(c,sn)) + cmul(s.zw, vec2(c,-sn));
  vec2 C1 = H - k.x*H;                    // h + i*dh/dx
  vec2 C2 = vec2(-k.y*H.y, k.y*H.x);      // dh/dz
  o = vec4(C1, C2);
}`,
      { uH0: { value: this.h0 }, uT: { value: 0 }, uL: { value: L } },
      { N },
    );

    this.fftMat = passMaterial(
      /* glsl */ `
uniform sampler2D uSrc; uniform int uP, uHoriz;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  int j = uHoriz==1 ? id.x : id.y;
  int k = j & (uP-1);
  int i = ((j - (j & (2*uP-1))) >> 1) + k;
  bool y1 = (j & uP) != 0;
  ivec2 a = uHoriz==1 ? ivec2(i, id.y) : ivec2(id.x, i);
  ivec2 b = uHoriz==1 ? ivec2(i+N/2, id.y) : ivec2(id.x, i+N/2);
  vec4 x0 = texelFetch(uSrc, a, 0), x1 = texelFetch(uSrc, b, 0);
  float ang = 3.14159265359*float(k)/float(uP);
  vec2 w = vec2(cos(ang), sin(ang));
  vec4 wx = vec4(cmul(w,x1.xy), cmul(w,x1.zw));
  o = y1 ? x0-wx : x0+wx;
}`,
      { uSrc: { value: null }, uP: { value: 1 }, uHoriz: { value: 1 } },
      { N },
    );

    this.resolveMat = passMaterial(
      /* glsl */ `
uniform sampler2D uSrc;
void main(){
  vec4 s = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  vec2 sl = vec2(s.y, s.z);
  o = vec4(s.x, sl, dot(sl,sl));
}`,
      { uSrc: { value: null } },
    );
  }

  private buildH0(targetSlope: number, wind: [number, number]): THREE.DataTexture {
    const { N, L } = this;
    // Clearwater's spectrum shape, rescaled from its 4.6 m patch
    const S = L / 4.6;
    const kp = (2 * Math.PI) / (0.62 * S);
    const kcut = (2 * Math.PI) / (0.045 * S);
    const kswell = (2 * Math.PI) / (1.6 * S);
    const rnd = mulberry32(7);
    const re = new Float32Array(N * N), im = new Float32Array(N * N);
    let s2 = 0;
    for (let m = 0; m < N; m++)
      for (let n = 0; n < N; n++) {
        const nx = n < N / 2 ? n : n - N, nz = m < N / 2 ? m : m - N;
        const kx = (2 * Math.PI * nx) / L, kz = (2 * Math.PI * nz) / L, k = Math.hypot(kx, kz);
        let P = 0;
        if (k > 1e-6) {
          const lk = Math.log(k / kp);
          const bump = Math.exp(-0.5 * (lk / 0.36) ** 2);
          const tail = 0.035 * Math.exp(-((kp / k) ** 2)) * Math.exp(-((k / kcut) ** 2));
          const swell = 0.35 * Math.exp(-0.5 * (Math.log(k / kswell) / 0.3) ** 2);
          const c = (kx * wind[0] + kz * wind[1]) / k;
          const spread = (0.3 + 0.7 * c * c) * (c < 0 ? 0.35 : 1);
          P = ((bump + tail + swell) * spread) / (k * k * k * k);
        }
        const a = Math.sqrt(P / 2);
        const i = m * N + n;
        re[i] = gauss(rnd) * a;
        im[i] = gauss(rnd) * a;
        s2 += 2 * k * k * (re[i] * re[i] + im[i] * im[i]);
      }
    const sc = targetSlope / Math.sqrt(s2);
    const data = new Float32Array(N * N * 4);
    for (let m = 0; m < N; m++)
      for (let n = 0; n < N; n++) {
        const i = m * N + n, j = ((N - m) % N) * N + ((N - n) % N);
        data[i * 4] = re[i] * sc;
        data[i * 4 + 1] = im[i] * sc;
        data[i * 4 + 2] = re[j] * sc;
        data[i * 4 + 3] = -im[j] * sc;
      }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }

  update(t: number): void {
    this.specMat.uniforms.uT.value = t;
    this.blit.run(this.specMat, this.a);
    let src = this.a, dst = this.b;
    const logN = Math.log2(this.N);
    for (let horiz = 1; horiz >= 0; horiz--)
      for (let s = 0; s < logN; s++) {
        this.fftMat.uniforms.uSrc.value = src.texture;
        this.fftMat.uniforms.uP.value = 1 << s;
        this.fftMat.uniforms.uHoriz.value = horiz;
        this.blit.run(this.fftMat, dst);
        [src, dst] = [dst, src];
      }
    this.resolveMat.uniforms.uSrc.value = src.texture;
    this.blit.run(this.resolveMat, this.surface);
  }
}
