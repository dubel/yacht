import * as THREE from 'three';
import type { WaveField } from '../environment/WaveField';
import { terrainHeight } from '../world/WorldGen';

/*
 * Gunnery: shots, balls in flight, smoke and flashes.
 *
 * A ball leaves the muzzle at SPEED along the barrel plus the boat's own velocity and flies a true
 * ballistic arc (gravity only — at these ranges drag would barely show), trailing a thread of smoke so the
 * arc can be followed. It ends in the sea (a column of spray, rings, a splash) or against an island (a
 * cloud of earth and sand, a thud) — reported through `onImpact`, which is also where the sound is made.
 *
 * Each discharge throws a short muzzle flash and a bank of powder smoke that billows out along the barrel,
 * slows, swells, rises and drifts downwind for several seconds. Smoke and flashes are camera-facing quads
 * drawn in the pipeline's late pass (after the water), so they sit over the sea correctly; they fade softly
 * where they meet the hull or the sails by comparing their depth with the scene's.
 *
 * Broadsides: the guns of one side go off in order, bow to stern, each a little late or early. One reload
 * time covers everything: RELOAD seconds from one broadside (or single shot) to the next.
 */

export const RELOAD = 1.5;
const SPEED = 95;
const MAX_BALLS = 32, MAX_SMOKE = 900, MAX_FLASH = 24;

interface Ball { pos: THREE.Vector3; vel: THREE.Vector3; age: number; trail: number }
interface Pending { at: number; shot: () => void }

const BILLBOARD_VERT = /* glsl */ `
attribute vec4 aP;   // xyz centre, w size (m)
attribute vec4 aC;   // x alpha, y shade, z rotation, w tint (0 smoke … 1 earth)
varying vec2 vUv;
varying vec4 vC;
varying float vZ;
void main(){
  vec4 mv = viewMatrix*vec4(aP.xyz, 1.0);
  float c = cos(aC.z), s = sin(aC.z);
  mv.xy += mat2(c, -s, s, c)*position.xy*aP.w;
  vZ = -mv.z;
  vUv = position.xy + 0.5;
  vC = aC;
  gl_Position = projectionMatrix*mv;
}`;

const SOFT_GLSL = /* glsl */ `
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform float uNear, uFar;
float sceneZ(){
  float d = texture(uDepth, gl_FragCoord.xy/uRes).x;
  float z = d*2.0 - 1.0;
  return 2.0*uNear*uFar/(uFar + uNear - z*(uFar - uNear));
}
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx)*0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), u.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), u.x), u.y); }
`;

class Billboards {
  readonly mesh: THREE.InstancedMesh;
  readonly p: Float32Array;
  readonly c: Float32Array;
  private readonly aP: THREE.InstancedBufferAttribute;
  private readonly aC: THREE.InstancedBufferAttribute;

  constructor(max: number, material: THREE.ShaderMaterial) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.p = new Float32Array(max * 4);
    this.c = new Float32Array(max * 4);
    this.aP = new THREE.InstancedBufferAttribute(this.p, 4).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.InstancedBufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aP', this.aP);
    geo.setAttribute('aC', this.aC);
    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  commit(n: number): void {
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.aP.needsUpdate = true;
    this.aC.needsUpdate = true;
  }
}

export class Artillery {
  /** cannonballs: ordinary scene geometry */
  readonly balls: THREE.InstancedMesh;
  /** smoke and flashes: for the pipeline's late pass */
  readonly late = new THREE.Group();
  /** a gun fired at this world position */
  onFire: ((x: number, y: number, z: number) => void) | null = null;
  /** a ball came down */
  onImpact: ((kind: 'land' | 'water', x: number, y: number, z: number) => void) | null = null;

  private readonly flying: Ball[] = [];
  private readonly pending: Pending[] = [];
  private readonly smoke: Billboards;
  private readonly flash: Billboards;
  // smoke particles: position, velocity, size, growth, life, lifetime, shade, spin, tint, opacity
  private readonly sp = new Float32Array(MAX_SMOKE * 3);
  private readonly sv = new Float32Array(MAX_SMOKE * 3);
  private readonly sd = new Float32Array(MAX_SMOKE * 8); // size, grow, life, max, shade, spin, tint, fall
  private readonly sa = new Float32Array(MAX_SMOKE);
  private sNext = 0;
  private readonly fl: { pos: THREE.Vector3; size: number; life: number }[] = [];
  private time = 0;
  private lastShot = -1e9;
  private readonly m = new THREE.Matrix4();
  private readonly n = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };
  private readonly smokeUniforms = {
    uDepth: { value: null as THREE.Texture | null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 1000 },
    uSun: { value: new THREE.Vector3(1, 1, 1) }, uSky: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  };

  constructor() {
    this.balls = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.55, metalness: 0.6 }), MAX_BALLS);
    this.balls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.balls.frustumCulled = false;
    this.balls.count = 0;
    this.balls.castShadow = true;
    this.balls.name = 'cannonballs';

    const smokeMat = new THREE.ShaderMaterial({
      uniforms: this.smokeUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: BILLBOARD_VERT,
      fragmentShader: SOFT_GLSL + /* glsl */ `
uniform vec3 uSun, uSky;
varying vec2 vUv;
varying vec4 vC;
varying float vZ;
void main(){
  vec2 d = vUv - 0.5;
  // a lumpy puff with no grid in it (value noise showed its square cells as a big puff faded — squares
  // turning with the quad): the rim is a few lobes as a function of angle, the inside a soft marbling
  float r = length(d), ang = atan(d.y, d.x + 1e-4), sd = vC.z*5.0;
  float lobes = 0.5 + 0.25*sin(ang*3.0 + sd) + 0.15*sin(ang*5.0 - sd*0.7) + 0.1*sin(ang*8.0 + sd*2.3);
  float edge = 0.27 + 0.14*lobes;
  float a = (1.0 - smoothstep(edge*0.3, edge, r)) * vC.x;
  a *= 0.82 + 0.18*sin(d.x*9.0 + sd)*sin(d.y*8.0 - sd*0.6);
  float n = lobes;
  a *= clamp((sceneZ() - vZ)/1.2, 0.0, 1.0);  // soft where it meets the hull, the sails, the land
  a *= smoothstep(0.6, 3.5, vZ);                // and thin right in front of the eye: smoke, not a grey wall
  if (!(a > 0.004)) discard; // (also catches NaN)
  // lit from above: sunlit, bright tops over grey, sky-lit undersides — the contrast that makes a bank of
  // powder smoke read against a bright sea; earth clouds are brown
  float top = smoothstep(-0.45, 0.4, d.y + 0.15*(n - 0.5));
  vec3 base = mix(vec3(0.8, 0.8, 0.82), vec3(0.55, 0.45, 0.33), vC.w) * vC.y;
  vec3 light = uSky*0.85 + uSun*(0.03 + 0.2*top);
  gl_FragColor = vec4(base*light, min(1.0, a*1.35));
}`,
    });
    const flashMat = new THREE.ShaderMaterial({
      uniforms: this.smokeUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: BILLBOARD_VERT,
      fragmentShader: SOFT_GLSL + /* glsl */ `
varying vec2 vUv;
varying vec4 vC;
varying float vZ;
void main(){
  vec2 d = vUv - 0.5;
  float r = length(d)*2.0;
  // (atan(0, 0) is NaN on some GPUs: a black hole in the middle of the flash)
  float star = 0.6 + 0.4*vn(vec2(atan(d.y, d.x + 1e-4)*3.0 + vC.z*10.0, 1.0));
  float a = (1.0 - smoothstep(0.0, star, r)) * vC.x * clamp((sceneZ() - vZ)/0.6, 0.0, 1.0);
  if (!(a > 0.0)) discard;
  gl_FragColor = vec4(vec3(1.0, 0.62, 0.25)*a*40.0, 1.0);
}`,
    });
    this.smoke = new Billboards(MAX_SMOKE, smokeMat);
    this.flash = new Billboards(MAX_FLASH, flashMat);
    this.late.add(this.smoke.mesh, this.flash.mesh);
    this.late.name = 'gun smoke';
  }

  /** seconds until the guns can fire again */
  get reloading(): number {
    return Math.max(0, RELOAD - (this.time - this.lastShot));
  }

  /** fire one gun: `muzzle` and `dir` in world space, the boat's velocity added to the ball's */
  fire(muzzle: THREE.Vector3, dir: THREE.Vector3, boatVel: THREE.Vector3): boolean {
    if (this.reloading > 0) return false;
    this.lastShot = this.time;
    this.shoot(muzzle.clone(), dir.clone().normalize(), boatVel.clone());
    return true;
  }

  /** a broadside: `shots` in firing order, each a function giving that gun's muzzle and aim at the moment it fires */
  broadside(shots: (() => { muzzle: THREE.Vector3; dir: THREE.Vector3; vel: THREE.Vector3 })[]): boolean {
    if (this.reloading > 0 || !shots.length) return false;
    this.lastShot = this.time;
    shots.forEach((s, i) => {
      // ripple fire, not a drill-perfect salvo: 0.1–0.2 s apart, jittered
      const at = this.time + i * 0.13 + (Math.random() - 0.3) * 0.12;
      this.pending.push({ at: Math.max(this.time, at), shot: () => { const q = s(); this.shoot(q.muzzle, q.dir, q.vel); } });
    });
    return true;
  }

  private shoot(muzzle: THREE.Vector3, dir: THREE.Vector3, boatVel: THREE.Vector3): void {
    if (this.flying.length >= MAX_BALLS) this.flying.shift();
    this.flying.push({ pos: muzzle.clone().addScaledVector(dir, 0.3), vel: dir.clone().multiplyScalar(SPEED).add(boatVel), age: 0, trail: 0 });
    this.fl.push({ pos: muzzle.clone().addScaledVector(dir, 0.5), size: 1.4 + Math.random() * 0.8, life: 1 });
    // the powder smoke: a bank thrown out along the barrel, plus a dark puff at the muzzle
    for (let k = 0; k < 26; k++) {
      const v = 4 + Math.random() * 24;
      this.puff(muzzle, dir.x * v + (Math.random() - 0.5) * 4, dir.y * v + Math.random() * 2, dir.z * v + (Math.random() - 0.5) * 4,
        1.0 + Math.random() * 0.9, 0.7 + Math.random() * 0.6, 7 + Math.random() * 5, 0.7 + Math.random() * 0.25, 0, 0.95);
    }
    for (let k = 0; k < 6; k++) this.puff(muzzle, dir.x * 2, 0.5, dir.z * 2, 0.6, 1.0, 1.4, 0.5, 0, 0.75);
    this.onFire?.(muzzle.x, muzzle.y, muzzle.z);
  }

  /** one billboard: `tint` 0 smoke … 1 earth, `fall` 0 buoyant smoke … 1 falls like water */
  private puff(at: THREE.Vector3, vx: number, vy: number, vz: number, size: number, grow: number, life: number, shade: number, tint: number, opacity: number, fall = 0): void {
    const i = this.sNext;
    this.sNext = (this.sNext + 1) % MAX_SMOKE;
    this.sp[i * 3] = at.x; this.sp[i * 3 + 1] = at.y; this.sp[i * 3 + 2] = at.z;
    this.sv[i * 3] = vx; this.sv[i * 3 + 1] = vy; this.sv[i * 3 + 2] = vz;
    const d = i * 8;
    this.sd[d] = size; this.sd[d + 1] = grow; this.sd[d + 2] = life; this.sd[d + 3] = life;
    this.sd[d + 4] = shade; this.sd[d + 5] = Math.random() * 6.28; this.sd[d + 6] = tint; this.sd[d + 7] = fall;
    this.sa[i] = opacity;
  }

  /**
   * Once per frame. `wind` (m/s, world xz) carries the smoke; `camera` / `depth` / `res` for the soft
   * edges; `sun`, `sky` light it.
   */
  update(dt: number, t: number, waves: WaveField, wind: { x: number; z: number }, camera: THREE.PerspectiveCamera,
    depth: THREE.Texture, res: THREE.Vector2, sun: THREE.Vector3, sky: THREE.Vector3): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].at <= this.time) { this.pending[i].shot(); this.pending.splice(i, 1); }

    // ---- balls ----
    const tmp = new THREE.Vector3();
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const b = this.flying[i];
      b.age += dt;
      b.vel.y -= 9.81 * dt;
      b.pos.addScaledVector(b.vel, dt);
      // a thread of smoke to follow the arc by (thinning out)
      b.trail += b.vel.length() * dt;
      if (b.trail > 5 && b.age < 2.5) { b.trail = 0; this.puff(b.pos, 0, 0.2, 0, 0.18, 0.35, 1.3, 0.95, 0, 0.3 * (1 - b.age / 2.5)); }
      const ground = terrainHeight(b.pos.x, b.pos.z);
      waves.sample(b.pos.x, b.pos.z, t, this.n);
      if (ground > this.n.height - 0.3 && b.pos.y < ground + 0.1) {
        // an island: earth and sand thrown up
        for (let k = 0; k < 16; k++) {
          const a = Math.random() * 6.28, v = 2 + Math.random() * 5;
          this.puff(tmp.set(b.pos.x, ground + 0.3, b.pos.z), Math.cos(a) * v, 3 + Math.random() * 7, Math.sin(a) * v, 0.8 + Math.random() * 0.8, 1.5 + Math.random() * 1.5, 2.5 + Math.random() * 2.5, 0.7 + Math.random() * 0.3, 1, 0.9, 0.35);
        }
        this.onImpact?.('land', b.pos.x, ground, b.pos.z);
        this.flying.splice(i, 1);
      } else if (b.pos.y < this.n.height) {
        // the sea: a white column of spray thrown up metres high and falling back, a ring of foam at its foot
        // (big enough to read a couple of hundred metres off; the droplets from Splash are for close by)
        tmp.set(b.pos.x, this.n.height + 0.3, b.pos.z);
        for (let k = 0; k < 14; k++) this.puff(tmp, (Math.random() - 0.5) * 2.5, 7 + Math.random() * 8, (Math.random() - 0.5) * 2.5, 0.6 + Math.random() * 0.6, 1.4 + Math.random(), 1.4 + Math.random() * 1.2, 1.3, 0, 0.9, 0.9);
        for (let k = 0; k < 6; k++) { const a = (k / 6) * 6.28; this.puff(tmp, Math.cos(a) * 3, 0.6, Math.sin(a) * 3, 1.2, 2.2, 2.4, 1.25, 0, 0.6, 0.2); }
        this.onImpact?.('water', b.pos.x, this.n.height, b.pos.z);
        this.flying.splice(i, 1);
      } else if (b.age > 10) this.flying.splice(i, 1);
    }
    this.flying.forEach((b, i) => this.balls.setMatrixAt(i, this.m.makeTranslation(b.pos.x, b.pos.y, b.pos.z)));
    this.balls.count = this.flying.length;
    this.balls.instanceMatrix.needsUpdate = true;

    // ---- smoke: slows, swells, rises, drifts downwind, thins out ----
    let n = 0;
    const P = this.smoke.p, C = this.smoke.c;
    const drag = Math.exp(-dt * 2.2);
    for (let i = 0; i < MAX_SMOKE; i++) {
      const d = i * 8;
      if (this.sd[d + 2] <= 0) continue;
      this.sd[d + 2] -= dt;
      // (a puff that has just run out is not drawn: a negative life would make pow() below NaN, and a NaN
      //  alpha paints the whole quad — the grey squares)
      if (this.sd[d + 2] <= 0) continue;
      const life = this.sd[d + 2] / this.sd[d + 3];
      this.sv[i * 3] = this.sv[i * 3] * drag + wind.x * (1 - drag);
      // smoke rises a little; spray and earth fall back (less drag on them)
      const fall = this.sd[d + 7];
      this.sv[i * 3 + 1] = this.sv[i * 3 + 1] * (drag + (1 - drag) * fall * 0.7) + 0.5 * (1 - drag) * (1 - fall) - 9.81 * fall * dt;
      this.sv[i * 3 + 2] = this.sv[i * 3 + 2] * drag + wind.z * (1 - drag);
      this.sp[i * 3] += this.sv[i * 3] * dt;
      this.sp[i * 3 + 1] += this.sv[i * 3 + 1] * dt;
      this.sp[i * 3 + 2] += this.sv[i * 3 + 2] * dt;
      // swell fast at first, then hardly at all; a gun's cloud is metres across, not tens
      this.sd[d] = Math.min(7, this.sd[d] + this.sd[d + 1] * dt * (0.2 + 1.3 * life * life));
      P[n * 4] = this.sp[i * 3]; P[n * 4 + 1] = this.sp[i * 3 + 1]; P[n * 4 + 2] = this.sp[i * 3 + 2]; P[n * 4 + 3] = this.sd[d];
      // fade in over the first moments, out with age
      C[n * 4] = this.sa[i] * Math.min(1, (1 - life) * 12) * Math.pow(life, 0.8);
      C[n * 4 + 1] = this.sd[d + 4];
      C[n * 4 + 2] = this.sd[d + 5] + (1 - life) * 0.15;
      C[n * 4 + 3] = this.sd[d + 6];
      n++;
    }
    this.smoke.commit(n);

    // ---- flashes: a few frames long ----
    let f = 0;
    const FP = this.flash.p, FC = this.flash.c;
    for (let i = this.fl.length - 1; i >= 0; i--) {
      const x = this.fl[i];
      x.life -= dt / 0.09;
      if (x.life <= 0) { this.fl.splice(i, 1); continue; }
      FP[f * 4] = x.pos.x; FP[f * 4 + 1] = x.pos.y; FP[f * 4 + 2] = x.pos.z; FP[f * 4 + 3] = x.size * (1.2 - 0.4 * x.life);
      FC[f * 4] = x.life; FC[f * 4 + 1] = 1; FC[f * 4 + 2] = i * 1.7; FC[f * 4 + 3] = 0;
      f++;
    }
    this.flash.commit(f);

    const u = this.smokeUniforms;
    u.uDepth.value = depth;
    u.uRes.value.copy(res);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uSun.value.copy(sun);
    u.uSky.value.copy(sky);
  }
}
