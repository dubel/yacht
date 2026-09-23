import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/**
 * Sun + sky + image-based lighting. One sun direction drives the Preetham sky, the directional light,
 * the water glints and the caustics.
 *
 * Radiometric convention (matches Clearwater): directional light = (1, .9, .74) × 6 so an albedo-a
 * Lambert floor gets a/π·E. The Preetham sky is scaled into the same range.
 */
export class Environment {
  readonly sunDir = new THREE.Vector3();
  readonly sunColor = new THREE.Color();
  /** radiance scale for the sun used by glints (colour × intensity) */
  readonly sunRadiance = new THREE.Vector3();
  readonly sky: Sky;
  readonly light: THREE.DirectionalLight;
  readonly fogColor = new THREE.Color(0.6, 0.71, 0.82);
  fogDensity = 0.0011;

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private readonly skyScale = { value: 1.0 };

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.2;
    u.rayleigh.value = 1.1;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.cloudCoverage.value = 0.28;
    u.cloudDensity.value = 0.35;
    // Scale the Preetham radiance into our light units + keep it out of three's tone mapping
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      'gl_FragColor = vec4( texColor * uSkyScale, 1.0 );',
    ).replace('void main() {', 'uniform float uSkyScale;\nvoid main() {');
    u.uSkyScale = this.skyScale;
    this.sky.material.toneMapped = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);

    this.light = new THREE.DirectionalLight(0xffffff, 6);
    this.light.castShadow = true;
    const sc = this.light.shadow.camera;
    sc.left = sc.bottom = -24;
    sc.right = sc.top = 24;
    sc.near = 1;
    sc.far = 140;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.04;
    scene.add(this.light, this.light.target);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    const envSky = new Sky();
    envSky.material = this.sky.material; // share uniforms
    envSky.scale.setScalar(1000);
    this.envScene.add(envSky);
  }

  setSun(elevationDeg: number, azimuthDeg: number): void {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    // azimuth is a compass bearing: 0 = north (-Z), 90 = east (+X)
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);

    // warm, dimmer sun near the horizon (cheap air-mass approximation)
    const m = 1 / Math.max(Math.sin(el) + 0.15 * Math.pow(Math.max(el * 57.3 + 3.885, 0.01), -1.253), 0.02);
    const ext = [0.02, 0.045, 0.1].map((k) => Math.exp(-k * m * 1.2));
    this.sunColor.setRGB(ext[0] * 1.05, ext[1] * 0.97, ext[2] * 0.86);
    const I = 6 * THREE.MathUtils.smoothstep(el, -0.02, 0.06);
    this.light.color.copy(this.sunColor);
    this.light.intensity = I;
    this.sunRadiance.set(this.sunColor.r * I, this.sunColor.g * I, this.sunColor.b * I);

    this.refreshEnvironment();
    this.measureHorizon();
  }

  /** fog colour = average sky radiance a couple of degrees above the horizon, all around */
  private measureHorizon(): void {
    const W = 16, H = 4;
    this.horizonRT ??= new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false });
    const cam = new THREE.PerspectiveCamera(90, W / H, 0.1, 5000);
    const px = new Float32Array(W * H * 4);
    const acc = new THREE.Vector3();
    const r = this.renderer;
    const disc = this.sky.material.uniforms.showSunDisc;
    disc.value = 0;
    for (let i = 0; i < 4; i++) {
      cam.rotation.set(0.035, (i * Math.PI) / 2, 0, 'YXZ');
      cam.updateMatrixWorld();
      r.setRenderTarget(this.horizonRT);
      r.render(this.envScene, cam);
      r.readRenderTargetPixels(this.horizonRT, 0, 0, W, H, px);
      for (let j = 0; j < W * H; j++) acc.x += px[j * 4], acc.y += px[j * 4 + 1], acc.z += px[j * 4 + 2];
    }
    disc.value = 1;
    r.setRenderTarget(null);
    acc.multiplyScalar(1 / (4 * W * H));
    this.fogColor.setRGB(acc.x, acc.y, acc.z);
  }
  private horizonRT?: THREE.WebGLRenderTarget;

  /** re-bake the IBL cube from the current sky (call when the sun moves noticeably) */
  refreshEnvironment(): void {
    const prev = this.envRT;
    // the sun itself is lit by the directional light; keep the disc out of the IBL
    const disc = this.sky.material.uniforms.showSunDisc;
    disc.value = 0;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
    disc.value = 1;
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1.0;
    prev?.dispose();
  }

  update(time: number): void {
    this.sky.material.uniforms.time.value = time;
  }

  /** keep the shadow frustum around the focus point (the boat) */
  follow(focus: THREE.Vector3): void {
    this.light.target.position.copy(focus);
    this.light.position.copy(focus).addScaledVector(this.sunDir, 70);
    this.light.target.updateMatrixWorld();
    this.sky.position.copy(focus).setY(0);
  }
}
