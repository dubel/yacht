import * as THREE from 'three';
import { passMaterial } from '../gpu';
import { GERSTNER_GLSL, type WaveField } from '../../environment/WaveField';
import { WATER_OPTICS_GLSL } from './optics';
import { underwaterUniforms } from './underwaterLight';

/*
 * Full-screen pass that turns the opaque scene colour into "seen through water" wherever the view ray
 * starts below the surface (decided per pixel from the near-plane point vs. the Gerstner surface, so a
 * half-submerged camera gets a proper split image):
 *   - extinction + single-scattered in-light along the ray (same σ as the water shader, Clearwater),
 *   - light shafts: the ray is marched through the caustics pattern projected along the refracted sun,
 *   - a slight refractive wobble.
 * Pixels that start above water are copied unchanged. The surface itself (seen from below) is drawn
 * afterwards by the water mesh's back faces.
 */
export class UnderwaterPass {
  readonly material: THREE.RawShaderMaterial;

  constructor(waves: WaveField) {
    this.material = passMaterial(
      /* glsl */ `
uniform sampler2D uScene, uDepth, uDepthWater, uCaus;
uniform mat4 uInvViewProj;
uniform vec3 uSunDir, uSunRad, uSkyIrr;
uniform vec2 uCausShift;
uniform float uCausPatch, uCausDepth, uTime;
${GERSTNER_GLSL}
${WATER_OPTICS_GLSL}
const float PI = 3.14159265359;

vec3 worldAt(vec2 uv, float d){ vec4 w = uInvViewProj*vec4(uv*2.0-1.0, d*2.0-1.0, 1.0); return w.xyz/w.w; }
float surfaceHeight(vec2 xz){
  vec2 p = xz;
  for (int i=0;i<3;i++) p = xz - gerstnerDisplace(p).xz;
  return gerstnerDisplace(p).y;
}

void main(){
  vec3 nearP = worldAt(vUv, 0.0);
  float hN = surfaceHeight(nearP.xz);
  float under = nearP.y - hN;
  if (under > 0.0) { o = texture(uScene, vUv); return; }

  // refractive wobble of everything seen through the water
  vec2 wob = vec2(sin(vUv.y*38.0 + uTime*1.7), cos(vUv.x*31.0 + uTime*1.3))*0.0016;
  vec2 uv = vUv + wob;
  // nearest of the opaque scene and the water surface (seen from below)
  float d = min(texture(uDepth, uv).x, texture(uDepthWater, uv).x);
  vec3 rd = normalize(worldAt(uv, 1.0) - nearP);
  float dist = d >= 0.99999 ? 400.0 : length(worldAt(uv, d) - nearP);
  vec3 col = texture(uScene, uv).rgb;

  vec3 sunT = refract(-uSunDir, vec3(0,1,0), 1.0/WATER_IOR);
  float cosT = max(-sunT.y, 0.2);
  float Ts = 1.0 - fresnelDielectric(uSunDir.y, WATER_IOR);
  float mu = dot(rd, -sunT);
  float g = 0.8; float ph = (1.0-g*g)/(4.0*PI*pow(1.0+g*g-2.0*g*mu, 1.5));

  // ambient in-scatter at the camera's depth (Clearwater's single-scatter estimate)
  float camDepth = max(hN - nearP.y, 0.0);
  float dMid = min(camDepth + 1.0, 6.0);
  vec3 Lmid = uSunRad*Ts*exp(-WATER_SIG_T*dMid/cosT)*(ph*0.18+0.03) + uSkyIrr*exp(-WATER_SIG_A*dMid*1.2)/(4.0*PI);
  vec3 Linf = WATER_SIG_S/WATER_SIG_T * Lmid * 3.2;
  vec3 Tv = exp(-WATER_SIG_T*dist);
  col = col*Tv + Linf*(1.0 - Tv);

  // light shafts: march the view ray, sample the caustic focus of the sunlight that reaches each point
  float L = min(dist, 36.0);
  const int N = 24;
  float stepL = L/float(N);
  // interleaved-gradient noise: less visible grain than white noise at 20 steps
  float jitter = fract(52.9829189*fract(dot(gl_FragCoord.xy + floor(fract(uTime*7.0)*16.0)*5.588, vec2(0.06711056, 0.00583715))));
  vec3 shafts = vec3(0.0);
  for (int i=0;i<N;i++){
    float t = (float(i) + jitter)*stepL;
    vec3 p = nearP + rd*t;
    float depth = -p.y;
    if (depth < 0.0) break;
    vec2 cuv = (p.xz - uCausShift*(depth/uCausDepth))/uCausPatch;
    float c = texture(uCaus, cuv, 2.0 + depth*0.15).g;
    vec3 sunHere = uSunRad*Ts*exp(-WATER_SIG_T*depth/cosT);
    shafts += sunHere * max(c - 0.4, 0.0) * exp(-WATER_SIG_T*t) * stepL;
  }
  col += min(shafts * WATER_SIG_S * ph * 4.0, vec3(6.0));

  // meniscus: the surface line right at the lens
  col *= 1.0 - 0.6*smoothstep(-0.04, 0.0, under);
  o = vec4(col, 1.0);
}`,
      {
        uScene: { value: null },
        uDepth: { value: null },
        uDepthWater: { value: null },
        uCaus: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uSunDir: { value: new THREE.Vector3() },
        uSunRad: { value: new THREE.Vector3() },
        uSkyIrr: { value: new THREE.Vector3(0.43, 0.48, 0.54) },
        uCausShift: underwaterUniforms.uCausShift,
        uCausPatch: underwaterUniforms.uCausPatch,
        uCausDepth: underwaterUniforms.uCausDepth,
        uTime: { value: 0 },
        uWaveA: { value: waves.uniformA },
        uWaveB: { value: waves.uniformB },
        uWaveTime: { value: 0 },
      },
    );
  }
}
