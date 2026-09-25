import * as THREE from 'three';
import { Blitter, makeRT, passMaterial } from './gpu';

/*
 * Bloom + tone map + grade — ported from Clearwater (MIT, © 2026 Lumaris), "Post".
 * Clearwater's FFT lens-diffraction glare is intentionally not ported yet (planned last, see SKETCH §21).
 */
export class PostProcessor {
  exposure = 0.63;
  /** 0..1 golden-hour grade (warm highlights, violet shadows, more bloom) */
  golden = 0;
  /** 0..1 spyglass at the eye: round lens field, edge fringing, black around */
  scope = 0;
  /** 0 sober … 1 roaring drunk: the picture swims, doubles and warms */
  drunk = 0;
  /** lens radius as a fraction of the shorter screen side (at full raise) */
  scopeR = 0.44;
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
uniform sampler2D uHdr, uB1, uB2; uniform float uExp, uTime, uGolden, uScope, uScopeR, uAspect, uDrunk;
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
  // spyglass: position in the lens (1 = its rim); the field closes in from the screen edge as it is raised
  float raise = uScope*uScope*(3.0 - 2.0*uScope);
  float lensR = uScopeR*min(1.0, uAspect)*(1.0 + 2.0*(1.0 - raise));
  vec2 sp = (uv - 0.5)*vec2(uAspect, 1.0);
  float sr = length(sp)/lensR;
  if (uScope > 0.0) {
    // a touch of barrel distortion: the edge of the field is squeezed, the centre held
    float k = 0.07*raise;
    uv = 0.5 + (sp*(1.0 - k + k*sr*sr))/vec2(uAspect, 1.0);
  }
  // drunk: the picture swims — a slow wobble through it, stronger toward the edges
  if (uDrunk > 0.001) {
    vec2 e = uv - 0.5;
    uv += uDrunk*(0.004 + 0.012*dot(e, e))*vec2(sin(uv.y*7.0 + uTime*1.3) + 0.5*sin(uv.y*17.0 - uTime*2.1), cos(uv.x*6.0 + uTime*1.1));
  }
  vec2 cc = uv-0.5; float ca = 0.0012*dot(cc,cc)*4.0 + 0.0045*raise*sr*sr + 0.006*uDrunk*uDrunk;
  vec3 c;
  c.r = texture(uHdr, uv + cc*ca).r; c.g = texture(uHdr, uv).g; c.b = texture(uHdr, uv - cc*ca).b;
  // …and doubles: a second image drifting off and back, the eyes failing to agree
  if (uDrunk > 0.001) {
    float pull = 0.55 + 0.45*sin(uTime*0.73);
    vec2 off = uDrunk*0.022*pull*vec2(cos(uTime*0.41), 0.45*sin(uTime*0.29));
    vec3 ghost = texture(uHdr, uv + off).rgb;
    c = mix(c, ghost, 0.45*min(1.0, uDrunk*1.6));
  }
  float bloom = 0.035 + 0.05*uGolden;
  c += texture(uB1, uv).rgb * bloom + bicubic(uB2, uv) * bloom;
  c *= uExp;
  // golden hour: split-tone — warm the highlights, push the shadows toward violet
  {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float hi = smoothstep(0.05, 0.8, l);
    vec3 warm = c * mix(vec3(0.92, 0.9, 1.08), vec3(1.14, 0.98, 0.8), hi);
    c = mix(c, warm, uGolden);
  }
  float vig = 1.0 - 0.22*dot(cc*vec2(1.0,0.8), cc*vec2(1.0,0.8))*2.2;
  c *= vig;
  // old glass: darker toward the rim of the field, and nothing outside it
  c *= mix(1.0, 0.45 + 0.55*smoothstep(1.05, 0.45, sr), raise);
  c *= 1.0 - smoothstep(0.985, 1.0, sr)*smoothstep(0.0, 0.15, uScope);
  // drunk: the edges of sight close in, the world gone warm and golden
  c *= 1.0 - uDrunk*0.55*smoothstep(0.1, 0.55, dot(cc, cc)*2.2);
  c *= mix(vec3(1.0), vec3(1.1, 1.0, 0.82), uDrunk*0.8);
  c = aces(c);
  float lum = dot(c, vec3(0.2126,0.7152,0.0722));
  c = mix(vec3(lum), c, 0.93);
  c = mix(c, c*vec3(0.96,1.0,1.05), 1.0 - smoothstep(0.0, 0.35, lum));
  c = pow(c, vec3(1.0/2.2));
  float g = hash(gl_FragCoord.xy + fract(uTime*7.13)*917.0) - 0.5;
  c += g * 0.014 * (1.0 - c*0.6);
  o = vec4(c, 1);
}`, { uHdr: { value: null }, uB1: { value: null }, uB2: { value: null }, uExp: { value: 0.63 }, uTime: { value: 0 }, uGolden: { value: 0 }, uDrunk: { value: 0 },
      uScope: { value: 0 }, uScopeR: { value: 0.44 }, uAspect: { value: 1 } });
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
    f.uExp.value = this.exposure; f.uTime.value = time; f.uGolden.value = this.golden; f.uDrunk.value = this.drunk;
    f.uScope.value = this.scope; f.uScopeR.value = this.scopeR;
    f.uAspect.value = this.qA.width / Math.max(1, this.qA.height);
    blit.run(this.final, null);
  }

  /** raw texture to screen (debug views) */
  show(tex: THREE.Texture, k: number): void {
    this.copy.uniforms.uSrc.value = tex;
    this.copy.uniforms.uK.value = k;
    this.blit.run(this.copy, null);
  }
}
