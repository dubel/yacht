import * as THREE from 'three';
import type { WaveField } from '../environment/WaveField';
import { patchUnderwater } from '../render/water/underwaterLight';
import { gatesNear } from './WorldGen';

/*
 * Lateral marks at the reef passes (IALA region A): entering a lagoon from the sea, the red can with a
 * cylinder topmark is left to port, the green cone with a cone topmark to starboard. They float on the
 * same waves as the boat and flash their colour at night. Marks are kept for the lagoons around the camera
 * and refreshed as it moves (the atolls are procedural, see WorldGen).
 */

const RANGE = 3000;
const RED = 0xb8261f, GREEN = 0x1f7a3a;

function makeMaterials(color: number) {
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const light = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color === RED ? 0xff3322 : 0x33ff66, emissiveIntensity: 0 });
  body.onBeforeCompile = patchUnderwater;
  return { body, light };
}

export class ChannelMarkers {
  readonly group = new THREE.Group();
  private readonly marks = new Map<string, THREE.Group>();
  private readonly mat = { port: makeMaterials(RED), starboard: makeMaterials(GREEN) };
  private readonly dark = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 });
  private readonly geo = {
    can: new THREE.CylinderGeometry(0.8, 0.9, 1.9, 16),
    coneBase: new THREE.CylinderGeometry(0.95, 1.0, 0.7, 16),
    cone: new THREE.ConeGeometry(0.95, 1.5, 16),
    pole: new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6),
    topCan: new THREE.CylinderGeometry(0.28, 0.28, 0.55, 12),
    topCone: new THREE.ConeGeometry(0.32, 0.55, 12),
    lamp: new THREE.SphereGeometry(0.13, 10, 8),
  };
  private readonly last = new THREE.Vector2(Infinity, Infinity);
  private readonly n = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly nrm = new THREE.Vector3();

  constructor() {
    this.dark.onBeforeCompile = patchUnderwater;
    this.group.name = 'channel marks';
  }

  private build(port: boolean): THREE.Group {
    const g = new THREE.Group();
    const m = port ? this.mat.port : this.mat.starboard, G = this.geo;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number) => {
      const o = new THREE.Mesh(geo, mat);
      o.position.y = y;
      o.castShadow = o.receiveShadow = true;
      g.add(o);
    };
    let top: number;
    if (port) { add(G.can, m.body, 0.55); top = 1.5; }
    else { add(G.coneBase, m.body, -0.05); add(G.cone, m.body, 1.05); top = 1.75; }
    add(G.pole, this.dark, top + 0.8);
    add(port ? G.topCan : G.topCone, m.body, top + 1.75);
    add(G.lamp, m.light, top + 2.2);
    return g;
  }

  /** once per frame */
  update(t: number, focus: THREE.Vector3, waves: WaveField, night: number): void {
    if (Math.hypot(focus.x - this.last.x, focus.z - this.last.y) > 150) {
      this.last.set(focus.x, focus.z);
      const keep = new Set<string>();
      for (const gt of gatesNear(focus.x, focus.z, RANGE)) {
        const key = `${gt.x.toFixed(1)},${gt.z.toFixed(1)}`;
        keep.add(key);
        if (this.marks.has(key)) continue;
        const g = this.build(gt.port);
        g.userData = { x: gt.x, z: gt.z };
        this.marks.set(key, g);
        this.group.add(g);
      }
      for (const [key, g] of this.marks) if (!keep.has(key)) { this.group.remove(g); this.marks.delete(key); }
    }
    for (const g of this.marks.values()) {
      const { x, z } = g.userData as { x: number; z: number };
      waves.sample(x, z, t, this.n);
      g.position.set(x, this.n.height - 0.35, z);
      g.quaternion.setFromUnitVectors(this.up, this.nrm.set(this.n.nx, this.n.ny, this.n.nz));
    }
    // flashing lights, visible from dusk: red "Fl R 4s", green "Fl G 4s" offset by half a period
    const k = THREE.MathUtils.smoothstep(night, 0.05, 0.5) * 6;
    this.mat.port.light.emissiveIntensity = (t % 4 < 0.6 ? 1 : 0) * k;
    this.mat.starboard.light.emissiveIntensity = ((t + 2) % 4 < 0.6 ? 1 : 0) * k;
  }
}
