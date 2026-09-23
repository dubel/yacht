import * as THREE from 'three';
import { Blitter, makeRT, passMaterial } from './gpu';

/*
 * Bloom + tone map + grade — ported from Clearwater (MIT, © 2026 Lumaris), "Post".
 * Clearwater's FFT lens-diffraction glare is intentionally not ported yet (planned last, see SKETCH §21).
 */
export class PostProcessor {
  exposure = 0.63;
  private qA!: THREE.WebGLRenderTarget;
  private qB!: THREE.WebGLRenderTarget;
  private b1!: THREE.WebGLRenderTarget;
  private b2!: THREE.WebGLRenderTarget;
  private b2t!: THREE.WebGLRenderTarget;
  private readonly bright: THREE.RawShaderMaterial;
  private readonly blur: THREE.RawShaderMaterial;
  private readonly copy: THREE.RawShaderMaterial;
  private readonly final: THREE.RawShaderMaterial;

  constructor(private readonly blit: Blitter) {
    this.bright = passMaterial(/* glsl */ `
uniform sampler2D uSrc; uniform float uThr;
void main(){
  vec2 px = 1.0/vec2(textureSize(uSrc,0));
  vec3 c = vec3(0);
  for (int y=-1;y<=2;y++) for (int x=-1;x<=2;x++) c += texture(uSrc, vUv + (vec2(x,y)-0.5)*px).rgb;
  c /= 16.0;
  float l = max(max(c.r,c.g),c.b);
  float k = max(l - uThr, 0.0) / max(l, 1e-4);
  o = vec4(min(c*k, vec3(160.0)), 1);
}`, { uSrc: { value: null }, uThr: { value: 2.5 } });

    this.blur = passMaterial(/* glsl */ `
uniform sampler2D uSrc; uniform vec2 uDir;
void main(){
  vec2 px = uDir/vec2(textureSize(uSrc,0));
  vec3 c = texture(uSrc, vUv).rgb*0.2270270270;
  c += (texture(uSrc, vUv+px*1.3846153846).rgb + texture(uSrc, vUv-px*1.3846153846).rgb)*0.3162162162;
  c += (texture(uSrc, vUv+px*3.2307692308).rgb + texture(uSrc, vUv-px*3.2307692308).rgb)*0.0702702703;
  o = vec4(c,1);
}`, { uSrc: { value: null }, uDir: { value: new THREE.Vector2() } });

    this.copy = passMaterial(/* glsl */ `
uniform sampler2D uSrc; uniform float uK;
void main(){ o = vec4(texture(uSrc,vUv).rgb*uK, 1); }`, { uSrc: { value: null }, uK: { value: 1 } });

    this.final = passMaterial(/* glsl */ `
uniform sampler2D uHdr, uB1, uB2; uniform float uExp, uTime;
vec3 bicubic(sampler2D t, vec2 uv){
  vec2 ts = vec2(textureSize(t,0)); vec2 p = uv*ts - 0.5; vec2 f = fract(p); p = floor(p);
  vec2 w0 = f*(-0.5+f*(1.0-0.5*f)), w1 = 1.0+f*f*(-2.5+1.5*f), w2 = f*(0.5+f*(2.0-1.5*f)), w3 = f*f*(-0.5+0.5*f);
  vec2 g0 = w0+w1, g1 = w2+w3; vec2 h0 = (w1/g0 - 0.5 + p)/ts, h1 = (w3/g1 + 1.5 + p)/ts;
  return (texture(t, vec2(h0.x,h0.y)).rgb*g0.x + texture(t, vec2(h1.x,h0.y)).rgb*g1.x)*g0.y + (texture(t, vec2(h0.x,h1.y)).rgb*g0.x + texture(t, vec2(h1.x,h1.y)).rgb*g1.x)*g1.y;
}
vec3 aces(vec3 x){ const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.,1.); }
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
void main(){
  vec2 uv = vUv;
  vec2 cc = uv-0.5; float ca = 0.0012*dot(cc,cc)*4.0;
  vec3 c;
  c.r = texture(uHdr, uv + cc*ca).r; c.g = texture(uHdr, uv).g; c.b = texture(uHdr, uv - cc*ca).b;
  c += texture(uB1, uv).rgb * 0.035 + bicubic(uB2, uv) * 0.035;
  c *= uExp;
  float vig = 1.0 - 0.22*dot(cc*vec2(1.0,0.8), cc*vec2(1.0,0.8))*2.2;
  c *= vig;
  c = aces(c);
  float lum = dot(c, vec3(0.2126,0.7152,0.0722));
  c = mix(vec3(lum), c, 0.93);
  c = mix(c, c*vec3(0.96,1.0,1.05), 1.0 - smoothstep(0.0, 0.35, lum));
  c = pow(c, vec3(1.0/2.2));
  float g = hash(gl_FragCoord.xy + fract(uTime*7.13)*917.0) - 0.5;
  c += g * 0.014 * (1.0 - c*0.6);
  o = vec4(c, 1);
}`, { uHdr: { value: null }, uB1: { value: null }, uB2: { value: null }, uExp: { value: 0.63 }, uTime: { value: 0 } });
  }

  setSize(w: number, h: number): void {
    for (const r of [this.qA, this.qB, this.b1, this.b2, this.b2t]) r?.dispose();
    const qw = Math.max(1, w >> 1), qh = Math.max(1, h >> 1);
    this.qA = makeRT(qw, qh);
    this.qB = makeRT(qw, qh);
    this.b1 = makeRT(qw, qh);
    this.b2 = makeRT(Math.max(1, qw >> 2), Math.max(1, qh >> 2));
    this.b2t = makeRT(this.b2.width, this.b2.height);
  }

  render(hdr: THREE.Texture, time: number): void {
    const { blit, bright, blur, copy } = this;
    bright.uniforms.uSrc.value = hdr;
    blit.run(bright, this.qA);
    const bu = blur.uniforms;
    bu.uSrc.value = this.qA.texture; bu.uDir.value.set(1, 0); blit.run(blur, this.qB);
    bu.uSrc.value = this.qB.texture; bu.uDir.value.set(0, 1); blit.run(blur, this.b1);
    copy.uniforms.uSrc.value = this.b1.texture; copy.uniforms.uK.value = 1; blit.run(copy, this.b2);
    for (let i = 0; i < 2; i++) {
      bu.uSrc.value = this.b2.texture; bu.uDir.value.set(1.5, 0); blit.run(blur, this.b2t);
      bu.uSrc.value = this.b2t.texture; bu.uDir.value.set(0, 1.5); blit.run(blur, this.b2);
    }
    const f = this.final.uniforms;
    f.uHdr.value = hdr; f.uB1.value = this.b1.texture; f.uB2.value = this.b2.texture;
    f.uExp.value = this.exposure; f.uTime.value = time;
    blit.run(this.final, null);
  }

  /** raw texture to screen (debug views) */
  show(tex: THREE.Texture, k: number): void {
    this.copy.uniforms.uSrc.value = tex;
    this.copy.uniforms.uK.value = k;
    this.blit.run(this.copy, null);
  }
}
