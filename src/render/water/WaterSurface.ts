import * as THREE from 'three';
import { GERSTNER_GLSL, MAX_WAVES, WaveField } from '../../environment/WaveField';
import { WATER_OPTICS_GLSL } from './optics';

/*
 * The visible water surface: a camera-centred radial grid displaced by the shared Gerstner waves
 * (+ FFT/ripple height), shaded with Clearwater's water model (MIT, © 2026 Lumaris) adapted from a
 * full-screen ray-cast to a mesh inside a real scene:
 *   - reflections come from a planar-reflection render of the actual world (not an analytic sky),
 *   - "underwater" is the already-rendered scene (seabed with caustics, hull), refracted and
 *     attenuated by the real water thickness recovered from the depth buffer,
 *   - glints, Fresnel, in-scattering and slope-variance (LEAN) widening follow Clearwater directly.
 */

const VERT = /* glsl */ `
uniform vec2 uGridCenter;
uniform sampler2D uSurf, uRip;
uniform float uL, uRipSize;
uniform vec2 uRipCenter;
${GERSTNER_GLSL}
varying vec3 vWorld;
varying vec2 vParam;
varying float vCrest;
uniform float uChop;
const mat2 M = mat2(0.8, -0.6, 0.6, 0.8);
const float SC = 0.41, WB = 0.10;
void main(){
  vec2 p = position.xz + uGridCenter;
  vec3 g = gerstnerDisplace(p);
  // crest measure for whitecaps: height relative to the summed amplitudes
  float ampSum = 0.0;
  for (int i=0;i<${MAX_WAVES};i++) ampSum += uWaveB[i].x;
  vCrest = g.y / max(ampSum, 1e-3);
  vec3 w = vec3(p.x + g.x, g.y, p.y + g.z);
  float camD = length(w.xz - cameraPosition.xz);
  float detail = exp(-camD*0.01);
  w.y += uChop*detail*(textureLod(uSurf, w.xz/uL, 0.0).x + WB*SC*textureLod(uSurf, (M*w.xz)/(uL*SC) + 0.37, 0.0).x);
  vec2 ruv = (w.xz - uRipCenter)/uRipSize + 0.5;
  if (all(greaterThan(ruv, vec2(0.0))) && all(lessThan(ruv, vec2(1.0)))) w.y += textureLod(uRip, ruv, 0.0).x;
  vParam = p;
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uSurf, uRip, uRefl, uSceneColor, uSceneDepth;
uniform mat4 uReflMatrix, uViewProj, uInvViewProj;
uniform vec2 uResolution;
uniform vec3 uCamFwd;
uniform float uNear, uFar;
uniform vec3 uSunDir, uSunRad, uSkyIrr, uFogColor;
uniform float uFogDensity, uTime, uL, uRipSize;
uniform vec2 uRipCenter;
uniform int uView;
uniform float uChop, uWhitecaps, uRain;
${GERSTNER_GLSL}
${WATER_OPTICS_GLSL}
varying vec3 vWorld;
varying vec2 vParam;
varying float vCrest;

const float PI = 3.14159265359;
const mat2 M = mat2(0.8, -0.6, 0.6, 0.8);
const mat2 M2 = mat2(0.28, 0.96, -0.96, 0.28);
const float SC = 0.41, WB = 0.10;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }

// cubic B-spline filtering in 4 bilinear taps: smooth slopes -> smooth highlights (Clearwater)
vec4 texBS(sampler2D t, vec2 uv){
  vec2 ts = vec2(textureSize(t,0)); vec2 p = uv*ts - 0.5; vec2 f = fract(p); p = floor(p);
  vec2 f2 = f*f, f3 = f2*f;
  vec2 w0 = (-f3 + 3.0*f2 - 3.0*f + 1.0)/6.0, w1 = (3.0*f3 - 6.0*f2 + 4.0)/6.0;
  vec2 w2 = (-3.0*f3 + 3.0*f2 + 3.0*f + 1.0)/6.0, w3 = f3/6.0;
  vec2 g0 = w0+w1, g1 = w2+w3; vec2 h0 = (w1/g0 - 0.5 + p)/ts, h1 = (w3/g1 + 1.5 + p)/ts;
  return (texture(t, vec2(h0.x,h0.y))*g0.x + texture(t, vec2(h1.x,h0.y))*g1.x)*g0.y
       + (texture(t, vec2(h0.x,h1.y))*g0.x + texture(t, vec2(h1.x,h1.y))*g1.x)*g1.y;
}

// raindrop rings: each cell hosts a drop at a random phase; the expanding ring perturbs the slope
vec2 rainRipples(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int layer=0; layer<2; layer++){
    vec2 q = p*(layer == 0 ? 2.3 : 3.7) + float(layer)*13.7;
    vec2 id = floor(q);
    for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
      vec2 c = id + vec2(i,j);
      float h = hash12(c);
      vec2 o = c + vec2(hash12(c+1.7), hash12(c+5.3));
      float ph = fract(t*(0.9 + 0.6*h) + h*7.0);
      vec2 d = q - o;
      float r = length(d);
      float ring = sin((r - ph*0.9)*38.0) * smoothstep(0.1, 0.0, abs(r - ph*0.9)) * (1.0 - ph);
      acc += ring * d/max(r, 1e-3);
    }
  }
  return acc*0.07;
}

float linearDepth(float d){ float z = d*2.0-1.0; return 2.0*uNear*uFar/(uFar + uNear - z*(uFar - uNear)); }
vec3 worldFromDepth(vec2 uv, float d){ vec4 w = uInvViewProj*vec4(uv*2.0-1.0, d*2.0-1.0, 1.0); return w.xyz/w.w; }

void main(){
  vec3 P = vWorld;
  vec3 toCam = cameraPosition - P;
  float dist = length(toCam);
  vec3 v = toCam/dist, wd = -v;
  vec2 suv = gl_FragCoord.xy/uResolution;

  // ---- manual occlusion by the opaque scene (it lives in another render target) ----
  float dStraight = texture(uSceneDepth, suv).x;
  float sceneZ = linearDepth(dStraight);
  float waterZ = dot(P - cameraPosition, uCamFwd);
  if (sceneZ < waterZ - 0.03*max(1.0, waterZ*0.02)) discard;

  // ---- surface slope: Gerstner (analytic) + two FFT layers + micro layer + wake ripples ----
  vec4 A = texBS(uSurf, P.xz/uL);
  vec4 B = texBS(uSurf, (M*P.xz)/(uL*SC) + 0.37);
  vec4 Cm = texture(uSurf, (M2*P.xz)/(uL*0.13) + 0.71);
  vec2 ruv = (P.xz - uRipCenter)/uRipSize + 0.5;
  vec4 R = vec4(0.0);
  float ripIn = 0.0;
  if (all(greaterThan(ruv, vec2(0.0))) && all(lessThan(ruv, vec2(1.0)))) { R = texture(uRip, ruv); ripIn = 1.0; }
  vec2 slope = gerstnerSlope(vParam) + uChop*(A.yz + WB*(transpose(M)*B.yz)) + R.yz;
  slope += uChop*0.13*exp(-dist*0.04)*(transpose(M2)*Cm.yz);
  if (uRain > 0.01) slope += uRain*rainRipples(P.xz, uTime)*exp(-dist*0.05);
  float var = uChop*uChop*(max(A.w - dot(A.yz,A.yz), 0.0) + WB*WB*max(B.w - dot(B.yz,B.yz), 0.0));
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  // ---- seen from below: Snell's window, total internal reflection outside it ----
  if (!gl_FrontFacing) {
    vec3 nd = -n;
    float ci = max(dot(nd, v), 0.0);
    vec3 sunT = refract(-uSunDir, vec3(0,1,0), 1.0/WATER_IOR);
    float Ts = 1.0 - fresnelDielectric(uSunDir.y, WATER_IOR);
    // water-column radiance arriving along a direction (single scattering, HG phase toward the sun)
    #define COLUMN(dir) (WATER_SIG_S/WATER_SIG_T*3.2*(uSunRad*Ts*exp(-WATER_SIG_T*1.5/max(-sunT.y, 0.2))*((1.0-0.64)/(4.0*PI*pow(1.64-1.6*dot(dir, -sunT), 1.5))*0.18 + 0.03) + uSkyIrr*exp(-WATER_SIG_A*1.8)/(4.0*PI)))
    vec3 deep = COLUMN(wd);
    vec3 tr = refract(wd, nd, WATER_IOR);
    float Fu = 1.0;
    vec3 through = vec3(0.0);
    if (dot(tr, tr) > 1e-4) {
      Fu = fresnelDielectric(ci, 1.0/WATER_IOR);
      vec4 fc2 = uViewProj*vec4(P + tr*400.0, 1.0);
      vec2 tuv = fc2.xy/fc2.w*0.5 + 0.5;
      bool onScr = fc2.w > 0.0 && all(greaterThan(tuv, vec2(0.0))) && all(lessThan(tuv, vec2(1.0)));
      through = onScr ? texture(uSceneColor, tuv).rgb : uFogColor;
      through += uSunRad * 60.0 * pow(max(dot(tr, uSunDir), 0.0), 3000.0);
    }
    // total internal reflection mirrors the dim water column; ripple slopes modulate it so the surface reads
    float tilt = dot(slope, normalize(sunT.xz + 1e-4));
    // total internal reflection shows the (darker) water below, seen along the reflected ray
    vec3 mirror = COLUMN(reflect(wd, nd))*(0.55 + 0.7*smoothstep(-0.12, 0.12, tilt));
    vec3 col = Fu*mirror + (1.0 - Fu)*through;
    // the wake and wave crests seen from below: bright, diffuse
    float cellsU = vnoise(P.xz*1.3 + 7.0)*0.6 + vnoise(P.xz*4.1 - uTime*0.15)*0.4;
    float foamU = ripIn*smoothstep(1.0 - clamp(R.a*0.8, 0.0, 0.92), 1.1 - clamp(R.a*0.8, 0.0, 0.92), cellsU)*clamp(R.a, 0.0, 1.0);
    col = mix(col, uSunRad*Ts*0.12 + deep, foamU*0.7);
    // (the water column between the surface and the lens is applied by UnderwaterPass)
    if (uView == 1) col = n*0.5 + 0.5;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
    return;
  }

  float nv = dot(n, v);
  if (nv < 0.02) { n = normalize(n + v*(0.02-nv)); nv = dot(n,v); }
  float F = fresnelDielectric(nv, WATER_IOR);

  // ---- reflection: planar render of the world, distorted by the surface normal ----
  vec4 rc = uReflMatrix*vec4(P.x, 0.0, P.z, 1.0);
  vec2 rUV0 = rc.xy/rc.w;
  vec2 rUV = rUV0 + n.xz*0.16/(1.0 + dist*0.012);
  vec3 refl = texture(uRefl, clamp(rUV, 0.001, 0.999)).rgb;

  // sun glints: Beckmann with slope-variance widening (LEAN-style), Clearwater
  float a2 = 0.00012 + 1.2*var + 0.00002*dist;
  vec3 h = normalize(v + uSunDir);
  float nh = max(dot(n,h),0.0), nl = max(dot(n,uSunDir),0.0);
  float c2 = max(nh*nh, 1e-4); float tan2 = (1.0-c2)/c2;
  float D = exp(-tan2/a2)/(PI*a2*c2*c2);
  float Vis = 0.5/(nl*sqrt(nv*nv*(1.0-a2)+a2) + nv*sqrt(nl*nl*(1.0-a2)+a2) + 1e-5);
  float Fh = fresnelDielectric(max(dot(h,v),0.0), WATER_IOR);
  vec3 spec = uSunRad * min(D*Vis*Fh*nl, 12000.0);

  // ---- refraction: follow the refracted ray to the seabed that is already in the scene buffer ----
  vec3 tr = refract(wd, n, 1.0/WATER_IOR);
  vec3 bedStraight = worldFromDepth(suv, dStraight);
  float below = clamp(P.y - bedStraight.y, 0.0, 60.0);
  vec3 FP = P + tr*(below/max(-tr.y, 0.08));
  vec4 fc = uViewProj*vec4(FP, 1.0);
  vec2 fuvRaw = fc.xy/fc.w*0.5 + 0.5;
  // refracted ray leaves the screen (mostly right under the camera): fade back to the straight view
  float onScreen = smoothstep(0.0, 0.06, min(min(fuvRaw.x, 1.0 - fuvRaw.x), min(fuvRaw.y, 1.0 - fuvRaw.y)));
  vec2 fuv = clamp(mix(suv, fuvRaw, onScreen), 0.001, 0.999);
  float dR = texture(uSceneDepth, fuv).x;
  // refracted sample landed on something above the water (hull, rocks): fall back to the straight view
  if (linearDepth(dR) < waterZ) { fuv = suv; dR = dStraight; }
  vec3 bed = worldFromDepth(fuv, dR);
  vec3 sceneCol = texture(uSceneColor, fuv).rgb;
  float s = dR >= 0.99999 ? 400.0 : length(bed - P);
  float depthHere = dR >= 0.99999 ? 60.0 : max(P.y - bed.y, 0.0);

  vec3 sunT = refract(-uSunDir, vec3(0,1,0), 1.0/WATER_IOR);
  float Ts = 1.0 - fresnelDielectric(uSunDir.y, WATER_IOR);
  vec3 Tv = exp(-WATER_SIG_T*s);
  float cosS = dot(sunT, -tr);
  float g = 0.8; float ph = (1.0-g*g)/(4.0*PI*pow(1.0+g*g-2.0*g*cosS, 1.5));
  float dMid = min(depthHere*0.5, 5.0);
  vec3 Lmid = uSunRad*Ts*exp(-WATER_SIG_T*dMid/max(-sunT.y, 0.2))*(ph+0.02) + uSkyIrr*exp(-WATER_SIG_A*dMid*1.2)/(4.0*PI);
  vec3 Lin = WATER_SIG_S/WATER_SIG_T * Lmid * (1.0 - Tv) * 3.2;
  vec3 under = sceneCol*Tv + Lin;

  // suspended specks at three depths (Clearwater): sunlit particles that give the water column volume
  for (int k=0;k<3;k++){
    float dz = 0.35 + 0.6*float(k);
    float tt = dz / max(-tr.y, 0.05);
    vec2 q = (P.xz + tr.xz*tt)*22.0 + vec2(uTime*(0.05+0.03*float(k)), uTime*0.02) + float(k)*17.0;
    vec2 id = floor(q), f = fract(q) - 0.5;
    float r = hash12(id + float(k)*13.1);
    vec2 of = vec2(hash12(id+3.1), hash12(id+7.7)) - 0.5;
    float fw = fwidth(q.x) + fwidth(q.y);
    float dot_ = smoothstep(0.10 + fw, 0.0, length(f - of*0.6)) * step(0.988, r) * step(tt, s);
    float fade = exp(-WATER_SIG_T.g*tt*2.0) * smoothstep(1.2, 0.3, fw);
    under += dot_ * fade * uSunRad * Ts * 0.02;
  }

  vec3 col = F*refl + (1.0-F)*under + spec;

  // ---- foam: wake (steep ripple slopes / troughs) + thin shore wash ----
  float foamN = vnoise(P.xz*1.7 + uTime*0.3) * 0.6 + vnoise(P.xz*5.3 - uTime*0.2)*0.4;
  // wake foam: coverage from the sim, broken into lace by thresholding a cellular pattern
  float cells = vnoise(P.xz*1.3 + 7.0)*0.45 + vnoise(P.xz*4.1 - uTime*0.15)*0.35 + vnoise(P.xz*13.0)*0.2;
  float cover = clamp(R.a*0.8, 0.0, 0.92);
  float lace = smoothstep(1.0 - cover, 1.0 - cover + 0.22, cells);
  float wake = ripIn * max(lace * clamp(R.a*0.9, 0.0, 0.95), smoothstep(0.3, 0.7, length(R.yz))*0.4);
  float shoreD = max(P.y - bedStraight.y, 0.0);
  float shore = smoothstep(0.45, 0.05, shoreD) * (0.55 + 0.45*sin(uTime*1.3 - shoreD*14.0 + foamN*4.0));
  shore *= smoothstep(0.35, 0.7, foamN);
  // wind-driven whitecaps on the steepest crests
  float capCover = uWhitecaps*smoothstep(0.35, 0.95, vCrest + 0.35*(cells - 0.5));
  float caps = smoothstep(1.0 - capCover, 1.0 - capCover + 0.18, vnoise(P.xz*2.2 + uTime*0.5)*0.5 + cells*0.5);
  float foam = clamp(max(max(wake, shore*0.8), caps*0.9), 0.0, 1.0);
  vec3 foamCol = 1.15/PI*(uSunRad*max(dot(n, uSunDir), 0.0)*0.9 + uSunRad*0.12 + uSkyIrr*1.6);
  col = mix(col, foamCol, foam*0.85);

  // soften the waterline where the water is only a few centimetres thick
  vec3 dry = texture(uSceneColor, suv).rgb;
  col = mix(dry, col, smoothstep(0.0, 0.12, shoreD));

  // aerial haze (matches three.js FogExp2 on the rest of the scene)
  // far away the haze takes the colour of the sky just above the horizon (from the reflection),
  // so the sea melts into the sky whatever the sun does
  float fogF = 1.0 - exp(-uFogDensity*uFogDensity*dist*dist);
  vec3 horizonSky = texture(uRefl, vec2(clamp(rUV0.x, 0.001, 0.999), clamp(rUV0.y, 0.001, 0.999)), 2.0).rgb;
  vec3 hazeC = mix(uFogColor, horizonSky, smoothstep(600.0, 4000.0, dist));
  col = mix(col, hazeC, fogF);

  if (uView == 1) col = n*0.5 + 0.5;
  else if (uView == 3) col = refl;
  else if (uView == 4) col = vec3(1.0 - exp(-s*0.15), 1.0 - exp(-depthHere*0.2), 0.0);
  else if (uView == 5) col = vec3(0.5 + R.x*6.0, 0.5 + R.y*2.0, 0.5 + R.z*2.0) * ripIn;
  else if (uView == 6) col = vec3(0.5 + A.x*4.0, 0.5 + A.y*3.0, 0.5 + A.z*3.0);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

function radialGrid(rings: number, segments: number, first: number, growth: number): THREE.BufferGeometry {
  const radii = [0];
  let r = 0, step = first;
  for (let i = 0; i < rings; i++) { r += step; step *= growth; radii.push(r); }
  const verts: number[] = [0, 0, 0];
  for (let i = 1; i < radii.length; i++)
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      verts.push(Math.cos(a) * radii[i], 0, Math.sin(a) * radii[i]);
    }
  const idx: number[] = [];
  for (let j = 0; j < segments; j++) idx.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 1; i < radii.length - 1; i++) {
    const a0 = 1 + (i - 1) * segments, b0 = 1 + i * segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  return g;
}

export class WaterSurface {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(waves: WaveField, surface: THREE.Texture, L: number) {
    this.uniforms = {
      uGridCenter: { value: new THREE.Vector2() },
      uSurf: { value: surface },
      uRip: { value: null },
      uL: { value: L },
      uRipSize: { value: 1 },
      uRipCenter: { value: new THREE.Vector2() },
      uWaveA: { value: waves.uniformA },
      uWaveB: { value: waves.uniformB },
      uWaveTime: { value: 0 },
      uRefl: { value: null },
      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uViewProj: { value: new THREE.Matrix4() },
      uInvViewProj: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCamFwd: { value: new THREE.Vector3() },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRad: { value: new THREE.Vector3(6, 5.4, 4.4) },
      uSkyIrr: { value: new THREE.Vector3(0.43, 0.48, 0.54) },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.001 },
      uTime: { value: 0 },
      uView: { value: 0 },
      uChop: { value: 1 },
      uWhitecaps: { value: 0 },
      uRain: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
    });
    // dense near the camera (0.35 m), ~27 km out so the edge is always past the horizon
    this.mesh = new THREE.Mesh(radialGrid(262, 320, 0.35, 1.03), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'water';
  }

  followCamera(cam: THREE.Camera): void {
    const c = cam.position;
    this.uniforms.uGridCenter.value.set(Math.round(c.x), Math.round(c.z));
  }
}
