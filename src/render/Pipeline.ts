import * as THREE from 'three';
import { Blitter, makeRT, passMaterial } from './gpu';
import { PostProcessor } from './PostProcessor';
import type { WaterSurface } from './water/WaterSurface';
import type { UnderwaterPass } from './water/UnderwaterPass';

/**
 * Frame: opaque scene (MSAA, HDR + depth) → planar reflection (mirror camera, clipped at y=0)
 * → composite = scene colour + water mesh (samples scene colour/depth for refraction & thickness)
 * → post (bloom, ACES, grade) → canvas.
 */
export class Pipeline {
  readonly post: PostProcessor;
  width = 1;
  height = 1;
  reflectionScale = 0.5;
  private warnedMirror = false;

  private sceneRT!: THREE.WebGLRenderTarget;
  private compRT!: THREE.WebGLRenderTarget;
  private reflRT!: THREE.WebGLRenderTarget;
  private finalRT!: THREE.WebGLRenderTarget;
  private readonly copyMat = passMaterial(`uniform sampler2D uSrc; void main(){ o = texture(uSrc, vUv); }`, { uSrc: { value: null } });
  private readonly mirrorCam = new THREE.PerspectiveCamera();
  private readonly waterScene = new THREE.Scene();
  private readonly clipPlane = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.08)];
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpT = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly blit: Blitter,
    private readonly scene: THREE.Scene,
    private readonly water: WaterSurface,
    private readonly underwater: UnderwaterPass,
  ) {
    this.post = new PostProcessor(blit);
    this.waterScene.add(water.mesh);
  }

  setSize(w: number, h: number): void {
    if (w === this.width && h === this.height && this.sceneRT) return;
    this.width = w;
    this.height = h;
    this.sceneRT?.dispose();
    this.compRT?.dispose();
    this.reflRT?.dispose();
    this.finalRT?.dispose();
    this.sceneRT = makeRT(w, h, { depth: true, samples: 4 });
    this.sceneRT.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.compRT = makeRT(w, h, { depth: true });
    this.compRT.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.finalRT = makeRT(w, h);
    this.reflRT = makeRT(Math.max(1, Math.round(w * this.reflectionScale)), Math.max(1, Math.round(h * this.reflectionScale)), { depth: true });
    this.post.setSize(w, h);
  }

  get sceneTarget() { return this.sceneRT; }
  get reflectionTarget() { return this.reflRT; }

  private updateMirror(cam: THREE.PerspectiveCamera): void {
    // after THREE.Reflector: reflect position, look-at target and up across the plane y = 0
    const n = new THREE.Vector3(0, 1, 0);
    const camPos = this.tmpV.setFromMatrixPosition(cam.matrixWorld);
    const rot = this.tmpM.extractRotation(cam.matrixWorld);
    const look = this.tmpT.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    const m = this.mirrorCam;
    m.position.set(camPos.x, -camPos.y, camPos.z);
    m.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    m.lookAt(look.x, -look.y, look.z);
    m.near = cam.near;
    m.far = cam.far;
    m.updateMatrixWorld();
    m.projectionMatrix.copy(cam.projectionMatrix);
    m.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    m.matrixWorldInverse.copy(m.matrixWorld).invert();
  }

  /**
   * @param submerged how far the camera is below the (Gerstner) surface, m; > -1 means the lens may touch water
   */
  render(cam: THREE.PerspectiveCamera, time: number, view: string, caustics: THREE.Texture, submerged: number): void {
    const r = this.renderer;
    r.autoClear = false;

    // 1. opaque world
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(this.scene, cam);

    // 2. planar reflection (nothing reflects the world when we are well under the surface)
    this.updateMirror(cam);
    // belt and braces for Game.resize(): never feed a non-finite camera to the clipped reflection render
    const finite = (m: THREE.Matrix4) => m.elements.every(Number.isFinite);
    const mirrorOk = finite(this.mirrorCam.matrixWorldInverse) && finite(cam.projectionMatrix);
    if (!mirrorOk && !this.warnedMirror) {
      this.warnedMirror = true;
      console.warn('reflection skipped: non-finite camera', JSON.stringify({ time, q: cam.quaternion.toArray(), scale: cam.scale.toArray(), rot: cam.rotation.toArray(), up: cam.up.toArray(), submerged }));
    }
    if (submerged < 1.5 && mirrorOk) {
      r.setRenderTarget(this.reflRT);
      r.clear(true, true, false);
      r.clippingPlanes = this.clipPlane;
      r.render(this.scene, this.mirrorCam);
      r.clippingPlanes = [];
    }

    // 3. composite: copy scene colour, then the water mesh on top
    const u = this.water.uniforms;
    u.uSceneColor.value = this.sceneRT.texture;
    u.uSceneDepth.value = this.sceneRT.depthTexture;
    u.uRefl.value = this.reflRT.texture;
    u.uReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(this.mirrorCam.projectionMatrix).multiply(this.mirrorCam.matrixWorldInverse);
    u.uViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    u.uInvViewProj.value.copy(u.uViewProj.value).invert();
    u.uResolution.value.set(this.width, this.height);
    cam.getWorldDirection(u.uCamFwd.value);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    this.water.followCamera(cam);

    this.copyMat.uniforms.uSrc.value = this.sceneRT.texture;
    this.blit.run(this.copyMat, this.compRT);
    r.setRenderTarget(this.compRT);
    r.clear(false, true, false);
    r.render(this.waterScene, cam);

    // 4. when the lens may be under water: extinction, in-scatter and light shafts along every view ray that
    //    starts below the surface — applied last, over both the scene and the surface seen from below,
    //    so everything gets the same water column
    let hdr = this.compRT.texture;
    if (submerged > -1.2) {
      const uw = this.underwater.material.uniforms;
      uw.uScene.value = this.compRT.texture;
      uw.uDepth.value = this.sceneRT.depthTexture;
      uw.uDepthWater.value = this.compRT.depthTexture;
      uw.uCaus.value = caustics;
      uw.uInvViewProj.value.copy(u.uInvViewProj.value);
      uw.uSunDir.value.copy(u.uSunDir.value);
      uw.uSunRad.value.copy(u.uSunRad.value);
      uw.uTime.value = time;
      uw.uWaveTime.value = u.uWaveTime.value;
      this.blit.run(this.underwater.material, this.finalRT);
      hdr = this.finalRT.texture;
    }

    // 5. post → canvas
    r.setRenderTarget(null);
    if (view === 'caustics') this.post.show(caustics, 0.25);
    else if (view === 'reflection') this.post.show(this.reflRT.texture, 0.3);
    else this.post.render(hdr, time);
  }
}
