import * as THREE from 'three';

/*
 * Spray: a small pool of droplets thrown up where something breaks the surface (a leaping dolphin), falling
 * back under gravity and fading. One Points draw call; droplets write depth (round, alpha-tested) so the
 * water surface — composited later from the scene depth — sits correctly behind the ones in the air.
 */

const MAX = 400;

export class Splash {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly attrLife: THREE.BufferAttribute;
  private next = 0;
  private readonly uniforms = { uLight: { value: new THREE.Vector3(1, 1, 1) }, uScale: { value: 400 } };

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.attrLife = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aLife', this.attrLife);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
uniform float uScale;
attribute float aLife;
varying float vLife;
void main(){
  vLife = aLife;
  vec4 mv = modelViewMatrix*vec4(position, 1.0);
  gl_Position = projectionMatrix*mv;
  // a few cm, growing a little as the drop spreads; nothing when dead
  gl_PointSize = aLife > 0.0 ? uScale*(0.035 + 0.03*(1.0 - aLife))/max(-mv.z, 0.1) : 0.0;
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uLight;
varying float vLife;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25 || vLife <= 0.0) discard;
  gl_FragColor = vec4(uLight*(0.75 + 0.25*vLife), 1.0);
}`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.name = 'splash';
  }

  /** throw `count` droplets from (x, y, z), `power` m/s upward-ish, spread sideways, carried along by `drift` */
  burst(x: number, y: number, z: number, count: number, power: number, drift?: { x: number; z: number }): void {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2, s = Math.random() * power * 0.45;
      this.pos[i * 3] = x + Math.cos(a) * 0.2; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z + Math.sin(a) * 0.2;
      this.vel[i * 3] = Math.cos(a) * s + (drift?.x ?? 0) * 0.6;
      this.vel[i * 3 + 1] = power * (0.4 + 0.6 * Math.random());
      this.vel[i * 3 + 2] = Math.sin(a) * s + (drift?.z ?? 0) * 0.6;
      this.life[i] = 1;
    }
  }

  /** `light`: rough radiance of a white droplet (sun + sky), `height` of the pixel scale (px) */
  update(dt: number, light: THREE.Vector3, viewportHeight: number, fovDeg: number): void {
    this.uniforms.uLight.value.copy(light);
    this.uniforms.uScale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    let alive = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      alive = true;
      this.vel[i * 3 + 1] -= 9.81 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.life[i] -= dt * 0.9;
      if (this.pos[i * 3 + 1] < -0.1) this.life[i] = 0; // back in the sea
    }
    this.points.visible = alive;
    if (alive) {
      (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.attrLife.needsUpdate = true;
    }
  }
}
