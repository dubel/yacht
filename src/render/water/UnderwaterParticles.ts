import * as THREE from 'three';
import { WATER_OPTICS_GLSL } from './optics';

/**
 * Suspended matter around an underwater camera: a cube of points that wraps around the camera in world
 * space (so it stays put as you move), lit by the attenuated sun. Only rendered by the main camera
 * (layer 1 — the mirror camera never sees it) and only when the lens is near/below the surface.
 */
export class UnderwaterParticles {
  readonly points: THREE.Points;
  private readonly uniforms = {
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uSunRad: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSize: { value: 26 },
  };

  constructor(count = 2500) {
    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random();
      rnd[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
uniform vec3 uCam; uniform float uTime, uSize;
attribute float aRnd;
varying float vDepth, vFade, vRnd;
void main(){
  vec3 p = position*uSize + vec3(sin(uTime*0.13 + aRnd*40.0), sin(uTime*0.07 + aRnd*17.0)*0.6 + uTime*0.02, cos(uTime*0.11 + aRnd*23.0));
  vec3 base = uCam - uSize*0.5;
  vec3 w = base + mod(p - base, uSize);
  vDepth = -w.y;
  vRnd = aRnd;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  float d = -mv.z;
  vFade = smoothstep(uSize*0.5, uSize*0.25, length(w - uCam)) * smoothstep(0.25, 0.8, d);
  gl_PointSize = clamp((0.6 + 1.6*aRnd) * 90.0 / d, 1.0, 6.0);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uSunRad, uSunDir;
varying float vDepth, vFade, vRnd;
${WATER_OPTICS_GLSL}
void main(){
  if (vDepth < 0.05) discard;
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(c)) * vFade;
  vec3 sunT = refract(-uSunDir, vec3(0,1,0), 1.0/WATER_IOR);
  vec3 lit = uSunRad * exp(-WATER_SIG_T*vDepth/max(-sunT.y, 0.2)) * (0.008 + 0.025*vRnd);
  gl_FragColor = vec4(lit * a, 1.0);
}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(1);
    this.points.visible = false;
  }

  update(t: number, cam: THREE.Vector3, active: boolean, sunRad: THREE.Vector3, sunDir: THREE.Vector3): void {
    this.points.visible = active;
    if (!active) return;
    const u = this.uniforms;
    u.uCam.value.copy(cam);
    u.uTime.value = t;
    u.uSunRad.value.copy(sunRad);
    u.uSunDir.value.copy(sunDir);
  }
}
