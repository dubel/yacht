import * as THREE from 'three';
import type { WaveField } from '../environment/WaveField';
import { terrainHeight } from '../world/WorldGen';

/*
 * Seagulls. A flock lives where there is land: birds wheel over the islands, mostly gliding and banking
 * into the turns with an occasional burst of flapping; some peel off to follow a moving boat's stern, and
 * now and then one settles on the water to bob on the waves before taking off again. Far out at sea only a
 * straggler or two keeps the boat company, none at night or in rain. Birds arrive from afar and leave the
 * same way rather than popping in and out.
 *
 * One instanced mesh of a ~50-triangle gull (white body, grey mantle, black wingtips, yellow bill). The
 * wingbeat is in the vertex shader — inner and outer wing hinge separately, and a resting bird folds them —
 * driven by a per-bird phase / amplitude / fold the CPU writes each frame. Calls come from actual birds:
 * a gull near the listener calls now and then, panned and faded by where it is.
 */

const MAX = 36;
const SPAN = 0.7; // half wingspan (m)

type State = 'soar' | 'follow' | 'sit' | 'arrive' | 'leave';

interface Gull {
  state: State;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  anchor: THREE.Vector3;
  radius: number;
  height: number;
  angle: number;
  dir: number;
  timer: number;
  /** seconds of flapping left in the current burst, and of gliding until the next */
  flapping: number;
  glide: number;
  phase: number;
  bank: number;
  callT: number;
  follow: number;
}

function gullGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  // (sRGB, converted to the renderer's linear space)
  const lin = (c: number[]) => c.map((v) => Math.pow(v, 2.2));
  const white = lin([0.95, 0.95, 0.93]), grey = lin([0.62, 0.66, 0.7]), black = lin([0.1, 0.1, 0.11]), bill = lin([0.95, 0.78, 0.2]), belly = lin([0.88, 0.88, 0.88]);
  const tri = (a: number[], b: number[], c: number[], k: number[]) => { pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) col.push(...k); };
  const quad = (a: number[], b: number[], c: number[], d: number[], k: number[]) => { tri(a, b, c, k); tri(a, c, d, k); };
  // body: a spindle with a diamond cross-section (+z forward, +x left, +y up)
  const ring = (z: number, w: number, h: number, dy = 0) => [[w, dy, z], [0, h + dy, z], [-w, dy, z], [0, -h * 0.8 + dy, z]];
  const rings = [ring(0.3, 0.0, 0.0, 0.03), ring(0.22, 0.045, 0.045, 0.03), ring(0.08, 0.07, 0.06), ring(-0.12, 0.055, 0.045), ring(-0.3, 0.012, 0.01, 0.01)];
  for (let r = 0; r < rings.length - 1; r++)
    for (let k = 0; k < 4; k++) {
      const a = rings[r][k], b = rings[r][(k + 1) % 4], c = rings[r + 1][(k + 1) % 4], d = rings[r + 1][k];
      quad(a, b, c, d, k === 3 ? belly : white);
    }
  // bill
  tri([0, 0.035, 0.3], [0.012, 0.025, 0.37], [-0.012, 0.025, 0.37], bill);
  tri([0, 0.035, 0.3], [0, 0.015, 0.36], [0.012, 0.025, 0.37], bill);
  // tail fan
  tri([0.05, 0.02, -0.2], [-0.05, 0.02, -0.2], [0, 0.02, -0.36], white);
  // wings: inner panel (root → elbow) and outer panel (elbow → tip), swept back
  for (const s of [1, -1]) {
    const root0 = [0.05 * s, 0.03, 0.12], root1 = [0.05 * s, 0.03, -0.08];
    const elb0 = [0.34 * s, 0.03, 0.1], elb1 = [0.34 * s, 0.03, -0.1];
    const mid0 = [0.52 * s, 0.03, 0.03], mid1 = [0.52 * s, 0.03, -0.12];
    const tip = [SPAN * s, 0.03, -0.1];
    quad(root0, elb0, elb1, root1, grey);
    quad(elb0, mid0, mid1, elb1, grey);
    tri(mid0, tip, mid1, black);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export class Gulls {
  readonly mesh: THREE.InstancedMesh;
  private readonly flap: THREE.InstancedBufferAttribute;
  private readonly birds: Gull[] = [];
  private anchors: THREE.Vector3[] = [];
  private landDist = Infinity;
  private surveyT = 0;
  private primed = false;
  private callGap = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly want = new THREE.Vector3();
  private readonly n = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };
  /** a bird calls: where it is relative to the listener */
  onCall: ((pan: number, distance: number) => void) | null = null;

  constructor() {
    const geo = gullGeometry();
    // per bird: wingbeat phase, amplitude, fold (0 flying … 1 wings folded on the water)
    this.flap = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.flap.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFlap', this.flap);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aFlap;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
{
  // wings hinge at the shoulder; the outer wing bends further (the wrist), a little dihedral at rest
  float ax = abs(position.x);
  if (ax > 0.051) {
    float s = sign(position.x);
    float beat = sin(aFlap.x);
    float inner = 0.1 + beat*aFlap.y;
    float outer = inner + beat*aFlap.y*0.6 - 0.06*(1.0 - aFlap.y);
    float r1 = min(ax, 0.34) - 0.05, r2 = max(ax - 0.34, 0.0);
    vec2 e = vec2(0.05 + r1*cos(inner), r1*sin(inner));
    vec2 w = e + r2*vec2(cos(outer), sin(outer));
    // folded: the wing lies back along the body
    vec2 f = vec2(0.05 + (ax - 0.05)*0.12, 0.05);
    w = mix(w, f, aFlap.z);
    transformed.x = s*w.x;
    transformed.y = position.y + w.y;
    transformed.z = mix(position.z, position.z - (ax - 0.05)*0.55, aFlap.z);
  }
}`,
        );
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.name = 'gulls';
  }

  get count(): number {
    return this.birds.length;
  }

  /** where is land around the boat? (anchors for the flock, and how far the nearest shore is) */
  private survey(focus: THREE.Vector3): void {
    this.anchors = [];
    this.landDist = Infinity;
    for (const r of [60, 150, 280, 450, 700])
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2 + r;
        const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
        const h = terrainHeight(x, z);
        if (h > 0.8) {
          this.landDist = Math.min(this.landDist, r);
          // (anchor height = the land there: birds circle that much above the treetops)
          if (this.anchors.length < 6 && !this.anchors.some((p) => Math.hypot(p.x - x, p.z - z) < 120)) this.anchors.push(new THREE.Vector3(x, h + 8, z));
        }
      }
  }

  /** `here`: already circling (the flock at the start of the game), otherwise arriving from afar */
  private add(focus: THREE.Vector3, here = false): void {
    // arrive from afar, high, heading in
    const a = Math.random() * Math.PI * 2, r = 380 + Math.random() * 120;
    const g: Gull = {
      state: 'arrive', pos: new THREE.Vector3(focus.x + Math.cos(a) * r, 45 + Math.random() * 20, focus.z + Math.sin(a) * r),
      vel: new THREE.Vector3(-Math.cos(a) * 10, 0, -Math.sin(a) * 10), anchor: new THREE.Vector3(), radius: 30, height: 20,
      angle: Math.random() * 6.3, dir: Math.random() < 0.5 ? 1 : -1, timer: 0, flapping: 1.5, glide: 3, phase: Math.random() * 6, bank: 0,
      callT: 3 + Math.random() * 20, follow: Math.random(),
    };
    this.pickSoar(g);
    if (here) {
      g.angle = Math.random() * Math.PI * 2;
      g.pos.set(g.anchor.x + Math.cos(g.angle) * g.radius, g.anchor.y + g.height, g.anchor.z + Math.sin(g.angle) * g.radius);
      g.vel.set(-Math.sin(g.angle) * g.dir * 10, 0, Math.cos(g.angle) * g.dir * 10);
    } else g.state = 'arrive';
    this.birds.push(g);
  }

  private pickSoar(g: Gull): void {
    const an = this.anchors.length ? this.anchors[Math.floor(Math.random() * this.anchors.length)] : null;
    g.state = 'soar';
    if (an) g.anchor.copy(an);
    g.radius = 18 + Math.random() * 45;
    g.height = 10 + Math.random() * 28;
    g.timer = 12 + Math.random() * 25;
  }

  /**
   * Once per frame. `boat` = hull origin, `stern` = where a follower trails (behind the boat), `speed` of
   * the boat, `ok` = gull weather (day, no rain), `listener` for the calls (camera position / right vector).
   */
  update(dt: number, t: number, boat: THREE.Vector3, stern: THREE.Vector3, speed: number, ok: boolean,
    waves: WaveField, listener: THREE.Vector3, right: THREE.Vector3): void {
    dt = Math.min(dt, 0.1);
    this.surveyT -= dt;
    if (this.surveyT <= 0) { this.surveyT = 2; this.survey(boat); }
    // how many birds this place and weather support
    const near = this.landDist < 800;
    const target = !ok ? 0 : near ? Math.round(10 + 14 * (1 - this.landDist / 800)) : speed > 1.5 ? 2 : 0;
    const flying = this.birds.filter((b) => b.state !== 'leave').length;
    if (!this.primed) { this.primed = true; for (let k = 0; k < target; k++) this.add(boat, true); }
    else if (flying < target && Math.random() < dt * 1.5) this.add(boat);
    if (flying > target) { const b = this.birds.find((x) => x.state !== 'leave'); if (b) { b.state = 'leave'; b.timer = 0; } }
    this.callGap -= dt;

    const arr = this.flap.array as Float32Array;
    let n = 0;
    for (let i = this.birds.length - 1; i >= 0; i--) {
      const g = this.birds[i];
      g.timer -= dt;
      let flapAmp = 0, fold = 0, sp = 10;
      // ---- choose where to be ----
      switch (g.state) {
        case 'arrive':
        case 'soar': {
          if (!this.anchors.length) g.anchor.copy(boat); // open sea: circle the boat
          g.angle += (g.dir * sp * dt) / g.radius;
          this.want.set(g.anchor.x + Math.cos(g.angle) * g.radius, g.anchor.y + g.height + 3 * Math.sin(g.angle * 0.7), g.anchor.z + Math.sin(g.angle) * g.radius);
          if (g.state === 'arrive' && g.pos.distanceTo(this.want) < 30) g.state = 'soar';
          if (g.state === 'soar' && g.timer <= 0) {
            const r = Math.random();
            if (speed > 1.5 && r < 0.2 * (0.5 + g.follow)) { g.state = 'follow'; g.timer = 15 + Math.random() * 25; }
            else if (r < 0.55 && this.anchors.length) { g.state = 'sit'; g.timer = 12 + Math.random() * 30; g.anchor.set(g.pos.x + (Math.random() - 0.5) * 60, 0, g.pos.z + (Math.random() - 0.5) * 60); }
            else this.pickSoar(g);
          }
          break;
        }
        case 'follow': {
          // trail the stern, weaving across the wake; a slow boat is circled instead
          const bx = stern.x - boat.x, bz = stern.z - boat.z, bl = Math.hypot(bx, bz) || 1;
          const w = Math.sin(t * 0.4 + g.follow * 9) * 7;
          this.want.set(stern.x + (bz / bl) * w, 7 + 4 * g.follow + Math.sin(t * 0.6 + g.follow * 5) * 2, stern.z - (bx / bl) * w);
          sp = Math.max(6, speed + 2);
          if (g.timer <= 0 || speed < 1) this.pickSoar(g);
          break;
        }
        case 'sit': {
          // glide down to the water, then ride the waves with folded wings
          waves.sample(g.anchor.x, g.anchor.z, t, this.n);
          this.want.set(g.anchor.x, this.n.height + 0.05, g.anchor.z);
          if (g.pos.distanceTo(this.want) < 1.5) {
            g.pos.copy(this.want);
            g.vel.multiplyScalar(Math.exp(-dt * 3));
            fold = 1;
            sp = 0;
          }
          if (g.timer <= 0 || Math.hypot(g.pos.x - boat.x, g.pos.z - boat.z) < 14) { this.pickSoar(g); g.vel.y = 4; }
          break;
        }
        case 'leave': {
          const ax = g.pos.x - boat.x, az = g.pos.z - boat.z, l = Math.hypot(ax, az) || 1;
          this.want.set(g.pos.x + (ax / l) * 50, g.pos.y + 8, g.pos.z + (az / l) * 50);
          if (l > 520) { this.birds.splice(i, 1); continue; }
          break;
        }
      }

      // ---- fly there: seek at cruising speed, bank into turns, flap when climbing or slow ----
      if (fold < 1) {
        const dx = this.want.x - g.pos.x, dy = this.want.y - g.pos.y, dz = this.want.z - g.pos.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const s = g.state === 'sit' ? Math.min(sp, 3 + dl * 0.6) : sp;
        const k = 1 - Math.exp(-dt * 1.2);
        const oldYaw = Math.atan2(g.vel.x, g.vel.z);
        g.vel.x += ((dx / dl) * s - g.vel.x) * k;
        g.vel.y += ((dy / dl) * s * 0.6 - g.vel.y) * k;
        g.vel.z += ((dz / dl) * s - g.vel.z) * k;
        g.pos.addScaledVector(g.vel, dt);
        const floor = Math.max(terrainHeight(g.pos.x, g.pos.z), 0) + (g.state === 'sit' ? 0 : 3);
        if (g.pos.y < floor) g.pos.y = floor;
        let turn = Math.atan2(g.vel.x, g.vel.z) - oldYaw;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn)) / Math.max(dt, 1e-3);
        g.bank += (THREE.MathUtils.clamp(-turn * Math.hypot(g.vel.x, g.vel.z) * 0.1, -0.9, 0.9) - g.bank) * (1 - Math.exp(-dt * 3));
        // flap in bursts — when climbing or landing, otherwise every few seconds — and glide in between
        if (g.flapping > 0) g.flapping -= dt;
        else {
          g.glide -= dt;
          if (g.glide <= 0 || g.vel.y > 1.5) { g.flapping = 0.8 + Math.random() * 1.6; g.glide = 3 + Math.random() * 7; }
        }
        flapAmp = g.flapping > 0 ? 0.55 : 0;
      }
      g.phase += dt * (flapAmp > 0 ? 17 : 0);

      // ---- calls from the birds near the listener ----
      g.callT -= dt;
      if (g.callT <= 0) {
        g.callT = 9 + Math.random() * 28;
        const d = g.pos.distanceTo(listener);
        if (d < 140 && this.callGap <= 0 && g.state !== 'leave') {
          this.callGap = 1.2;
          const tx = g.pos.x - listener.x, tz = g.pos.z - listener.z, tl = Math.hypot(tx, tz) || 1;
          this.onCall?.((tx * right.x + tz * right.z) / tl, d);
        }
      }

      // ---- pose ----
      const hv = Math.hypot(g.vel.x, g.vel.z);
      if (fold === 1) {
        waves.sample(g.pos.x, g.pos.z, t, this.n);
        this.e.set(Math.atan2(-this.n.nz, this.n.ny) * 0.8, Math.atan2(g.vel.x, g.vel.z) || g.angle, 0);
      } else {
        this.e.set(-Math.atan2(g.vel.y, Math.max(hv, 0.5)) * 0.7, Math.atan2(g.vel.x, g.vel.z), g.bank);
      }
      this.q.setFromEuler(this.e);
      this.m.compose(g.pos, this.q, this.one);
      this.mesh.setMatrixAt(n, this.m);
      arr[n * 3] = g.phase;
      arr[n * 3 + 1] = flapAmp;
      arr[n * 3 + 2] = fold;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
  }
}
