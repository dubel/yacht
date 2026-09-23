import * as THREE from 'three';
import { WATER_OPTICS_GLSL } from './optics';
import { CLOUD_SHADOW_GLSL, cloudShadowUniforms } from '../../environment/Clouds';

/**
 * Shared shader patch for any lit surface that can be under water (seabed, hull, buoys):
 * sunlight is Fresnel-transmitted, attenuated along the refracted sun path and focused into
 * caustics; sky light is attenuated; aerial fog is suppressed below the surface (the water
 * shader / underwater pass applies the water's own extinction instead).
 */
export const underwaterUniforms = {
  uCaus: { value: null as THREE.Texture | null },
  uCausShift: { value: new THREE.Vector2() },
  uCausPatch: { value: 7 },
  uCausDepth: { value: 1.9 },
  uSunW: { value: new THREE.Vector3(0, 1, 0) },
};

export function patchUnderwater(sh: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(sh.uniforms, underwaterUniforms, cloudShadowUniforms);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
varying vec3 vWPos;
uniform sampler2D uCaus;
uniform vec2 uCausShift;
uniform float uCausPatch, uCausDepth;
uniform vec3 uSunW;
${WATER_OPTICS_GLSL}
${CLOUD_SHADOW_GLSL}
`,
    )
    .replace(
      '#include <lights_fragment_end>',
      /* glsl */ `#include <lights_fragment_end>
{
  // cloud shadows
  float cs = cloudShadow(vWPos);
  reflectedLight.directDiffuse *= cs;
  reflectedLight.directSpecular *= cs;
  float d = max(-vWPos.y, 0.0);
  float uw = smoothstep(0.12, -0.12, vWPos.y);
  vec3 sunT = refract(-uSunW, vec3(0,1,0), 1.0/WATER_IOR);
  float cosT = max(-sunT.y, 0.2);
  vec2 cuv = (vWPos.xz - uCausShift*(d/uCausDepth))/uCausPatch;
  vec3 caus = texture(uCaus, cuv, 0.5 + 1.2*smoothstep(3.0, 12.0, d)).rgb;
  float focus = smoothstep(0.0, 1.4, d) * mix(1.0, 0.45, smoothstep(3.0, 14.0, d));
  caus = mix(vec3(1.0), caus, focus);
  vec3 Tsun = exp(-WATER_SIG_T*d/cosT) * (1.0 - fresnelDielectric(uSunW.y, WATER_IOR));
  reflectedLight.directDiffuse *= mix(vec3(1.0), Tsun*caus, uw);
  reflectedLight.directSpecular *= mix(vec3(1.0), Tsun*0.3, uw);
  // under water almost all ambient light comes from above: surfaces facing down only get the weak upwelling
  float upFacing = (vec4(normal, 0.0)*viewMatrix).y;
  float upwell = mix(0.18, 1.0, smoothstep(-0.6, 0.6, upFacing));
  reflectedLight.indirectDiffuse *= mix(vec3(1.0), exp(-(WATER_SIG_A + 0.4*WATER_SIG_S)*d*1.25)*upwell, uw);
  reflectedLight.indirectSpecular *= 1.0 - 0.9*uw;
}`,
    )
    .replace(
      '#include <fog_fragment>',
      /* glsl */ `#ifdef USE_FOG
  float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogF * smoothstep(-0.3, 0.2, vWPos.y) );
#endif`,
    );
}
