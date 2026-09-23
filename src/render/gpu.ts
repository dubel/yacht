import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// Helpers for the raw GPGPU-style passes ported from Clearwater.

export const FS_VERT = /* glsl */ `
precision highp float;
in vec3 position; in vec2 uv;
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const FS_HEAD = /* glsl */ `
precision highp float; precision highp sampler2D; precision highp int;
in vec2 vUv; out vec4 o;
`;

export function passMaterial(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, unknown> = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FS_VERT,
    fragmentShader: FS_HEAD + frag,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
  });
}

export interface RTOptions {
  type?: THREE.TextureDataType;
  filter?: THREE.MagnificationTextureFilter;
  wrap?: THREE.Wrapping;
  mipmaps?: boolean;
  anisotropy?: number;
  depth?: boolean;
  samples?: number;
}

export function makeRT(w: number, h: number, o: RTOptions = {}): THREE.WebGLRenderTarget {
  const filter = o.filter ?? THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: o.type ?? THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    magFilter: filter,
    minFilter: o.mipmaps ? THREE.LinearMipmapLinearFilter : filter,
    wrapS: o.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: o.wrap ?? THREE.ClampToEdgeWrapping,
    generateMipmaps: !!o.mipmaps,
    anisotropy: o.anisotropy ?? 1,
    depthBuffer: !!o.depth,
    stencilBuffer: false,
    samples: o.samples ?? 0,
    colorSpace: THREE.NoColorSpace,
  });
  return rt;
}

/** one shared fullscreen triangle; swap the material per pass */
export class Blitter {
  private readonly quad = new FullScreenQuad();
  constructor(private readonly renderer: THREE.WebGLRenderer) {}
  run(material: THREE.Material, target: THREE.WebGLRenderTarget | null, viewport?: THREE.Vector4): void {
    const r = this.renderer;
    r.setRenderTarget(target);
    if (viewport) r.setViewport(viewport);
    this.quad.material = material;
    this.quad.render(r);
  }
  dispose() { this.quad.dispose(); }
}
