import * as THREE from 'three';
import type { BoatPhysics } from '../physics/BoatPhysics';
import type { WaveField } from '../environment/WaveField';
import { terrainHeight } from '../world/WorldGen';
import { fadeThrough } from './fade';

/*
 * Kedging off a shoal. When the ship has gone aground and stopped, the crew can take the kedge anchor out
 * in the boat to deep water, let it go, and haul the ship off on the capstan (K). Where to: back along the
 * way she came — the chart's track is water she has already floated in — to the first point with a good
 * depth all round it that can be reached in a straight line; failing a track, the nearest such water round
 * about. The haul is a real force on the hull (the physics' tow), with the grip of the bottom eased, so she
 * slides, heels and floats free; if she won't come after a while, or the player presses K again to hurry,
 * a fade covers moving her there. It costs time: the boat's crew rowing, the capstan walked round.
 */

/** game hours the manoeuvre costs */
export const KEDGE_HOURS = 0.5;
const DRAFT = 2.25;
const ROW_TIME = 3.2;
const HAUL_LIMIT = 40;

type State = 'afloat' | 'aground' | 'rowing' | 'hauling';

export interface KedgeHooks {
  say(text: string, seconds: number): void;
  oar(at: THREE.Vector3): void;
  anchor(at: THREE.Vector3): void;
  capstan(): void;
  scrape(level: number): void;
  /** the manoeuvre is over: advance the clock */
  done(hours: number): void;
}

export class Kedge {
  readonly group = new THREE.Group();
  state: State = 'afloat';
  private stuckT = 0;
  private t = 0;
  private freeT = 0;
  private pawl = 0;
  private oarT = 0;
  /** a fade is under way (it finishes the manoeuvre itself) */
  private hurrying = false;
  private readonly anchor = new THREE.Vector3();
  /** where she stuck, and the heading away from it */
  private readonly stuckAt = new THREE.Vector3();
  private away = 0;
  private readonly buoy: THREE.Group;
  private readonly rope: THREE.Mesh;
  private readonly prompt = document.createElement('div');
  private readonly n = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };

  constructor(private readonly body: BoatPhysics, private readonly hooks: KedgeHooks, private readonly track: () => number[][]) {
    // the anchor's buoy: a cork float with a little flag of a stick
    this.buoy = new THREE.Group();
    const cork = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.9 }));
    cork.scale.y = 0.7;
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.8 }));
    stick.position.y = 0.45;
    this.buoy.add(cork, stick);
    // the cable from the ship to the buoy: a unit cylinder stretched between them each frame
    this.rope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 6).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x8a7552, roughness: 0.95 }));
    this.group.add(this.buoy, this.rope);
    this.group.visible = false;
    this.group.name = 'kedge';
    this.prompt.id = 'kedge';
    this.prompt.hidden = true;
    this.prompt.innerHTML = 'Osiedliśmy na mieliźnie! &nbsp;<kbd>K</kbd> — wywieźć kotwicę i ściągnąć statek';
    document.body.append(this.prompt);
  }

  /** once per frame; `kPressed`: the K key this frame */
  update(dt: number, t: number, kPressed: boolean, waves: WaveField): void {
    const b = this.body, o = b.origin;
    this.t += dt;
    switch (this.state) {
      case 'afloat':
      case 'aground': {
        // aground = touching bottom and (all but) stopped for a couple of seconds
        this.stuckT = b.grounded && b.speed < 0.35 ? this.stuckT + dt : 0;
        this.state = this.stuckT > 2 ? 'aground' : 'afloat';
        this.prompt.hidden = this.state !== 'aground';
        if (this.state === 'aground' && kPressed) this.start();
        break;
      }
      case 'rowing': {
        if (this.hurrying) break;
        // the boat pulls away with the anchor; oars dip every ~0.8 s, fading into the distance
        this.oarT -= dt;
        const k = Math.min(1, this.t / ROW_TIME);
        if (this.oarT <= 0) { this.oarT = 0.8; this.hooks.oar(o.clone().lerp(this.anchor, k)); }
        if (kPressed) { this.hurry(); break; }
        if (this.t >= ROW_TIME) {
          this.hooks.anchor(this.anchor);
          this.hooks.say('Kotwica rzucona — na kabestan!', 3);
          this.state = 'hauling';
          this.t = 0;
          this.group.visible = true;
          // haul from whichever end faces the anchor
          const f = new THREE.Vector3(Math.sin(b.heading), 0, Math.cos(b.heading));
          b.towFromBow = f.dot(this.anchor.clone().sub(o)) > 0;
          b.tow = this.anchor;
          b.groundGrip = 0.12;
          b.setSails(false);
        }
        break;
      }
      case 'hauling': {
        if (this.hurrying) break;
        // the capstan clicks round; the hull grinds while it drags over the bottom
        this.pawl -= dt * Math.max(0.6, b.speed * 1.8);
        if (this.pawl <= 0) { this.pawl = 0.35; this.hooks.capstan(); }
        this.hooks.scrape(b.grounded ? Math.min(1, b.speed / 1.2) : 0);
        this.freeT = !b.grounded && this.depthUnder(o) > DRAFT + 0.6 ? this.freeT + dt : 0;
        const toGo = Math.hypot(o.x - this.anchor.x, o.z - this.anchor.z);
        const total = Math.max(1, Math.hypot(this.stuckAt.x - this.anchor.x, this.stuckAt.z - this.anchor.z));
        let turn = this.away - b.heading;
        turn = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
        if (kPressed || this.t > HAUL_LIMIT) { this.hurry(); break; }
        // first the capstan hauls her off; once she floats well clear, the cable is slacked and she is warped
        // round to face away from the shoal
        if (b.tow && (toGo < 12 || (this.freeT > 1 && toGo < total * 0.6))) {
          b.tow = null;
          b.groundGrip = 1;
          b.warpTo = this.away;
          this.hooks.say('Wolna! Obracamy ją dziobem od mielizny…', 3);
        }
        if (!b.tow && turn < 0.3 && Math.abs(b.angVel.y) < 0.12) this.finish('Statek na wolnej wodzie.');
        break;
      }
    }
    this.rope.visible = !!this.body.tow;
    if (this.group.visible) this.place(t, waves);
  }

  /** how much water under a point (m) */
  private depthUnder(p: THREE.Vector3): number {
    return -terrainHeight(p.x, p.z);
  }

  /** deep enough all round a hull's length, here? */
  private clear(x: number, z: number): boolean {
    if (terrainHeight(x, z) > -(DRAFT + 1)) return false;
    for (const r of [7, 14]) for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (terrainHeight(x + Math.cos(a) * r, z + Math.sin(a) * r) > -(DRAFT + 0.5)) return false;
    }
    return true;
  }

  /** nothing between here and there that the keel would hit (starting a little way off the shoal) */
  private reachable(from: THREE.Vector3, x: number, z: number): boolean {
    const d = Math.hypot(x - from.x, z - from.z);
    for (let s = 14; s < d; s += 4) {
      const k = s / d;
      if (terrainHeight(from.x + (x - from.x) * k, from.z + (z - from.z) * k) > -(DRAFT + 0.2)) return false;
    }
    return true;
  }

  /** where to take the kedge: back along the track, or else the nearest deep water round about */
  private findWater(from: THREE.Vector3): THREE.Vector3 | null {
    const pts: [number, number][] = [];
    for (const seg of this.track()) for (let i = 0; i < seg.length; i += 2) pts.push([seg[i], seg[i + 1]]);
    let walked = 0;
    for (let i = pts.length - 1; i >= 0 && walked < 900; i--) {
      const [x, z] = pts[i];
      if (i < pts.length - 1) walked += Math.hypot(x - pts[i + 1][0], z - pts[i + 1][1]);
      if (Math.hypot(x - from.x, z - from.z) < 25) continue;
      if (this.clear(x, z) && this.reachable(from, x, z)) return new THREE.Vector3(x, 0, z);
    }
    for (let r = 25; r <= 320; r += 12)
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, x = from.x + Math.cos(a) * r, z = from.z + Math.sin(a) * r;
        if (this.clear(x, z) && this.reachable(from, x, z)) return new THREE.Vector3(x, 0, z);
      }
    return null;
  }

  private start(): void {
    const o = this.body.origin.clone();
    const w = this.findWater(o);
    if (!w) { this.hooks.say('Nie ma gdzie zawieźć kotwicy — tylko reset (R).', 4); return; }
    this.anchor.copy(w);
    this.stuckAt.copy(o);
    this.away = Math.atan2(w.x - o.x, w.z - o.z);
    this.state = 'rowing';
    this.t = 0;
    this.oarT = 0;
    this.prompt.hidden = true;
    this.hooks.say('Szalupa na wodę — wywozimy kotwicę…', 3);
  }

  /** hurry it up (K again, or she won't come): a fade over putting her in the anchor's water */
  private hurry(): void {
    this.hurrying = true;
    fadeThrough(() => {
      const a = this.anchor;
      // head away from the shoal
      this.body.reset(new THREE.Vector3(a.x, 0, a.z), Math.PI - this.away, 0);
      this.hurrying = false;
      this.finish('Ściągnęliśmy statek z mielizny.');
    });
  }

  private finish(msg: string): void {
    const b = this.body;
    b.tow = null;
    b.warpTo = null;
    b.groundGrip = 1;
    this.hooks.scrape(0);
    this.group.visible = false;
    this.state = 'afloat';
    this.stuckT = 0;
    this.freeT = 0;
    this.hooks.done(KEDGE_HOURS);
    this.hooks.say(`${msg} Straciliśmy ${KEDGE_HOURS === 0.5 ? 'pół godziny' : `${KEDGE_HOURS} h`}. Postaw żagle (X).`, 5);
  }

  /** the buoy rides the waves; the cable runs from the ship's end to it */
  private place(t: number, waves: WaveField): void {
    const a = this.anchor;
    waves.sample(a.x, a.z, t, this.n);
    this.buoy.position.set(a.x, this.n.height, a.z);
    const b = this.body, q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.heading);
    const end = new THREE.Vector3(0, 0.9, b.towFromBow ? 8.5 : -8.5).applyQuaternion(q).add(b.origin);
    const to = this.buoy.position.clone().setY(this.n.height + 0.1);
    this.rope.position.copy(end);
    this.rope.lookAt(to);
    this.rope.scale.set(1, 1, end.distanceTo(to));
  }
}
