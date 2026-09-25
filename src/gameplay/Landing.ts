import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
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

export class Landing {
  readonly group = new THREE.Group();
  ashore = false;
  /** obstacles the boat on the beach puts in the sailor's way: [x, z, r] */
  readonly obstacles: [number, number, number][] = [];
  /** the boat's pivot: bow toward +z, keel on y = 0, middle of the hull at the origin (filled by load) */
  private readonly boat = new THREE.Group();
  /** hull length and beam (m) */
  private length = 4;
  private beam = 1.5;
  /** points of the hull's bottom (boat frame): none of them may end up under the sand */
  private readonly keel: THREE.Vector3[] = [];
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
   * Once per frame. Aboard: `canGo` (the ship at anchor) and where she is; ashore: where he is.
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

  /**
   * The jolly boat: "Wooden Boat" by donnichols (Sketchfab, CC-BY-4.0), optimised (npm run optimize-jollyboat).
   * Its units are cm and its stern is where the rear bench is; it is turned and set so the bow is +z.
   */
  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const model = (await loader.loadAsync(url)).scene;
    model.scale.setScalar(0.01);
    const pivot = new THREE.Group();
    pivot.add(model);
    pivot.updateMatrixWorld(true);
    const hull = new THREE.Box3().setFromObject(model.getObjectByName('Base') ?? model);
    const size = hull.getSize(new THREE.Vector3()), mid = hull.getCenter(new THREE.Vector3());
    // lengthwise along z
    const along = size.z >= size.x;
    this.length = along ? size.z : size.x;
    this.beam = along ? size.x : size.z;
    // (the model is scaled inside the pivot: its offset is in metres, in the pivot's frame)
    model.position.set(-mid.x, -hull.min.y, -mid.z);
    const turn = new THREE.Group();
    turn.add(pivot);
    if (!along) pivot.rotation.y = Math.PI / 2;
    turn.updateMatrixWorld(true);
    const rear = model.getObjectByName('RearBench');
    if (rear && rear.getWorldPosition(new THREE.Vector3()).z > 0) turn.rotation.y = Math.PI;
    model.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.boat.add(turn);
    // the bottom of the hull: its lowest third, a few hundred vertices of it
    this.boat.updateMatrixWorld(true);
    const base = model.getObjectByName('Base');
    base?.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const pos = o.geometry.getAttribute('position');
      const step = Math.max(1, Math.floor(pos.count / 600));
      for (let i = 0; i < pos.count; i += step) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.y < size.y * 0.35) this.keel.push(v);
      }
    });
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
    const h = this.length * 0.45;
    const hb = terrainHeight(b.x + dx * h, b.z + dz * h), hs = terrainHeight(b.x - dx * h, b.z - dz * h);
    const g = this.boat;
    g.rotation.order = 'YXZ';
    g.rotation.set(-Math.atan2(hb - hs, 2 * h), sp.heading, 0.06);
    // high enough that the sand stays under the whole bottom, bedded in it by a few cm
    g.position.set(b.x, 0, b.z);
    g.updateMatrixWorld(true);
    let lift = terrainHeight(b.x, b.z);
    const w = new THREE.Vector3();
    for (const k of this.keel) {
      w.copy(k).applyMatrix4(g.matrixWorld);
      lift = Math.max(lift, terrainHeight(w.x, w.z) - w.y);
    }
    g.position.y = lift - 0.03;
    this.obstacles.length = 0;
    const r = this.beam * 0.5;
    for (const k of [-1, -0.5, 0, 0.5, 1]) this.obstacles.push([b.x + dx * k * (h - r * 0.5), b.z + dz * k * (h - r * 0.5), r * (1 - 0.35 * Math.abs(k))]);
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
