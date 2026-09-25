import * as THREE from 'three';
import { featuresNear, terrainHeight } from '../world/WorldGen';
import { fadeThrough } from './fade';

/*
 * Going ashore. The ship lies at anchor in the roads; the crew puts the jolly boat in the water and rows
 * the sailor to the nearest beach (B). Nobody watches the rowing — a fade, and the time it took (a man at
 * the oars makes ~1.5 m/s) — and he stands on the sand beside the boat, drawn up bow first, looking inland.
 * Back at the boat, B rows him out to the ship again. Only a beach will do: the boat runs up where the
 * ground rises gently out of the water, not under a cliff.
 */

/** farthest beach the boat is sent to (m) */
const MAX_ROW = 700;
/** rowing speed (m/s) */
const ROW_SPEED = 1.5;
/** how close to the boat (m) he must be to take it back */
const BOARD_R = 5;

interface Spot {
  /** where the boat is drawn up (its middle) and its heading (bow inland) */
  boat: THREE.Vector3;
  heading: number;
  /** where he stands, and facing */
  stand: THREE.Vector2;
  yaw: number;
  name: string;
  dist: number;
}

export interface LandingHooks {
  say(text: string, seconds: number): void;
  oar(at: THREE.Vector3): void;
  /** put the sailor ashore at `stand`, facing `yaw` */
  goAshore(stand: THREE.Vector2, yaw: number): void;
  /** take him back aboard */
  comeAboard(): void;
  /** game hours pass */
  hours(h: number): void;
}

/** a small clinker jolly boat, ~4.2 m: an open hull of U-sections, a transom, two thwarts and the oars */
function jollyBoat(): THREE.Group {
  const L = 4.2, W = 0.78, N = 14, M = 9;
  const pos: number[] = [];
  const sect: THREE.Vector3[][] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 - 1; // −1 stern … 1 bow
    const bow = Math.max(t, 0);
    const w = W * Math.sqrt(Math.max(0, 1 - bow ** 1.8)) * (t < 0 ? 1 - 0.28 * t * t : 1);
    const gun = 0.58 + 0.2 * bow * bow, keel = 0.25 * bow ** 3;
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < M; k++) {
      const th = (k / (M - 1)) * Math.PI;
      ring.push(new THREE.Vector3(-w * Math.cos(th), gun - (gun - keel) * Math.pow(Math.sin(th), 0.6), t * (L / 2)));
    }
    sect.push(ring);
  }
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < N; i++)
    for (let k = 0; k < M - 1; k++) {
      const a = sect[i][k], b = sect[i][k + 1], c = sect[i + 1][k], d = sect[i + 1][k + 1];
      tri(a, c, b); tri(b, c, d);
    }
  // the transom: a fan across the stern section
  const s0 = sect[0], mid = s0[0].clone().add(s0[M - 1]).multiplyScalar(0.5);
  for (let k = 0; k < M - 1; k++) tri(mid, s0[k + 1], s0[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const hull = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.85, side: THREE.DoubleSide, flatShading: true }));
  const wood = new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 0.8, flatShading: true });
  const group = new THREE.Group();
  group.add(hull);
  for (const z of [-0.5, 0.55]) {
    const th = new THREE.Mesh(new THREE.BoxGeometry(W * 1.65, 0.05, 0.24), wood);
    th.position.set(0, 0.42, z);
    group.add(th);
  }
  // the oars, shipped: laid fore and aft on the thwarts
  for (const x of [-0.2, 0.2]) {
    const oar = new THREE.Group();
    const loom = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 2.3, 6), wood);
    loom.rotation.x = Math.PI / 2;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.015, 0.6), wood);
    blade.position.z = -1.2;
    oar.add(loom, blade);
    oar.position.set(x, 0.47, 0.1);
    oar.rotation.y = x * 0.06;
    group.add(oar);
  }
  group.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}

export class Landing {
  readonly group = new THREE.Group();
  ashore = false;
  /** obstacles the boat on the beach puts in the sailor's way: [x, z, r] */
  readonly obstacles: [number, number, number][] = [];
  private readonly boat = jollyBoat();
  private spot: Spot | null = null;
  private findT = 0;
  private busy = false;
  private readonly hint = document.createElement('div');
  private readonly v = new THREE.Vector3();

  constructor(private readonly hooks: LandingHooks) {
    this.group.add(this.boat);
    this.group.visible = false;
    this.group.name = 'jolly boat';
    this.hint.id = 'landhint';
    this.hint.hidden = true;
    document.body.append(this.hint);
  }

  /**
   * Once per frame. Aboard: `canGo` (on deck, the ship at anchor) and where she is; ashore: where he is.
   * `b`: the B key this frame.
   */
  update(dt: number, s: { canGo: boolean; ship: THREE.Vector3; sailor: THREE.Vector2 | null; b: boolean }): void {
    if (this.busy) { this.hint.hidden = true; return; }
    if (!this.ashore) {
      this.findT -= dt;
      if (!s.canGo) { this.spot = null; this.findT = 0; }
      else if (this.findT <= 0) { this.findT = 1; this.spot = this.find(s.ship); }
      const sp = this.spot;
      this.hint.hidden = !sp;
      if (sp) this.hint.innerHTML = `<kbd>B</kbd> — szalupą na ląd · ${sp.name} · ${Math.round(sp.dist / 10) * 10} m`;
      if (s.b) {
        if (sp) this.row(sp, s.ship);
        else if (!s.canGo) this.hooks.say('Na ląd szalupą — najpierw rzuć kotwicę (Z) przy wyspie.', 3.5);
        else this.hooks.say(`Brak plaży w zasięgu szalupy (${MAX_ROW} m).`, 3);
      }
      return;
    }
    // ashore: the boat waits on the beach
    const p = s.sailor!, b = this.spot!.boat;
    const d = Math.hypot(p.x - b.x, p.y - b.z);
    this.hint.hidden = d > BOARD_R;
    this.hint.innerHTML = '<kbd>B</kbd> — szalupą z powrotem na statek';
    if (s.b) {
      if (d <= BOARD_R) this.rowBack();
      else {
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        // compass: north = −z, east = +x
        const brg = Math.atan2(b.x - p.x, -(b.z - p.y));
        const k = Math.round(((brg / (Math.PI * 2)) * 8 + 8)) % 8;
        this.hooks.say(`Szalupa czeka na plaży — ${Math.round(d)} m stąd, na ${dirs[k]}.`, 3);
      }
    }
  }

  /** the nearest beach round the ship: the first land along rays out from her, where it rises gently */
  private find(o: THREE.Vector3): Spot | null {
    let best: { r: number; a: number; score: number } | null = null;
    const RAYS = 64;
    for (let k = 0; k < RAYS; k++) {
      const a = (k / RAYS) * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
      for (let r = 8; r < (best ? best.score : MAX_ROW); r += 3) {
        if (terrainHeight(o.x + dx * r, o.z + dz * r) <= 0) continue;
        // the waterline, to a few cm
        let lo = r - 3, hi = r;
        for (let n = 0; n < 8; n++) { const m = (lo + hi) / 2; if (terrainHeight(o.x + dx * m, o.z + dz * m) > 0) hi = m; else lo = m; }
        // a beach: no more than ~2.5 m of rise over the first 8 m ashore
        if (terrainHeight(o.x + dx * (hi + 8), o.z + dz * (hi + 8)) >= 2.5) break;
        // an island rather than a bare sandbar awash: ground that stands up out of the sea further in
        // (a sandbar only if there is nothing better within ~200 m more of rowing)
        let top = 0;
        for (let d = 10; d <= 70; d += 10) top = Math.max(top, terrainHeight(o.x + dx * (hi + d), o.z + dz * (hi + d)));
        const score = hi + (top < 1.5 ? 200 : 0);
        if (!best || score < best.score) best = { r: hi, a, score };
        break;
      }
    }
    if (!best) return null;
    const { r, a } = best, dx = Math.sin(a), dz = Math.cos(a);
    // the boat: run up the beach bow first, its middle ~1.4 m above the waterline
    const bx = o.x + dx * (r + 1.4), bz = o.z + dz * (r + 1.4);
    // he stands beside it, a little further up, looking inland
    const side = 1.9;
    let sx = o.x + dx * (r + 2.5) + dz * side, sz = o.z + dz * (r + 2.5) - dx * side;
    for (let n = 0; n < 6 && terrainHeight(sx, sz) < 0.3; n++) { sx += dx; sz += dz; }
    let name = '', gap = Infinity;
    for (const f of featuresNear(bx, bz, 1500)) {
      const g = Math.hypot(f.x - bx, f.z - bz) - f.radius;
      if (g < gap) { gap = g; name = f.name; }
    }
    return {
      boat: new THREE.Vector3(bx, 0, bz), heading: a,
      stand: new THREE.Vector2(sx, sz), yaw: a, name: name || 'bezimienna wyspa', dist: r,
    };
  }

  /** draw the boat up on the beach, keel along the slope, lying over a little */
  private beach(sp: Spot): void {
    const dx = Math.sin(sp.heading), dz = Math.cos(sp.heading), b = sp.boat;
    const hb = terrainHeight(b.x + dx * 1.8, b.z + dz * 1.8), hs = terrainHeight(b.x - dx * 1.8, b.z - dz * 1.8);
    const g = this.boat;
    g.rotation.order = 'YXZ';
    g.rotation.set(-Math.atan2(hb - hs, 3.6), sp.heading, 0.12);
    g.position.set(b.x, Math.max(terrainHeight(b.x, b.z), (hb + hs) / 2) - 0.08, b.z);
    this.obstacles.length = 0;
    for (const k of [-1.4, 0, 1.4]) this.obstacles.push([b.x + dx * k, b.z + dz * k, 0.75 - Math.abs(k) * 0.12]);
  }

  private row(sp: Spot, ship: THREE.Vector3): void {
    this.busy = true;
    this.hooks.say('Szalupa na wodę — wiosłujemy do brzegu…', 3);
    // a few strokes pulling away from the ship, then the fade
    const from = ship.clone().setY(0);
    for (let n = 0; n < 3; n++) setTimeout(() => this.hooks.oar(this.v.copy(from).lerp(sp.boat, 0.01 + n * 0.02)), 300 + n * 800);
    setTimeout(() => fadeThrough(() => {
      this.beach(sp);
      this.group.visible = true;
      this.ashore = true;
      this.busy = false;
      this.hooks.hours(this.rowHours(sp));
      this.hooks.goAshore(sp.stand, sp.yaw);
      this.hooks.say(`${sp.name}. Szalupa czeka na plaży — wróć do niej i naciśnij B, by wrócić na statek.`, 5);
    }, 700, 400), 2400);
  }

  private rowBack(): void {
    const sp = this.spot!;
    this.busy = true;
    this.hooks.say('Spychamy szalupę na wodę…', 2);
    fadeThrough(() => {
      this.group.visible = false;
      this.obstacles.length = 0;
      this.ashore = false;
      this.busy = false;
      this.spot = null;
      this.findT = 0;
      this.hooks.hours(this.rowHours(sp));
      this.hooks.comeAboard();
      this.hooks.say('Z powrotem na pokładzie.', 2.5);
    }, 700, 400);
  }

  private rowHours(sp: Spot): number {
    // rowing, and putting the boat in the water / hauling it up
    return (sp.dist / ROW_SPEED + 240) / 3600;
  }
}
