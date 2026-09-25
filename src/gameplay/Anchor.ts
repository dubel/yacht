import * as THREE from 'three';
import type { BoatPhysics } from '../physics/BoatPhysics';
import { terrainHeight } from '../world/WorldGen';

/*
 * Coming to anchor (Z). A ship came to anchor off an island, never up to its beach: in the roads, in 5–20 m
 * of water, with the sails taken in and the way all but off her. The anchor is let go from the bow and the
 * hemp cable veered to about four times the depth; she drops back on it and swings to it with the wind,
 * bow on (the physics' cable force at the hawse). Z again weighs it: the capstan walked round, the cable
 * coming in and drawing her up over the anchor until it breaks out of the ground. In a white squall the
 * anchor may not hold — it drags, ploughing the bottom, and the crew calls it.
 */

const MIN_DEPTH = 3, MAX_DEPTH = 28;
/** faster than this (m/s, ~1.5 kn) she is still under way: no letting go */
const MAX_SPEED = 0.8;
/** cable veered per metre of depth */
const SCOPE = 4;
/** wind (m/s) above which the anchor no longer holds everything */
const HOLD_WIND = 17;

type State = 'aweigh' | 'riding' | 'weighing';

export interface AnchorHooks {
  say(text: string, seconds: number): void;
  /** it was let go at `at` (the hawse, on the water) */
  letGo(at: THREE.Vector3): void;
  capstan(): void;
  /** the hawse (where the cable leaves the bow), in world space */
  hawse(out: THREE.Vector3): THREE.Vector3;
}

export class Anchor {
  readonly group = new THREE.Group();
  state: State = 'aweigh';
  /** depth it lies in (m) */
  depth = 0;
  private pawl = 0;
  private dragged = 0;
  private dragSaid = -Infinity;
  private t = 0;
  private readonly rope: THREE.Mesh;
  private readonly from = new THREE.Vector3();

  constructor(private readonly body: BoatPhysics, private readonly hooks: AnchorHooks) {
    // the cable from the hawse down into the water toward the anchor: a unit cylinder stretched each frame
    this.rope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x7d6a4a, roughness: 0.95 }));
    this.group.add(this.rope);
    this.group.visible = false;
    this.group.name = 'anchor cable';
  }

  get riding(): boolean {
    return this.state === 'riding';
  }

  /** once per frame; `zPressed`: the Z key this frame; `wind`: true wind speed (m/s); `busy`: aground / kedging */
  update(dt: number, zPressed: boolean, wind: number, busy: boolean): void {
    const b = this.body;
    this.t += dt;
    // (a reset, or the kedge moving her, leaves no anchor down)
    if (this.state !== 'aweigh' && !b.anchor) this.state = 'aweigh';
    switch (this.state) {
      case 'aweigh':
        if (zPressed) this.letGo(busy);
        break;
      case 'riding': {
        // a white squall: more than the ground holds — she drags
        b.anchorHold = wind > HOLD_WIND ? b.mass * (0.35 - 0.012 * (wind - HOLD_WIND)) : Infinity;
        this.dragged = b.anchorDrag > 0 ? this.dragged + b.anchorDrag : Math.max(0, this.dragged - dt * 0.2);
        if (this.dragged > 3 && this.t - this.dragSaid > 12) {
          this.dragSaid = this.t;
          this.hooks.say('Kotwica orze dno — dryfujemy!', 4);
        }
        if (zPressed) {
          this.state = 'weighing';
          this.t = 0;
          b.anchorHold = Infinity;
          b.heaving = true;
          this.hooks.say('Na kabestan — podnieść kotwicę!', 3);
        }
        break;
      }
      case 'weighing': {
        // the capstan hauls the cable in: she is drawn up to the anchor, then it breaks out of the ground
        const h = this.hooks.hawse(this.from), a = b.anchor!;
        const d = Math.hypot(a.x - h.x, a.z - h.z);
        b.rode = Math.min(b.rode, d / 0.85);
        this.pawl -= dt;
        if (this.pawl <= 0) { this.pawl = 0.4; this.hooks.capstan(); }
        if (d < Math.max(3, this.depth * 0.6) || this.t > 45) {
          b.anchor = null;
          b.heaving = false;
          this.state = 'aweigh';
          this.hooks.say('Kotwica na pokładzie. Postaw żagle (X).', 4);
        }
        break;
      }
    }
    this.group.visible = this.state !== 'aweigh';
    if (this.group.visible) this.place();
  }

  /** let go here and now, whatever the speed (for starting a game at anchor: ?location) */
  dropNow(): void {
    this.body.velocity.set(0, 0, 0);
    this.letGo(false);
  }

  private letGo(busy: boolean): void {
    const b = this.body, h = this.hooks.hawse(this.from);
    if (busy) { this.hooks.say('Najpierw zejdźmy z mielizny (K).', 3); return; }
    if (b.speed > MAX_SPEED) {
      this.hooks.say(`Za szybko na kotwicę (${(b.speed * 1.943844).toFixed(1)} kn) — zwiń żagle (X) i wytrać prędkość.`, 4);
      return;
    }
    const depth = -terrainHeight(h.x, h.z);
    if (depth < MIN_DEPTH) { this.hooks.say(`Za płytko na kotwicę (${Math.max(0, depth).toFixed(1)} m).`, 3); return; }
    if (depth > MAX_DEPTH) {
      this.hooks.say(`Za głęboko na kotwicę (${depth > 60 ? 'ponad 60' : Math.round(depth)} m) — podejdź bliżej brzegu, na 5–25 m.`, 4);
      return;
    }
    this.depth = depth;
    b.anchor = new THREE.Vector3(h.x, -depth, h.z);
    b.rode = Math.max(18, depth * SCOPE);
    b.anchorHold = Infinity;
    b.setSails(false);
    this.state = 'riding';
    this.dragged = 0;
    this.hooks.letGo(new THREE.Vector3(h.x, 0, h.z));
    this.hooks.say(`Rzucić kotwicę! ${Math.round(depth)} m wody, wydano ${Math.round(b.rode)} m liny.`, 4);
  }

  /** the cable: from the hawse, down and away toward where the anchor lies */
  private place(): void {
    const b = this.body, a = b.anchor!;
    const h = this.hooks.hawse(this.from);
    // it leaves the hawse at an angle: steep when slack, flatter as it comes taut
    const d = Math.hypot(a.x - h.x, a.z - h.z) || 1;
    const taut = THREE.MathUtils.clamp((d - b.rode * 0.6) / (b.rode * 0.4 + 1), 0, 1);
    const reach = Math.min(d, 2 + 10 * taut);
    const to = new THREE.Vector3(h.x + ((a.x - h.x) / d) * reach, h.y - (4 + 4 * (1 - taut)), h.z + ((a.z - h.z) / d) * reach);
    this.rope.position.copy(h);
    this.rope.lookAt(to);
    this.rope.scale.set(1, 1, h.distanceTo(to));
  }
}
