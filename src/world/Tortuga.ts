import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fadeThrough } from '../gameplay/fade';
import { Cell, measure, Placed, type Measured, type StructureDef } from './structures';
import { TORTUGA_QUAY, terrainHeight } from './WorldGen';

/*
 * Tortuga's waterfront. Along the whole length of the quay runs a boardwalk, half over the water; off it, out
 * into the dredged basin, a jumble of piers, wharves and shacks on stilts — no two alike, as a pirates' haven
 * would have them, but all built square to the quay and floored at one height, so a man walks from one to the
 * next without a step. (The town behind it comes later.)
 *
 * The ship comes alongside any of them: the hull meets the timbers as it would fenders (BoatPhysics.fenders),
 * and no jolly boat is wanted here — slowed down beside a pier, B makes her fast and puts the sailor on the
 * boards (a fade); walking back to her, B takes him aboard. Ashore he goes where the boards and the ground
 * take him, but never off the edge into the harbour.
 */

/** the height of every floor on the waterfront (m): a hand over the quay */
const DECK = TORTUGA_QUAY.land + 0.15;
/** how near her side (m) he must be to go aboard (a gangway is run out to the pier) */
const BOARD_R = 7;
/** the boardwalk's middle, off the quay line (m, toward the water) */
const WALK_X = 2.4;

/** the models: turned so the pier runs out along +x (the water), the land end at −x */
const MODELS: Record<string, StructureDef> = {
  // "Rustic Wooden Dock" — Evan16; "Low Poly Dock" — tomk6505; "Elven Wharf" — valentin321; "Dock Pier" —
  // pixol3d; "The Gorilla Tag Beach Dock" — KPMisParrot (all CC-BY-4.0); "Dock House - Stylized Wooden Pier"
  // — voyoo (Sketchfab Standard). See README.
  rustic: { url: 'assets/tortuga/rustic.glb', scale: 0.85, turn: Math.PI / 2 },
  lowdock: { url: 'assets/tortuga/lowdock.glb', scale: 1, turn: Math.PI / 2 },
  wharf: { url: 'assets/tortuga/wharf.glb', scale: 0.011, turn: -Math.PI / 2 },
  hut: { url: 'assets/tortuga/pier.glb', scale: 1, turn: Math.PI / 2 },
  beach: { url: 'assets/tortuga/beachdock.glb', scale: 1, turn: Math.PI / 2 },
  house: { url: 'assets/tortuga/dockhouse.glb', scale: 1.6, turn: Math.PI / 2 },
};

/**
 * The piers out from the boardwalk, south to north: which model, where along the quay (m from its middle),
 * turned end for end (its far end to the quay), and another model carrying it on further out. Berths of
 * ~11 m between them: room for the ship to lie alongside.
 */
const PIERS: [string, number, boolean?, string?][] = [
  ['lowdock', -168],
  ['house', -150, true],
  ['rustic', -132, false, 'lowdock'],
  ['hut', -108],
  ['lowdock', -86],
  ['beach', -58],
  ['rustic', -30],
  ['wharf', -6],
  ['house', 16],
  ['lowdock', 32, false, 'rustic'],
  ['hut', 54],
  ['rustic', 76],
  ['wharf', 100],
  ['lowdock', 122],
  ['house', 138, true],
  ['rustic', 156, false, 'lowdock'],
];
/** the Elven Wharf's pale stone-like planks, weathered to the others' wood */
const WHARF_TINT = new THREE.Color(0.78, 0.6, 0.44);

export interface TortugaHooks {
  say(text: string, seconds: number): void;
  /** make the ship fast where she lies (the crew takes in sail) */
  moor(): void;
  /** put the sailor ashore at `stand`, facing `yaw` */
  goAshore(stand: THREE.Vector2, yaw: number): void;
  comeAboard(): void;
}

/** the ship as the waterfront sees her */
export interface ShipState {
  origin: THREE.Vector3;
  heading: number;
  speed: number;
  bow: number;
  stern: number;
  beam: number;
}

export class Tortuga {
  readonly group = new THREE.Group();
  ashore = false;
  private placed: Placed[] = [];
  private readonly byName = new Map<string, Placed[]>();
  private ready = false;
  private readonly hint = document.createElement('div');
  private busy = false;
  private findT = 0;
  private berth: { stand: THREE.Vector2; yaw: number } | null = null;

  constructor(private readonly hooks: TortugaHooks) {
    this.group.name = 'tortuga';
    this.hint.className = 'landhint';
    this.hint.hidden = true;
    document.body.append(this.hint);
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const names = Object.keys(MODELS);
    const scenes = await Promise.all(names.map((n) => loader.loadAsync(MODELS[n].url)));
    const measured: Record<string, Measured> = {};
    names.forEach((n, k) => (measured[n] = measure(scenes[k].scene, MODELS[n])));
    // (the boardwalk is the rustic dock too, kept apart from the rustic piers laid over it)
    measured.walkway = measured.rustic;
    // ---- the layout ----
    const Q = TORTUGA_QUAY, mid = (Q.z0 + Q.z1) / 2;
    const at: { m: string; x: number; z: number; turn: number }[] = [];
    // the boardwalk: rustic docks laid end to end along the quay (turned to run north–south)
    const walk = measured.walkway, len = walk.box.max.x - walk.box.min.x - 0.3;
    const n = Math.ceil((Q.z1 - Q.z0 + 20) / len);
    for (let k = 0; k < n; k++) at.push({ m: 'walkway', x: Q.x + WALK_X, z: Q.z0 - 10 + len * (k + 0.5), turn: Math.PI / 2 });
    // the piers, the boards at their land end laid over the boardwalk's outer edge (past its edge beam: no gap
    // to step over), and those carried on further out the same way off the end of the first
    // (the boardwalk is turned a quarter round: its own z across it is the world's x)
    const edge = Q.x + WALK_X + walk.walk.maxZ - 1.6;
    for (const [m, z, mirror, ext] of PIERS) {
      const w = measured[m].walk, b = measured[m].box;
      // (turned end for end: half round about the vertical, its far end now on the boardwalk)
      const turn = mirror ? Math.PI : 0;
      const x = mirror ? edge + w.maxX : edge - w.minX;
      const zc = (b.max.z + b.min.z) / 2;
      at.push({ m, x, z: mid + z + (mirror ? zc : -zc), turn });
      if (ext) {
        const far = (mirror ? x - w.minX : x + w.maxX) - 0.4, e = measured[ext];
        at.push({ m: ext, x: far - e.walk.minX, z: mid + z - (e.box.max.z + e.box.min.z) / 2, turn: 0 });
      }
    }
    // ---- the meshes: one instanced mesh per model part, a copy per placing ----
    for (const name of [...names, 'walkway']) {
      const mine = at.filter((a) => a.m === name);
      if (!mine.length) continue;
      // (the piers a finger's breadth over the boardwalk they lie on: no flicker where the planks overlap)
      const m = measured[name], y = DECK - m.deck + (name === 'walkway' ? 0 : 0.04);
      const mats = mine.map((a) => new THREE.Matrix4().compose(new THREE.Vector3(a.x, y, a.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a.turn), new THREE.Vector3(1, 1, 1)));
      for (const p of m.parts) {
        if (name === 'wharf') (p.mat as THREE.MeshStandardMaterial).color.multiply(WHARF_TINT);
        const mesh = new THREE.InstancedMesh(p.geo, p.mat, mine.length);
        mats.forEach((mt, k) => mesh.setMatrixAt(k, mt));
        mesh.computeBoundingSphere();
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.name = `tortuga ${name}`;
        this.group.add(mesh);
      }
      const list = mine.map((a) => new Placed(m, a.x, y, a.z, a.turn));
      this.placed.push(...list);
      this.byName.set(name, list);
    }
    this.ready = true;
  }

  // ------------------------------------------------------------------ what is where

  /** near enough the waterfront for its rules to matter */
  near(x: number, z: number, margin = 0): boolean {
    const Q = TORTUGA_QUAY;
    return x > Q.x - 90 - margin && x < Q.x + 90 + margin && z > Q.z0 - 50 - margin && z < Q.z1 + 50 + margin;
  }

  /** the boards underfoot at (x, z): their height, or null */
  floorAt(x: number, z: number): number | null {
    if (!this.ready || !this.near(x, z)) return null;
    let best: number | null = null;
    for (const p of this.placed) if (p.cell(x, z) === Cell.Walk) { const h = p.height(x, z); if (best === null || h > best) best = h; }
    return best;
  }

  /** can't a man be at (x, z)? — in the way of something, or off the boards over the water */
  blocked(x: number, z: number): boolean {
    if (!this.ready || !this.near(x, z)) return false;
    let walk = false, block = false;
    for (const p of this.placed) {
      const c = p.cell(x, z);
      if (c === Cell.Walk) walk = true;
      else if (c === Cell.Block) block = true;
    }
    if (walk) return false;
    if (block) return true;
    // off the boards: dry ground only
    return terrainHeight(x, z) < 0.35;
  }

  /** for the hull: the way out of a structure it is in at (x, z), or null */
  push(x: number, z: number): [number, number] | null {
    if (!this.ready || !this.near(x, z, 30)) return null;
    for (const p of this.placed) { const o = p.out(x, z); if (o) return o; }
    return null;
  }

  /** a place to step ashore from the ship: boards alongside her, the nearest to her middle */
  private findBerth(s: ShipState): { stand: THREE.Vector2; yaw: number } | null {
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading), rx = fz, rz = -fx;
    const L = s.bow - s.stern, midL = (s.bow + s.stern) / 2;
    for (const along of [0, 0.15, -0.15, 0.3, -0.3, 0.42, -0.42])
      for (const side of [1, -1])
        for (let out = s.beam / 2 + 0.3; out < s.beam / 2 + BOARD_R - 1; out += 0.5) {
          const a = midL + along * L;
          const x = s.origin.x + fx * a + rx * side * out, z = s.origin.z + fz * a + rz * side * out;
          if (this.floorAt(x, z) === null || this.blocked(x, z)) continue;
          // a little further onto the boards, if they go on (not standing on the very edge)
          const x2 = x + rx * side * 1, z2 = z + rz * side * 1;
          const stand = this.floorAt(x2, z2) !== null && !this.blocked(x2, z2) ? new THREE.Vector2(x2, z2) : new THREE.Vector2(x, z);
          // facing away from her
          return { stand, yaw: Math.atan2(rx * side, rz * side) };
        }
    return null;
  }

  /** how far (m) the sailor at p is from the ship's side */
  private fromShip(p: THREE.Vector2, s: ShipState): number {
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    const dx = p.x - s.origin.x, dz = p.y - s.origin.z;
    const a = dx * fx + dz * fz, b = Math.abs(dx * fz - dz * fx);
    const along = Math.max(s.stern - a, 0, a - s.bow), across = Math.max(0, b - s.beam / 2);
    return Math.hypot(along, across);
  }

  /**
   * Once per frame. Aboard: B makes her fast at a pier and puts him ashore; ashore: B by her side takes him
   * back. `canGo`: free to (not at a gun, the map shut). Returns whether the waterfront has the B key here
   * (the jolly boat stays in its chocks).
   */
  update(dt: number, s: ShipState, sailor: THREE.Vector2 | null, b: boolean, canGo: boolean): boolean {
    if (!this.ready) return false;
    // (drawn only from within ~1 km: further off, the piers are specks)
    this.group.visible = Math.hypot(s.origin.x - TORTUGA_QUAY.x, s.origin.z) < 1200 || this.ashore;
    const mine = this.ashore || this.near(s.origin.x, s.origin.z, 60);
    if (!mine || this.busy) { this.hint.hidden = true; return mine; }
    if (!this.ashore) {
      this.findT -= dt;
      if (this.findT <= 0) { this.findT = 0.4; this.berth = this.findBerth(s); }
      const slow = s.speed < 1.3;
      this.hint.hidden = !this.berth || !canGo;
      if (this.berth) this.hint.innerHTML = slow ? '<kbd>B</kbd> — zacumuj i zejdź na keję · Tortuga' : 'Tortuga — zwolnij, by przybić do kei';
      if (b && canGo) {
        if (!this.berth) this.hooks.say('Podejdź burtą do kei albo pomostu, by przybić.', 3);
        else if (!slow) this.hooks.say(`Za szybko, by przybić (${(s.speed * 1.943844).toFixed(1)} kn) — zwiń żagle (X).`, 3);
        else {
          const berth = this.berth;
          this.busy = true;
          fadeThrough(() => {
            this.hooks.moor();
            this.hooks.goAshore(berth.stand, berth.yaw);
            this.ashore = true;
            this.busy = false;
          });
        }
      }
      return true;
    }
    // ashore: back aboard from beside her
    const d = sailor ? this.fromShip(sailor, s) : Infinity;
    this.hint.hidden = d > BOARD_R;
    this.hint.innerHTML = '<kbd>B</kbd> — wejdź na statek';
    if (b && canGo) {
      if (d <= BOARD_R) {
        this.busy = true;
        fadeThrough(() => {
          this.ashore = false;
          this.hooks.comeAboard();
          this.busy = false;
          this.hooks.say('Statek stoi przy kei — podnieś kotwicę (Z), by odbić.', 4);
        });
      } else this.hooks.say(`Statek stoi przy kei — ${Math.round(d)} m stąd.`, 3);
    }
    return true;
  }

  /** straight ashore beside her (no fade: at the start) */
  goAshoreNow(s: ShipState): void {
    const berth = this.findBerth(s);
    if (!berth) return;
    this.hooks.goAshore(berth.stand, berth.yaw);
    this.ashore = true;
  }

  /** a berth for `?location=tortuga`: the ship alongside the big wharf's north side, bow out to sea */
  berthFor(s: { bow: number; stern: number; beam: number }): { x: number; z: number; heading: number } {
    const w = this.byName.get('wharf')![0];
    return { x: (w.minX + w.maxX) / 2 + 4 - (s.bow + s.stern) / 2, z: w.maxZ + s.beam / 2 + 0.7, heading: Math.PI / 2 };
  }
}
