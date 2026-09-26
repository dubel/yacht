import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WaveField } from '../environment/WaveField';
import { patchUnderwater } from '../render/water/underwaterLight';
import { terrainHeight } from '../world/WorldGen';

/*
 * Dolphins. Every minute or two of sailing in water deep enough, a pod of 3–6 finds the boat: they close in
 * from a couple of hundred metres, then ride the bow wave — each in its own slot beside the stem, matching
 * the boat's speed, weaving — surfacing to breathe (a puff of spray, a blow you can hear) and now and then
 * leaping clear in an arc. After a minute or so they peel away and dive. A stopped boat is circled instead.
 *
 * One instanced mesh of a ~300-triangle bottlenose (dark back, pale belly, wet sheen); the body flexes up
 * and down — dolphins swim with vertical strokes — in the vertex shader, from a per-animal phase the CPU
 * advances with speed. Breaking the surface throws spray (Splash) and rings in the wake simulation.
 */

const MAX = 8;
const LEN = 2.4;

interface Dolphin {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** place beside the bow (boat frame: x to port, z forward from the stem), and its own weave */
  slot: THREE.Vector2;
  depth: number;
  phase: number;
  weave: number;
  /** vertical motion: 0 cruising, 1 breathing (a shallow roll at the surface), 2 airborne */
  mode: number;
  modeT: number;
  nextBreath: number;
  nextLeap: number;
  vy: number;
  above: boolean;
}

function dolphinGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  // body of revolution along +z (snout at +1.2), elliptical section, radius profile (z, r)
  const prof: [number, number][] = [[1.2, 0.015], [1.1, 0.045], [1.02, 0.07], [0.95, 0.15], [0.8, 0.22], [0.5, 0.28], [0.15, 0.285],
    [-0.2, 0.25], [-0.5, 0.18], [-0.8, 0.1], [-1.0, 0.055], [-1.12, 0.035]];
  const seg = 10;
  const at = (z: number, r: number, a: number) => [Math.cos(a) * r * 0.82, Math.sin(a) * r + (z > 0.95 ? -0.04 : 0), z];
  for (let i = 0; i < prof.length - 1; i++)
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const [z0, r0] = prof[i], [z1, r1] = prof[i + 1];
      const p00 = at(z0, r0, a0), p01 = at(z0, r0, a1), p10 = at(z1, r1, a0), p11 = at(z1, r1, a1);
      pos.push(...p00, ...p01, ...p10, ...p10, ...p01, ...p11);
    }
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
  // dorsal fin: raked back
  tri([0, 0.26, 0.12], [0, 0.23, -0.3], [0, 0.56, -0.38]);
  tri([0, 0.26, 0.12], [0, 0.56, -0.38], [0.02, 0.4, -0.1]);
  // pectoral fins
  for (const s of [1, -1]) {
    tri([0.17 * s, -0.12, 0.62], [0.2 * s, -0.14, 0.42], [0.48 * s, -0.3, 0.3]);
  }
  // flukes: a horizontal crescent
  for (const s of [1, -1]) {
    tri([0, 0, -1.08], [0.36 * s, 0, -1.38], [0.12 * s, 0, -1.22]);
    tri([0, 0, -1.08], [0.12 * s, 0, -1.22], [0, 0, -1.2]);
  }
  // shared vertices → smooth normals: a sleek skin rather than facets
  const g = mergeVertices(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)), 1e-4);
  g.computeVertexNormals();
  return g;
}

export class Dolphins {
  readonly mesh: THREE.InstancedMesh;
  private readonly swim: THREE.InstancedBufferAttribute;
  private pod: Dolphin[] = [];
  private state: 'none' | 'approach' | 'ride' | 'leave' = 'none';
  private stateT = 0;
  private encounterT = 50 + Math.random() * 50;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly want = new THREE.Vector3();
  private readonly n = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };
  /** a dolphin breaks the surface: spray `power` (m/s) at (x, y, z), with its velocity */
  onSplash: ((x: number, y: number, z: number, power: number, vx: number, vz: number) => void) | null = null;
  /** a dolphin breathes at the surface */
  onBlow: ((x: number, z: number) => void) | null = null;

  constructor() {
    const geo = dolphinGeometry();
    geo.scale(LEN / 2.5, LEN / 2.5, LEN / 2.5);
    this.swim = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2);
    this.swim.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSwim', this.swim);
    // wet skin: a soft sheen, not a mirror (the sky's reflection would bleach the dark back)
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.0, envMapIntensity: 0.6, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      patchUnderwater(sh);
      sh.vertexShader = sh.vertexShader
        .replace('vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;', 'vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;')
        .replace('#include <common>', '#include <common>\nattribute vec2 aSwim;\nvarying vec3 vLocal;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
vLocal = position;
// up-and-down strokes: a wave toward the flukes, which swing the most
float tail = clamp((0.25 - position.z)/1.3, 0.0, 1.0);
transformed.y += sin(aSwim.x - position.z*2.4) * aSwim.y * (0.015 + 0.2*tail*tail);`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
{
  // countershading: slate back, a paler cape down the flanks, white belly
  float y = vLocal.y + 0.03*sin(vLocal.z*5.0);
  vec3 back = vec3(0.03, 0.036, 0.045), flank = vec3(0.09, 0.1, 0.115), belly = vec3(0.45, 0.46, 0.48);
  vec3 c = mix(belly, flank, smoothstep(-0.14, -0.02, y));
  c = mix(c, back, smoothstep(0.02, 0.16, y));
  diffuseColor.rgb = c;
}`,
        );
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.name = 'dolphins';
  }

  get count(): number {
    return this.pod.length;
  }

  get status(): string {
    return this.state === 'none' ? `next ~${Math.max(0, this.encounterT).toFixed(0)} s` : this.state;
  }

  /** bring a pod now (debug / tests) */
  summon(boat: THREE.Vector3, heading: number): void {
    this.encounterT = 0;
    this.start(boat, heading);
  }

  private start(boat: THREE.Vector3, heading: number): void {
    const n = 3 + Math.floor(Math.random() * 4);
    // they come from ahead and to one side, ~110 m out (a dozen seconds away)
    const side = Math.random() < 0.5 ? 1 : -1;
    const a = heading + side * (0.5 + Math.random() * 0.8);
    const cx = boat.x + Math.sin(a) * 110, cz = boat.z + Math.cos(a) * 110;
    this.pod = [];
    for (let k = 0; k < n; k++) {
      const sx = (k % 2 === 0 ? 1 : -1) * (3.6 + Math.random() * 2.5);
      this.pod.push({
        pos: new THREE.Vector3(cx + (Math.random() - 0.5) * 12, -1.5, cz + (Math.random() - 0.5) * 12),
        vel: new THREE.Vector3(), slot: new THREE.Vector2(sx, 2 - k * 2.2 - Math.random() * 2), depth: -0.9 - Math.random() * 0.8,
        phase: Math.random() * 6, weave: Math.random() * 6, mode: 0, modeT: 0,
        nextBreath: 1 + Math.random() * 4, nextLeap: 4 + Math.random() * 8, vy: 0, above: false,
      });
    }
    this.state = 'approach';
    this.stateT = 50 + Math.random() * 45;
  }

  /**
   * Once per frame. `boat` = hull origin, `bow` = world position of the stem, `heading` (rad), `speed`
   * (m/s); `ok` = conditions for an encounter (not a gale, daylight-ish).
   */
  /** structures standing in the water (Tortuga's piers): true where one is */
  solid: ((x: number, z: number) => boolean) | null = null;

  /** open water a dolphin swims in: deep enough, and nothing built there */
  private swimmable(x: number, z: number): boolean {
    return terrainHeight(x, z) < -2.2 && !this.solid?.(x, z);
  }

  update(dt: number, t: number, boat: THREE.Vector3, bow: THREE.Vector3, heading: number, speed: number, ok: boolean, waves: WaveField): void {
    dt = Math.min(dt, 0.1);
    const fx = Math.sin(heading), fz = Math.cos(heading);
    // ---- encounters: while sailing in deep enough water ----
    if (this.state === 'none') {
      const deep = terrainHeight(boat.x, boat.z) < -3.5 && terrainHeight(boat.x + fx * 60, boat.z + fz * 60) < -3.5;
      if (ok && deep && speed > 1.2) this.encounterT -= dt;
      if (this.encounterT <= 0) this.start(boat, heading);
      if (!this.pod.length) { this.mesh.count = 0; return; }
    }
    this.stateT -= dt;
    if (this.state === 'ride' && (this.stateT <= 0 || !ok)) this.state = 'leave';
    if (this.state === 'leave' && this.pod.every((d) => d.pos.distanceTo(boat) > 220)) {
      this.pod = [];
      this.state = 'none';
      this.encounterT = 60 + Math.random() * 90;
      this.mesh.count = 0;
      return;
    }

    const arr = this.swim.array as Float32Array;
    let i = 0;
    for (const d of this.pod) {
      // ---- where to be ----
      let sp = 7;
      if (this.state === 'leave') {
        // peel off to the side the animal is on, and go deeper
        const s = Math.sign(d.slot.x);
        this.want.set(d.pos.x + (fz * s + fx * 0.6) * 40, -2.5, d.pos.z + (-fx * s + fz * 0.6) * 40);
        sp = 6;
      } else if (speed < 1.2) {
        // the boat is stopped: circle it
        const a = t * 0.25 + d.weave;
        const r = 10 + Math.abs(d.slot.x) * 2;
        this.want.set(boat.x + Math.cos(a) * r, d.depth, boat.z + Math.sin(a) * r);
        sp = 3.5;
      } else {
        // the bow wave: a slot beside the stem, weaving a little
        const lat = d.slot.x + Math.sin(t * 0.7 + d.weave) * 0.8;
        const lon = d.slot.y + Math.sin(t * 0.45 + d.weave * 2) * 1.5;
        this.want.set(bow.x + fx * lon - fz * -lat, d.depth, bow.z + fz * lon - fx * lat);
        sp = speed + 3;
        if (this.state === 'approach' && d.pos.distanceTo(this.want) < 6) this.state = 'ride';
      }
      if (this.state === 'approach') sp = Math.max(sp, 7.5);
      // keep clear of the bottom
      const bed = terrainHeight(d.pos.x, d.pos.z);
      // ---- horizontal: steer at a cruising speed that matches the boat on arrival ----
      const dx = this.want.x - d.pos.x, dz = this.want.z - d.pos.z, dl = Math.hypot(dx, dz);
      const s = Math.min(sp, dl * 1.2 + (this.state === 'leave' ? sp : speed * 0.9));
      const k = 1 - Math.exp(-dt * 1.6);
      if (dl > 0.01) { d.vel.x += ((dx / dl) * s - d.vel.x) * k; d.vel.z += ((dz / dl) * s - d.vel.z) * k; }
      // shallows, a beach, a pier ahead: turn away from it (the nearest way round), or stop short
      if (!this.swimmable(d.pos.x + d.vel.x * 0.8, d.pos.z + d.vel.z * 0.8)) {
        let turned = false;
        for (const a of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8, Math.PI]) {
          const c = Math.cos(a), sn = Math.sin(a), vx = d.vel.x * c + d.vel.z * sn, vz = -d.vel.x * sn + d.vel.z * c;
          if (this.swimmable(d.pos.x + vx * 0.8, d.pos.z + vz * 0.8)) { d.vel.x = vx; d.vel.z = vz; turned = true; break; }
        }
        if (!turned) d.vel.x = d.vel.z = 0;
      }
      d.pos.x += d.vel.x * dt;
      d.pos.z += d.vel.z * dt;
      const hv = Math.hypot(d.vel.x, d.vel.z);

      // ---- vertical: cruise at depth, roll up to breathe, leap now and then ----
      waves.sample(d.pos.x, d.pos.z, t, this.n);
      const surf = this.n.height;
      if (d.mode === 2) {
        d.vy -= 9.81 * dt;
        d.pos.y += d.vy * dt;
        if (d.vy < 0 && d.pos.y < surf - 0.4) { d.mode = 0; d.vy = -1.5; }
      } else {
        d.nextBreath -= dt;
        d.nextLeap -= dt;
        let target = Math.max(this.want.y, bed + 0.8);
        // (a breath: the back and fin roll out of the water)
        if (d.mode === 1) { target = surf + 0.02; d.modeT -= dt; if (d.modeT <= 0) { d.mode = 0; d.nextBreath = 4 + Math.random() * 5; } }
        else if (d.nextBreath <= 0 && this.state !== 'leave') { d.mode = 1; d.modeT = 1.2; }
        // (a leap only over open water, and only where it will come down in it)
        if (d.nextLeap <= 0 && d.mode !== 1 && this.state !== 'leave' && hv > 2.5 && d.pos.y > surf - 1.6 && bed < -3
          && this.swimmable(d.pos.x + d.vel.x * 1.6, d.pos.z + d.vel.z * 1.6)) {
          // a leap: out of the water in an arc ~1.5 m high
          d.mode = 2;
          d.vy = 5 + Math.random() * 1.6;
          d.nextLeap = 5 + Math.random() * 10;
        } else {
          d.vy += ((target - d.pos.y) * 2.2 - d.vy) * (1 - Math.exp(-dt * 3));
          d.pos.y += d.vy * dt;
        }
      }
      // breaking the surface, either way: spray, rings; a breath at the top of a roll
      const above = d.pos.y > surf - 0.05;
      if (above !== d.above) {
        d.above = above;
        const power = Math.min(4, 1 + Math.abs(d.vy) * 0.8);
        if (d.mode === 2 || Math.abs(d.vy) > 1) this.onSplash?.(d.pos.x, surf, d.pos.z, power, d.vel.x, d.vel.z);
        if (above && d.mode === 1) this.onBlow?.(d.pos.x, d.pos.z);
      }

      // ---- pose: along the velocity, nose up / down with the vertical motion ----
      d.phase += dt * (3.2 + hv * 0.9);
      const yaw = hv > 0.1 ? Math.atan2(d.vel.x, d.vel.z) : 0;
      this.e.set(-Math.atan2(d.vy, Math.max(hv, 0.5)), yaw, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(d.pos, this.q, this.one);
      this.mesh.setMatrixAt(i, this.m);
      arr[i * 2] = d.phase;
      arr[i * 2 + 1] = d.mode === 2 ? 0.3 : 0.6 + Math.min(1, hv / 6) * 0.5;
      i++;
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.swim.needsUpdate = true;
  }
}
