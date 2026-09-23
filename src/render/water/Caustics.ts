import * as THREE from 'three';
import { makeRT } from '../gpu';

/*
 * Refracted-grid caustics with per-channel dispersion — ported from Clearwater (MIT, © 2026 Lumaris),
 * "Caustics" (itself after Evan Wallace's WebGL Water). A G×G grid of sun rays is refracted through
 * the FFT surface and splatted onto a flat floor; triangle area change = light density.
 *
 * Changes: the FFT field is re-tiled at `patch` metres (slopes are scale-invariant, so this is a
 * geometrically scaled copy of the surface) to get lagoon-sized caustic cells, and the result is
 * meant to be projected on real seabed geometry by the terrain shader.
 */
const IORS = [1.3315, 1.3335, 1.3365];

export class Caustics {
  readonly target: THREE.WebGLRenderTarget;
  /** lateral shift of the pattern for the flat-surface refracted sun direction (m, world xz) */
  readonly shift = new THREE.Vector2();
  readonly patch: number;
  readonly depth: number;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.RawShaderMaterial;

  constructor(private readonly renderer: THREE.WebGLRenderer, surface: THREE.Texture, fftL: number, grid: number, size: number, patch: number, depth: number) {
    this.patch = patch;
    this.depth = depth;
    this.target = makeRT(size, size, { wrap: THREE.RepeatWrapping, mipmaps: true, anisotropy: 8 });

    const G = grid;
    const pos = new Float32Array((G + 1) * (G + 1) * 2);
    let o = 0;
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) { pos[o++] = i / G; pos[o++] = j / G; }
    const idx = new Uint32Array(G * G * 6);
    o = 0;
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const a = j * (G + 1) + i, b = a + 1, c = a + G + 1, d = c + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
      }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aUV', new THREE.BufferAttribute(pos, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.instanceCount = 9; // 3×3 neighbouring tiles so displaced rays wrap seamlessly

    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: /* glsl */ `
precision highp float; precision highp sampler2D;
in vec2 aUV;
uniform sampler2D uSurf; uniform float uL, uHScale, uDepth, uIor; uniform vec3 uSun; uniform vec2 uShift;
out vec2 vSrc;
void main(){
  ivec2 off = ivec2(gl_InstanceID % 3 - 1, gl_InstanceID / 3 - 1);
  vec4 s = textureLod(uSurf, aUV, 0.0);
  vec3 n = normalize(vec3(-s.y, 1.0, -s.z));
  vec3 r = refract(-uSun, n, 1.0/uIor);
  float h = s.x*uHScale;
  vec3 P = vec3(aUV.x*uL, h, aUV.y*uL);
  vec3 F = P + r*((-uDepth - h)/r.y);
  vSrc = aUV*uL;
  vec2 c = (F.xz - uShift)/uL + vec2(off);
  gl_Position = vec4(c*2.0-1.0, 0.0, 1.0);
}`,
      fragmentShader: /* glsl */ `
precision highp float;
in vec2 vSrc; out vec4 o; uniform float uNorm; uniform vec4 uMask;
void main(){
  vec2 a = dFdx(vSrc), b = dFdy(vSrc);
  float area = abs(a.x*b.y - a.y*b.x);
  float I = min(area*uNorm, 40.0);
  o = uMask*I;
}`,
      uniforms: {
        uSurf: { value: surface },
        uL: { value: patch },
        uHScale: { value: patch / fftL },
        uDepth: { value: depth },
        uIor: { value: IORS[1] },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uShift: { value: this.shift },
        uNorm: { value: (size / patch) * (size / patch) },
        uMask: { value: new THREE.Vector4() },
      },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  update(sunDir: THREE.Vector3): void {
    const r = this.renderer;
    const u = this.mat.uniforms;
    u.uSun.value.copy(sunDir);
    // flat-surface refraction shift (green) keeps the pattern registered; per-channel residual = dispersion fringes
    const sy = Math.max(sunDir.y, 0.05), sinI = Math.sqrt(1 - sy * sy), sinT = sinI / IORS[1], cosT = Math.sqrt(1 - sinT * sinT);
    const hd = Math.hypot(sunDir.x, sunDir.z) || 1, tanT = sinT / cosT;
    this.shift.set((-sunDir.x / hd) * this.depth * tanT, (-sunDir.z / hd) * this.depth * tanT);

    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    const masks = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
    for (let c = 0; c < 3; c++) {
      u.uIor.value = IORS[c];
      u.uMask.value.fromArray(masks[c]);
      r.render(this.scene, this.camera);
    }
    r.autoClear = prevAuto;
  }
}
