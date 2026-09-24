import * as THREE from 'three';
import { patchUnderwater } from '../render/water/underwaterLight';
import { terrainHeight } from '../world/WorldGen';

/*
 * Reef fish in the shallows. Schools of 10–40 wander over sand and coral 1.6–6.5 m deep, keep a little
 * above the bottom, and scatter when a hull passes over them. They only exist within ~250 m of the boat
 * (spawned on shallow ground, dropped behind), fewer at night. Everything is one instanced mesh — one
 * draw call — of a ~100-triangle fish: the tail beat is a wave down the body in the vertex shader (its
 * phase advanced on the CPU from each fish's speed), and the four species' markings are painted in the
 * fragment shader. They are ordinary scene geometry under the surface, so the water shows them refracted
 * and fading with depth like the seabed, lit by the same caustics.
 */

const MAX_FISH = 420;
const MAX_SCHOOLS = 11;
const RANGE = 250;
const MIN_DEPTH = -6.5, MAX_DEPTH = -1.6;

/** blue tang, yellow tang, sergeant major, parrotfish */
const SPECIES = [
  // (a little bigger than life, so they read from the deck)
  { size: [0.26, 0.38], n: [10, 24], speed: 0.9 },
  { size: [0.19, 0.28], n: [14, 30], speed: 0.8 },
  { size: [0.17, 0.24], n: [18, 40], speed: 1.0 },
  { size: [0.45, 0.7], n: [4, 9], speed: 0.6 },
];

/** a fish 1 m long along +z (head at +0.5), flattened sideways, with tail and dorsal fins */
function fishGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const ring = 8, segs = 9;
  // body profile: height and width along the length (0 = snout … 1 = tail root)
  const H = (s: number) => 0.3 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.92 + 0.06)), 0.8) * (1 - 0.55 * s * s);
  const W = (s: number) => H(s) * 0.38;
  const at = (s: number, a: number) => [Math.cos(a) * W(s), Math.sin(a) * H(s) * 0.5, 0.5 - s * 0.82];
  for (let i = 0; i < segs; i++)
    for (let k = 0; k < ring; k++) {
      const s0 = i / segs, s1 = (i + 1) / segs, a0 = (k / ring) * Math.PI * 2, a1 = ((k + 1) / ring) * Math.PI * 2;
      const p00 = at(s0, a0), p01 = at(s0, a1), p10 = at(s1, a0), p11 = at(s1, a1);
      pos.push(...p00, ...p10, ...p01, ...p01, ...p10, ...p11);
    }
  // tail fin (a forked V) and dorsal fin
  const tz = 0.5 - 0.82;
  pos.push(0, 0, tz + 0.02, 0, 0.16, tz - 0.2, 0, 0.02, tz - 0.12);
  pos.push(0, 0, tz + 0.02, 0, -0.02, tz - 0.12, 0, -0.16, tz - 0.2);
  pos.push(0, 0.14, 0.2, 0, 0.13, -0.22, 0, 0.23, -0.12);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

interface Fish {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** place in the school, rotating slowly around its centre */
  off: THREE.Vector3;
  scale: number;
  phase: number;
  yaw: number;
  /** seabed height under the fish (+ clearance), refreshed every few frames */
  floor: number;
}

interface School {
  species: number;
  center: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  speed: number;
  flee: number;
  spin: number;
  fish: Fish[];
}

export class FishLife {
  readonly mesh: THREE.InstancedMesh;
  private readonly swim: THREE.InstancedBufferAttribute;
  private readonly schools: School[] = [];
  private spawnT = 0;
  private frame = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly s = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor() {
    const geo = fishGeometry();
    // per fish: tail-beat phase (rad), beat amplitude, species
    this.swim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH * 3), 3);
    this.swim.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSwim', this.swim);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      patchUnderwater(sh);
      // the shared patch places vWPos without the instance transform
      sh.vertexShader = sh.vertexShader
        .replace('vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;', 'vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;')
        .replace('#include <common>', '#include <common>\nattribute vec3 aSwim;\nvarying vec3 vLocal;\nvarying float vSpecies;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
vLocal = position;
vSpecies = aSwim.z;
// tail beat: a travelling wave that grows toward the tail
float tail = clamp((0.35 - position.z)/0.85, 0.0, 1.0);
transformed.x += sin(aSwim.x - position.z*7.0) * aSwim.y * (0.02 + 0.16*tail*tail);`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;\nvarying float vSpecies;')
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
{
  vec3 p = vLocal;
  float sp = floor(vSpecies + 0.5);
  float tailFin = step(p.z, -0.33);
  vec3 c;
  if (sp < 0.5) {        // blue tang: royal blue, black sweep along the back, yellow tail
    c = vec3(0.02, 0.12, 0.62);
    float band = smoothstep(0.03, 0.0, abs(p.y - 0.05 - 0.12*sin(p.z*4.0 + 1.0)) - 0.025);
    c = mix(c, vec3(0.01), band);
    c = mix(c, vec3(0.95, 0.75, 0.05), tailFin);
  } else if (sp < 1.5) { // yellow tang
    c = vec3(0.98, 0.78, 0.04);
  } else if (sp < 2.5) { // sergeant major: silvery yellow, five black bars
    c = mix(vec3(0.75, 0.78, 0.7), vec3(0.9, 0.82, 0.25), smoothstep(-0.02, 0.1, p.y));
    c = mix(c, vec3(0.03), step(0.62, fract(p.z*5.2 + 0.3)) * (1.0 - tailFin));
  } else {               // parrotfish: sea green with pink patches
    c = vec3(0.1, 0.62, 0.52);
    c = mix(c, vec3(0.9, 0.45, 0.55), smoothstep(0.55, 0.75, fract(p.z*9.0 + p.y*5.0)) * 0.7);
  }
  // countershading: dark back (what one sees from the deck against the sand), pale belly
  c *= mix(1.0, 0.35, smoothstep(0.02, 0.13, p.y));
  c = mix(c, c*0.4 + vec3(0.55), smoothstep(0.0, -0.1, p.y) * 0.6);
  // fins are thin and translucent: darker, less saturated than the body
  if (abs(p.x) < 0.001) c = mix(c, vec3(dot(c, vec3(0.33))), 0.4) * 0.6;
  diffuseColor.rgb = c;
}`,
        );
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_FISH);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // schools move every frame; drawing a few hundred small fish is cheap
    // their shadows on the sand give a school away from the deck (only inside the boat's shadow map)
    this.mesh.castShadow = true;
    this.mesh.name = 'fish';
  }

  get count(): number {
    return this.mesh.count;
  }

  private static depthOk(x: number, z: number): boolean {
    const h = terrainHeight(x, z);
    return h > MIN_DEPTH && h < MAX_DEPTH;
  }

  private spawn(focus: THREE.Vector3): void {
    for (let tries = 0; tries < 10; tries++) {
      const a = Math.random() * Math.PI * 2, r = 25 + Math.random() * (RANGE - 40);
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      if (!FishLife.depthOk(x, z)) continue;
      const species = Math.floor(Math.random() * SPECIES.length);
      const S = SPECIES[species];
      const n = Math.round(S.n[0] + Math.random() * (S.n[1] - S.n[0]));
      if (this.fishTotal() + n > MAX_FISH) return;
      const bed = terrainHeight(x, z);
      const center = new THREE.Vector3(x, Math.min(bed + 1.2, -0.6), z);
      const spread = 1.2 + n * 0.08;
      const fish: Fish[] = [];
      for (let k = 0; k < n; k++) {
        const off = new THREE.Vector3((Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 2 * spread);
        fish.push({
          pos: center.clone().add(off), vel: new THREE.Vector3(), off,
          scale: S.size[0] + Math.random() * (S.size[1] - S.size[0]), phase: Math.random() * 10, yaw: Math.random() * 6.3, floor: bed + 0.25,
        });
      }
      this.schools.push({ species, center, vel: new THREE.Vector3(), target: center.clone(), speed: S.speed, flee: 0, spin: (Math.random() - 0.5) * 0.2, fish });
      return;
    }
  }

  private fishTotal(): number {
    let n = 0;
    for (const s of this.schools) n += s.fish.length;
    return n;
  }

  /** once per frame: `boat` = hull position, `daylight` 0…1 */
  update(dt: number, focus: THREE.Vector3, boat: THREE.Vector3, daylight: number): void {
    dt = Math.min(dt, 0.1);
    // keep schools around the boat: drop far ones, add new ones on shallow ground
    for (let i = this.schools.length - 1; i >= 0; i--)
      if (Math.hypot(this.schools[i].center.x - focus.x, this.schools[i].center.z - focus.z) > RANGE + 40) this.schools.splice(i, 1);
    this.spawnT -= dt;
    const want = Math.round(MAX_SCHOOLS * (0.35 + 0.65 * daylight));
    if (this.spawnT <= 0 && this.schools.length < want) { this.spawnT = 0.15; this.spawn(focus); }

    let n = 0;
    const arr = this.swim.array as Float32Array;
    this.frame++;
    for (const sc of this.schools) {
      // ---- the school: wander between points on shallow ground, bolt from a passing hull ----
      const toBoat = Math.hypot(sc.center.x - boat.x, sc.center.z - boat.z);
      if (toBoat < 11 && sc.flee <= 0) {
        sc.flee = 3;
        const ax = sc.center.x - boat.x, az = sc.center.z - boat.z, l = Math.hypot(ax, az) || 1;
        sc.target.set(sc.center.x + (ax / l) * 22, sc.center.y, sc.center.z + (az / l) * 22);
      }
      sc.flee -= dt;
      if (sc.center.distanceTo(sc.target) < 2 || (sc.flee <= 0 && Math.random() < dt * 0.05)) {
        for (let t = 0; t < 6; t++) {
          const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 20;
          const x = sc.center.x + Math.cos(a) * r, z = sc.center.z + Math.sin(a) * r;
          if (FishLife.depthOk(x, z)) { sc.target.set(x, 0, z); break; }
        }
      }
      const speed = sc.speed * (sc.flee > 0 ? 3.2 : 1);
      this.tmp.subVectors(sc.target, sc.center).setY(0);
      const dl = this.tmp.length();
      if (dl > 0.01) this.tmp.multiplyScalar(speed / dl);
      sc.vel.lerp(this.tmp, 1 - Math.exp(-dt * (sc.flee > 0 ? 4 : 0.8)));
      sc.center.addScaledVector(sc.vel, dt);
      const bed = terrainHeight(sc.center.x, sc.center.z);
      sc.center.y += (Math.min(bed + 1.3, -0.7) - sc.center.y) * (1 - Math.exp(-dt * 1.5));
      // the formation turns slowly
      const cs = Math.cos(sc.spin * dt), sn = Math.sin(sc.spin * dt);

      // ---- each fish: spring toward its place, a little jitter, beat the tail with its speed ----
      const S = SPECIES[sc.species];
      for (const f of sc.fish) {
        const ox = f.off.x * cs - f.off.z * sn; f.off.z = f.off.x * sn + f.off.z * cs; f.off.x = ox;
        const k = sc.flee > 0 ? 5 : 1.6;
        f.vel.x += ((sc.center.x + f.off.x - f.pos.x) * k - f.vel.x * 1.8 + (Math.random() - 0.5) * 0.8) * dt;
        f.vel.y += ((sc.center.y + f.off.y - f.pos.y) * k - f.vel.y * 2.5) * dt;
        f.vel.z += ((sc.center.z + f.off.z - f.pos.z) * k - f.vel.z * 1.8 + (Math.random() - 0.5) * 0.8) * dt;
        f.pos.addScaledVector(f.vel, dt);
        // the seabed under a fish changes slowly: look it up for a quarter of them each frame
        if ((n + this.frame) % 4 === 0) f.floor = terrainHeight(f.pos.x, f.pos.z) + 0.25;
        if (f.pos.y < f.floor) f.pos.y = f.floor;
        if (f.pos.y > -0.25) f.pos.y = -0.25;
        const v = Math.hypot(f.vel.x, f.vel.z);
        if (v > 0.05) {
          let d = Math.atan2(f.vel.x, f.vel.z) - f.yaw;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          f.yaw += d * (1 - Math.exp(-dt * 6));
        }
        f.phase += dt * (5 + v * 9 / Math.max(0.2, f.scale * 3));
        this.e.set(-Math.atan2(f.vel.y, Math.max(v, 0.05)) * 0.6, f.yaw, 0);
        this.q.setFromEuler(this.e);
        this.s.setScalar(f.scale);
        this.m.compose(f.pos, this.q, this.s);
        this.mesh.setMatrixAt(n, this.m);
        arr[n * 3] = f.phase;
        arr[n * 3 + 1] = 0.6 + Math.min(1.2, v / S.speed) * 0.6;
        arr[n * 3 + 2] = sc.species;
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.swim.needsUpdate = true;
  }
}
