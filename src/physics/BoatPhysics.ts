import * as THREE from 'three';
import type { WaveField } from '../environment/WaveField';
import type { Wind } from '../environment/Wind';
import type { Input } from '../core/Input';
import type { Boat, BoatModelInfo } from '../boat/Boat';
import type { HullDisturbance } from '../render/water/Ripples';
import { clamp, smoothstep } from '../core/noise';

/*
 * 6-DOF rigid body, integrated here (no Jolt yet — see README "Physics"):
 *  - buoyancy: grid of hull columns, each pushes up with ρ·g·A·submersion against the Gerstner surface
 *    (the same waves the GPU draws), plus heave damping → pitch, roll, heave come out naturally
 *  - keel, rudder and sail are all the same thin-foil model (lift ⟂ flow, drag ∥ flow, post-stall
 *    flat plate), applied at their own points → heel, weather helm, yaw damping come out naturally
 *  - the sail sees apparent wind = true wind − boat velocity at the centre of effort
 *  - hull resistance rises steeply past hull speed (Froude ≈ 0.4)
 *  - grounding: spring/friction against the terrain height field
 * Body frame: +Z bow, +Y up, +X port.
 */

const RHO_W = 1025;
const RHO_A = 1.225;
const G = 9.81;
const DT = 1 / 120;
const DEG = Math.PI / 180;

interface Foil {
  area: number;
  /** lift slope per radian before stall */
  slope: number;
  clMax: number;
  stall: number;
  cd0: number;
  /** induced drag factor (CD += k·CL²) */
  k: number;
}

const KEEL: Foil = { area: 16, slope: 2.6, clMax: 0.95, stall: 18 * DEG, cd0: 0.01, k: 0.12 };
// oversized vs. the real boat on purpose: steering has to feel responsive in a game
const RUDDER: Foil = { area: 5.5, slope: 3.4, clMax: 1.2, stall: 26 * DEG, cd0: 0.012, k: 0.1 };
const SAIL: Foil = { area: 230, slope: 5.2, clMax: 1.4, stall: 17 * DEG, cd0: 0.1, k: 0.11 };
/** square yards can't be braced closer than this to the centreline */
const MIN_SHEET = 18 * DEG;

function clCd(f: Foil, a: number): [number, number] {
  // a = |angle of attack| in [0, π/2]
  let cl: number;
  if (a <= f.stall) cl = f.slope * a;
  else {
    const pre = f.slope * f.stall;
    const post = 1.1 * Math.sin(2 * a); // flat plate
    cl = pre + (post - pre) * smoothstep(f.stall, f.stall + 12 * DEG, a);
  }
  cl = Math.min(cl, f.clMax);
  const cd = f.cd0 + f.k * cl * cl + 1.15 * Math.sin(a) ** 2 * smoothstep(f.stall * 0.7, f.stall + 10 * DEG, a);
  return [cl, cd];
}

/**
 * Force on a foil in the body's horizontal plane.
 * @param wx,wz fluid velocity relative to the foil (body frame)
 * @param cx,cz chord direction (unit, body frame; sign irrelevant — foils are symmetric)
 */
function foilForce(f: Foil, rho: number, wx: number, wz: number, cx: number, cz: number, scale: number, out: { x: number; z: number; aoa: number }) {
  const V2 = wx * wx + wz * wz;
  out.x = out.z = out.aoa = 0;
  if (V2 < 1e-6) return out;
  const V = Math.sqrt(V2), ux = wx / V, uz = wz / V;
  let d = cx * ux + cz * uz;
  if (d < 0) { cx = -cx; cz = -cz; d = -d; } // symmetric foil: flip chord to face the flow
  const cr = cx * uz - cz * ux;
  const a = Math.atan2(Math.abs(cr), d);
  // chord normal on the downstream side (the side the flow pushes toward)
  let nx = cz, nz = -cx;
  if (nx * ux + nz * uz < 0) { nx = -nx; nz = -nz; }
  // lift direction: that normal made perpendicular to the flow
  const nd = nx * ux + nz * uz;
  let lx = nx - nd * ux, lz = nz - nd * uz;
  const ll = Math.hypot(lx, lz);
  if (ll > 1e-6) { lx /= ll; lz /= ll; } else { lx = nx; lz = nz; }
  const [cl, cd] = clCd(f, a);
  const q = 0.5 * rho * V2 * f.area * scale;
  out.x = q * (cl * lx + cd * ux);
  out.z = q * (cl * lz + cd * uz);
  out.aoa = a;
  return out;
}

interface HullPoint {
  local: THREE.Vector3; // column bottom, body frame
  area: number;
  height: number; // column height (bottom → deck)
}

export type PointOfSail = 'w linii wiatru' | 'bajdewind' | 'półwiatr' | 'baksztag' | 'fordewind';

export class BoatPhysics {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly angVel = new THREE.Vector3();

  // controls / state
  rudder = 0; // rad, + = bow turns to starboard (right)
  sheet = 40 * DEG; // max boom angle allowed by the sheet
  autoTrim = true;
  sailsUp = 1; // 0..1 (furling animation)
  private sailsTarget = 1;
  boomAngle = 0; // rad, signed (+ = boom to port)
  /** apparent wind flow direction at the sails, boat frame (unit) */
  readonly appFlow = new THREE.Vector3(0, 0, -1);

  // telemetry
  aws = 0; awa = 0; tws = 0; twa = 0; heel = 0; pitch = 0; leeway = 0; sailAoa = 0;
  grounded = false;
  speed = 0;

  readonly mass: number;
  private readonly inertia: THREE.Vector3;
  private readonly com = new THREE.Vector3();
  private readonly points: HullPoint[] = [];
  private readonly ce: THREE.Vector3; // sail centre of effort (body, relative to COM)
  private readonly keelPt: THREE.Vector3;
  private readonly rudderPt: THREE.Vector3;
  private readonly bowPt: THREE.Vector3;
  private readonly sternPt: THREE.Vector3;
  private acc = 0;

  // scratch
  private readonly F = new THREE.Vector3();
  private readonly T = new THREE.Vector3();
  private readonly qInv = new THREE.Quaternion();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly fo = { x: 0, z: 0, aoa: 0 };
  private readonly ws = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };
  private readonly windV = { x: 0, z: 0 };

  constructor(
    private readonly info: BoatModelInfo,
    private readonly waves: WaveField,
    private readonly wind: Wind,
    private readonly groundAt: (x: number, z: number) => number,
  ) {
    const zs = info.hullStern + 0.6, zb = info.hullBow - 0.4;
    const mid = (zs + zb) / 2, half = (zb - zs) / 2;
    const halfBeam = info.beam / 2 - 0.15;
    const draft = info.keelDepth * 0.72; // mean canoe-body draft (keel itself is thin)
    const S = 11;
    const dz = (zb - zs) / (S - 1);
    let vol = 0, mz = 0;
    for (let i = 0; i < S; i++) {
      const z = zs + i * dz;
      const u = (z - mid) / half;
      const bf = u > 0 ? Math.sqrt(Math.max(0, 1 - Math.pow(u, 2.4))) : 1 - 0.3 * u * u;
      const df = u > 0 ? 1 - 0.55 * u * u : 1 - 0.25 * u * u;
      const b = Math.max(0.3, halfBeam * bf);
      for (const xs of [-0.62, 0, 0.62]) {
        const x = xs * b;
        const depth = draft * df * (1 - 0.45 * xs * xs);
        const area = (b * 2 / 3) * dz;
        this.points.push({ local: new THREE.Vector3(x, -depth, z), area, height: depth + info.deckHeight });
        vol += area * depth;
        mz += area * depth * z;
      }
    }
    this.mass = RHO_W * vol * 0.97;
    this.com.set(0, -0.8, mz / vol);
    const L = info.hullBow - info.hullStern;
    this.inertia = new THREE.Vector3(this.mass * (0.28 * L) ** 2, this.mass * (0.22 * L) ** 2, this.mass * (0.4 * info.beam) ** 2 * 1.6);
    // express points relative to COM
    for (const p of this.points) p.local.sub(this.com);
    this.ce = new THREE.Vector3(0, 8.5, 0.4).sub(this.com);
    this.keelPt = new THREE.Vector3(0, -1.1, 0.3).sub(this.com);
    this.rudderPt = new THREE.Vector3(0, -0.9, info.hullStern + 0.4).sub(this.com);
    this.bowPt = new THREE.Vector3(0, -0.4, info.hullBow - 3).sub(this.com);
    this.sternPt = new THREE.Vector3(0, -0.5, info.hullStern + 3).sub(this.com);
  }

  /** @param bearing compass heading, radians (0 = north = −Z) */
  reset(pos: THREE.Vector3, bearing: number, speed: number): void {
    const yaw = Math.PI - bearing;
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // origin of the boat frame sits on the design waterline; COM is below it
    this.position.copy(pos).add(this.com.clone().applyQuaternion(this.quaternion));
    this.velocity.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(speed);
    this.angVel.set(0, 0, 0);
    this.rudder = 0;
    this.anchor = null;
    this.heaving = false;
  }

  /** boat yaw (rotation about +Y); bow direction = (sin, cos) */
  get heading(): number {
    const f = this.v3.set(0, 0, 1).applyQuaternion(this.quaternion);
    return Math.atan2(f.x, f.z);
  }

  get bearing(): number {
    const b = Math.PI - this.heading;
    return ((b % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  }

  /** world position of the boat-frame origin (waterline midships) */
  get origin(): THREE.Vector3 {
    return this.v2.copy(this.com).negate().applyQuaternion(this.quaternion).add(this.position);
  }

  /** kedging: world point the hull is hauled toward (null: none), and whether the line leads from the bow */
  tow: THREE.Vector3 | null = null;
  towFromBow = false;
  private readonly towAt = new THREE.Vector3();
  /** kedging: the heading the cable warps her round to (null: none) */
  warpTo: number | null = null;
  /** friction against the bottom (1 normal; kedging lets the hull slide) */
  groundGrip = 1;
  /** riding at anchor: where the anchor lies (null: aweigh) and the cable veered (m, horizontal reach) */
  anchor: THREE.Vector3 | null = null;
  rode = 40;
  /** the anchor's hold (N): above it the anchor drags — ploughs through the bottom toward the ship's drift */
  anchorHold = Infinity;
  /** weighing: the capstan heaves the cable in, drawing her up to the anchor at a walking pace */
  heaving = false;
  /** the anchor dragged this step (m moved) */
  anchorDrag = 0;
  private readonly hawse = new THREE.Vector3();

  /** knocked down: the crew lets fly everything at once — the sails come in almost instantly */
  dropSails(): void {
    this.sailsTarget = 0;
    this.sailsUp = Math.min(this.sailsUp, 0.12);
  }

  /** strike (or set) the sails, as the Space / X keys do */
  setSails(up: boolean): void {
    this.sailsTarget = up ? 1 : 0;
  }

  /**
   * Fast travel (the − / + keys): the boat covers `travel` times the ground it sails. The dynamics — heel,
   * waves, sail forces — run at normal speed; each step just carries the hull further along its course.
   * Off while aground, so it never drives the keel into a beach.
   */
  travel = 1;

  update(dt: number, t: number, input: Input): void {
    this.controls(dt, input);
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < 8) {
      this.acc -= DT;
      this.step(DT, t - this.acc);
      if (this.travel > 1 && !this.grounded && !this.anchor) {
        this.position.x += this.velocity.x * (this.travel - 1) * DT;
        this.position.z += this.velocity.z * (this.travel - 1) * DT;
      }
      steps++;
    }
    if (steps === 8) this.acc = 0;
    this.telemetryUpdate();
  }

  /** false while the sailor walks the deck (WASD moves them; the arrows and Q/E still work the boat) */
  wasd = true;

  /** false while the sailor is ashore: nobody at the helm — the rudder amidships, the sails as they were */
  helm = true;

  private controls(dt: number, input: Input): void {
    if (!this.helm) {
      this.rudder *= Math.exp(-dt * 2);
      this.sailsUp += clamp(this.sailsTarget - this.sailsUp, -dt / 2.5, dt / 2.5);
      return;
    }
    const steer = (this.wasd ? input.axis('KeyA', 'KeyD') : 0) + input.axis('ArrowLeft', 'ArrowRight');
    const target = clamp(steer, -1, 1) * 35 * DEG;
    const rate = (steer !== 0 ? 55 : 40) * DEG * dt;
    this.rudder += clamp(target - this.rudder, -rate, rate);

    const trim = (this.wasd ? input.axis('KeyS', 'KeyW') : 0) + input.axis('ArrowDown', 'ArrowUp') + input.axis('KeyE', 'KeyQ');
    if (trim !== 0) {
      this.autoTrim = false;
      this.sheet = clamp(this.sheet - trim * 28 * DEG * dt, MIN_SHEET, 88 * DEG);
    }
    if (input.wasPressed('KeyT')) this.autoTrim = !this.autoTrim;
    // Space furls / sets the sails from the chase camera (on deck it jumps); X does it anywhere
    if ((this.wasd && input.wasPressed('Space')) || input.wasPressed('KeyX')) this.sailsTarget = this.sailsTarget > 0.5 ? 0 : 1;
    this.sailsUp += clamp(this.sailsTarget - this.sailsUp, -dt / 2.5, dt / 2.5);

    if (this.autoTrim) {
      // ease the sheet so the sail sits ~15° to the apparent wind
      const ideal = clamp(Math.abs(this.awa) - 15 * DEG, MIN_SHEET, 88 * DEG);
      this.sheet += (ideal - this.sheet) * (1 - Math.exp(-dt * 1.5));
    }
  }

  /** velocity of a body point (offset r from COM, world) */
  private pointVel(r: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.crossVectors(this.angVel, r).add(this.velocity);
  }

  private addForce(fWorld: THREE.Vector3, rWorld: THREE.Vector3): void {
    this.F.add(fWorld);
    this.T.add(this.v3.crossVectors(rWorld, fWorld));
  }

  private step(dt: number, t: number): void {
    const q = this.quaternion;
    this.qInv.copy(q).invert();
    this.F.set(0, -this.mass * G, 0);
    this.T.set(0, 0, 0);
    const r = this.v1, v = this.v2, f = new THREE.Vector3();

    // ---- buoyancy + heave/roll/pitch damping ----
    let wetArea = 0;
    this.grounded = false;
    this.up.set(0, 1, 0).applyQuaternion(q);
    for (const p of this.points) {
      r.copy(p.local).applyQuaternion(q);
      const wx = this.position.x + r.x, wy = this.position.y + r.y, wz = this.position.z + r.z;
      this.waves.sample(wx, wz, t, this.ws);
      const sub = clamp(this.ws.height - wy, 0, p.height);
      if (sub > 0) {
        this.pointVel(r, v);
        const frac = Math.min(1, sub / 0.5);
        f.set(0, RHO_W * G * p.area * sub, 0);
        f.y -= 1700 * p.area * frac * (v.y - this.ws.vy);
        // small horizontal skin drag on the column so the hull doesn't skate sideways at rest
        f.x -= 4 * p.area * frac * v.x;
        f.z -= 4 * p.area * frac * v.z;
        // act at the centroid of the submerged part of the column, not at its bottom
        r.addScaledVector(this.up, sub * 0.5);
        this.addForce(f, r);
        wetArea += p.area * frac;
      }
      // grounding against the seabed / beach
      r.copy(p.local).applyQuaternion(q);
      const gh = this.groundAt(wx, wz);
      const pen = gh - wy;
      if (pen > 0) {
        this.grounded = true;
        this.pointVel(r, v);
        const n = Math.min(pen, 1.5) * 4.0e6 - 2.0e5 * v.y;
        f.set(-v.x, 0, -v.z);
        const hv = f.length();
        if (hv > 1e-4) f.multiplyScalar((Math.max(n, 0) * 0.5 * this.groundGrip) / Math.max(hv, 0.3));
        f.y = Math.max(n, 0);
        this.addForce(f, r);
      }
    }
    const immersion = clamp(wetArea / 60, 0, 1);

    // ---- hull resistance (forward) ----
    const vb = this.v3.copy(this.velocity).applyQuaternion(this.qInv);
    const u = vb.z;
    const L = this.info.hullBow - this.info.hullStern;
    const Fn = Math.abs(u) / Math.sqrt(G * L);
    const Ct = 0.0045 + 0.035 * smoothstep(0.28, 0.5, Fn) + 0.05 * smoothstep(0.45, 0.65, Fn);
    const R = 0.5 * RHO_W * 95 * Ct * u * u * immersion;
    f.set(0, 0, -Math.sign(u) * R).applyQuaternion(q);
    this.F.add(f);

    // ---- foils in water: keel, rudder, bow & stern lateral area ----
    const water = (pt: THREE.Vector3, foil: Foil, cx: number, cz: number, scale: number) => {
      r.copy(pt).applyQuaternion(q);
      this.pointVel(r, v).applyQuaternion(this.qInv);
      foilForce(foil, RHO_W, -v.x, -v.z, cx, cz, scale * immersion, this.fo);
      f.set(this.fo.x, 0, this.fo.z).applyQuaternion(q);
      this.addForce(f, r);
      return this.fo.aoa;
    };
    this.leeway = water(this.keelPt, KEEL, 0, 1, 1);
    water(this.rudderPt, RUDDER, Math.sin(this.rudder), Math.cos(this.rudder), 1);
    water(this.bowPt, KEEL, 0, 1, 0.1);
    water(this.sternPt, KEEL, 0, 1, 0.1);

    // ---- sail ----
    this.wind.velocity(this.windV);
    r.copy(this.ce).applyQuaternion(q);
    this.pointVel(r, v);
    const app = v.set(this.windV.x - v.x, 0, this.windV.z - v.z).applyQuaternion(this.qInv);
    // app = air velocity relative to the sail, in body frame
    const fromX = -app.x, fromZ = -app.z;
    const awa = Math.atan2(fromX, fromZ); // 0 = from the bow, + = from port
    this.awa = awa;
    this.aws = Math.hypot(app.x, app.z);
    if (this.aws > 1e-3) this.appFlow.set(app.x / this.aws, 0, app.z / this.aws);
    const side = awa >= 0 ? 1 : -1; // wind from port → boom to starboard (−X)
    const beta = Math.min(this.sheet, Math.abs(awa), 86 * DEG);
    this.boomAngle = -side * beta;
    const cx = -side * Math.sin(beta), cz = -Math.cos(beta);
    const sailScale = this.sailsUp * this.sailsUp;
    foilForce(SAIL, RHO_A, app.x, app.z, cx, cz, sailScale, this.fo);
    this.sailAoa = this.fo.aoa;
    f.set(this.fo.x, 0, this.fo.z).applyQuaternion(q);
    this.addForce(f, r);
    // windage of hull + rig
    const aw = Math.hypot(app.x, app.z);
    f.set(app.x, 0, app.z).multiplyScalar(0.5 * RHO_A * 1.0 * (38 + 30 * (1 - sailScale)) * aw).applyQuaternion(q);
    r.set(0, 4, 0).applyQuaternion(q);
    this.addForce(f, r);

    // ---- kedging: the capstan hauls the hull toward a kedge anchor ----
    if (this.tow) {
      r.set(0, 0.6, this.towFromBow ? this.info.hullBow - 0.5 : this.info.hullStern + 0.5).applyQuaternion(q).sub(this.com.clone().applyQuaternion(q));
      const at = this.towAt.copy(this.position).add(r);
      f.set(this.tow.x - at.x, 0, this.tow.z - at.z);
      const dist = f.length();
      if (dist > 0.5) {
        f.divideScalar(dist);
        this.pointVel(r, v);
        // a steady walk round the capstan: pull harder when slower than ~1.6 m/s, never push
        const want = Math.min(1.6, dist * 0.4);
        const pull = clamp((want - v.dot(f)) * this.mass * 1.2, 0, this.mass * 2.2);
        this.addForce(f.multiplyScalar(pull), r);
      }
    }

    // ---- at anchor: the cable lies slack on the bottom until the ship drifts out to its length, then comes
    //      taut — soft at first as the catenary straightens, hard at full scope — and holds her by the bow ----
    this.anchorDrag = 0;
    if (this.anchor) {
      r.set(0, 0.6, this.info.hullBow - 0.5).applyQuaternion(q).sub(this.hawse.copy(this.com).applyQuaternion(q));
      const at = this.towAt.copy(this.position).add(r);
      f.set(this.anchor.x - at.x, 0, this.anchor.z - at.z);
      const dist = f.length(), slack = this.rode * 0.85;
      if (this.heaving) {
        if (dist > 0.5) {
          f.divideScalar(dist);
          this.pointVel(r, v);
          const want = Math.min(0.7, dist * 0.12);
          this.addForce(f.multiplyScalar(clamp((want - v.dot(f)) * this.mass * 1.2, 0, this.mass * 1.5)), r);
        }
      } else if (dist > slack) {
        f.divideScalar(dist);
        this.pointVel(r, v);
        const s = dist - slack;
        let pull = this.mass * (0.012 * s * s + 0.05 * s) + Math.max(0, -v.dot(f)) * this.mass * 0.5;
        // more than the ground holds: the anchor drags toward the ship, the cable stays at its hold
        if (pull > this.anchorHold) {
          const give = Math.min(s * 0.5, 0.6 * dt);
          this.anchor.x -= f.x * give;
          this.anchor.z -= f.z * give;
          this.anchorDrag = give;
          pull = this.anchorHold;
        }
        this.addForce(f.multiplyScalar(Math.min(pull, this.mass * 3)), r);
      }
    }

    // warping her round on the cable: a gentle yaw toward the wanted heading (world angVel, vertical axis)
    if (this.warpTo !== null) {
      let d = this.warpTo - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.T.y += this.inertia.y * (clamp(d, -0.8, 0.8) * 0.9 - this.angVel.y * 1.5);
    }

    // ---- integrate ----
    this.velocity.addScaledVector(this.F, dt / this.mass);
    const tb = this.T.applyQuaternion(this.qInv);
    const wb = this.v1.copy(this.angVel).applyQuaternion(this.qInv);
    wb.x += (tb.x / this.inertia.x) * dt;
    wb.y += (tb.y / this.inertia.y) * dt;
    wb.z += (tb.z / this.inertia.z) * dt;
    // mild rotational damping (added mass / radiation damping not otherwise modelled)
    wb.multiplyScalar(Math.exp(-dt * 0.15));
    this.angVel.copy(wb).applyQuaternion(q);
    this.position.addScaledVector(this.velocity, dt);
    const w = this.angVel;
    const dq = new THREE.Quaternion(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(q);
    q.set(q.x + dq.x, q.y + dq.y, q.z + dq.z, q.w + dq.w).normalize();
  }

  private telemetryUpdate(): void {
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.wind.velocity(this.windV);
    this.tws = this.wind.speed;
    // true wind angle relative to the bow
    const h = this.heading;
    const fromWorld = Math.atan2(-this.windV.x, -this.windV.z);
    let twa = fromWorld - h;
    twa = Math.atan2(Math.sin(twa), Math.cos(twa));
    this.twa = twa;
    const right = this.v2.set(-1, 0, 0).applyQuaternion(this.quaternion);
    this.heel = Math.asin(clamp(-right.y, -1, 1));
    const fwd = this.v1.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.pitch = Math.asin(clamp(fwd.y, -1, 1));
  }

  get pointOfSail(): PointOfSail {
    const a = Math.abs(this.twa) / DEG;
    if (a < 40) return 'w linii wiatru';
    if (a < 70) return 'bajdewind';
    if (a < 110) return 'półwiatr';
    if (a < 155) return 'baksztag';
    return 'fordewind';
  }

  /** true when the sail is flogging (sheet eased past the wind) */
  get luffing(): boolean {
    return this.sailsUp > 0.5 && this.sailAoa < 4 * DEG;
  }

  wakeDisturbance(): HullDisturbance {
    const o = this.origin;
    const h = this.heading;
    const L = this.info.hullBow - this.info.hullStern;
    const mid = (this.info.hullBow + this.info.hullStern) / 2;
    const fx = Math.sin(h), fz = Math.cos(h);
    return {
      x: o.x + fx * mid,
      z: o.z + fz * mid,
      fx,
      fz,
      halfLength: L / 2,
      halfBeam: this.info.beam / 2,
      strength: 0.0075 * Math.min(this.speed, 7) + 0.01 * Math.min(Math.abs(this.velocity.y), 1),
    };
  }

  /** move visual sub-parts that follow the controls */
  applyVisuals(boat: Boat, t: number): void {
    // model origin = boat-frame origin: position is COM, so shift back
    boat.root.position.copy(this.origin);
    boat.root.quaternion.copy(this.quaternion);
    boat.setRig({ boom: this.boomAngle, up: this.sailsUp, flow: this.appFlow, aws: this.aws, aoa: this.sailAoa }, t);
  }

  telemetry() {
    return {
      kn: (this.speed * 1.943844).toFixed(2),
      bearing: (this.bearing / DEG).toFixed(0),
      heel: (this.heel / DEG).toFixed(1),
      pitch: (this.pitch / DEG).toFixed(1),
      awa: (this.awa / DEG).toFixed(0),
      twa: (this.twa / DEG).toFixed(0),
      aws: this.aws.toFixed(1),
      sheet: (this.sheet / DEG).toFixed(0),
      boom: (this.boomAngle / DEG).toFixed(0),
      rudder: (this.rudder / DEG).toFixed(0),
      leeway: (this.leeway / DEG).toFixed(1),
      y: this.origin.y.toFixed(2),
      grounded: this.grounded,
    };
  }
}
