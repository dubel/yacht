import * as THREE from 'three';
import type { WaveField } from '../environment/WaveField';
import { patchUnderwater } from '../render/water/underwaterLight';

/*
 * Minimal gameplay loop (MILESTONES M14): round the marks in any order, then return to the start.
 * Buoys float on the same Gerstner water as the boat. Best time is kept in localStorage.
 */

interface Mark {
  name: string;
  x: number;
  z: number;
  done: boolean;
  mesh: THREE.Group;
}

const MARKS: [string, number, number][] = [
  ['Palmowa Wyspa', 118, -78],
  ['Skała Mew', 72, -205],
  ['Zatoka Zachodnia', -85, -25],
  ['Południowy Cypel', -15, 185],
  ['Przejście w rafie', 300, 205],
];

const REACH = 22;
const HOME = [0, -12];
const BEST_KEY = 'lagoon.bestTime';

function buoyMesh(color: number): THREE.Group {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.6, 16), red);
  body.position.y = 0.2;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 0.7, 16), white);
  band.position.y = 1.35;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.3, 16), red);
  cone.position.y = 2.35;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), dark);
  pole.position.y = 4.0;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), new THREE.MeshStandardMaterial({ color: 0xffc83a, side: THREE.DoubleSide, roughness: 0.7 }));
  flag.position.set(0.58, 4.8, 0);
  flag.name = 'flag';
  for (const m of [red, white, dark]) m.onBeforeCompile = patchUnderwater;
  for (const m of [body, band, cone, pole, flag]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
  return g;
}

export class Mission {
  readonly group = new THREE.Group();
  readonly marks: Mark[] = [];
  private readonly home: THREE.Group;
  elapsed = 0;
  finished = false;
  best: number | null = null;
  /** transient message for the HUD */
  message = '';
  private messageT = 0;
  private readonly n = { height: 0, nx: 0, ny: 1, nz: 0, vy: 0 };

  constructor(depthAt: (x: number, z: number) => number) {
    for (const [name, x0, z0] of MARKS) {
      // nudge each mark to navigable water (≥ 3 m deep)
      let x = x0, z = z0;
      for (let r = 0; r < 60 && depthAt(x, z) > -3; r += 3) {
        const a = r * 0.7;
        x = x0 + Math.cos(a) * r;
        z = z0 + Math.sin(a) * r;
      }
      const mesh = buoyMesh(0xc8322b);
      this.group.add(mesh);
      this.marks.push({ name, x, z, done: false, mesh });
    }
    this.home = buoyMesh(0x2b7a3a);
    this.home.visible = false;
    this.group.add(this.home);
    try {
      const b = localStorage.getItem(BEST_KEY);
      this.best = b ? Number(b) : null;
    } catch { /* storage unavailable */ }
    this.say(`Opłyń ${this.marks.length} boi i wróć na start`, 8);
  }

  /** show a transient message on the HUD */
  say(text: string, seconds: number): void {
    this.message = text;
    this.messageT = seconds;
  }

  get remaining(): number {
    return this.marks.filter((m) => !m.done).length;
  }

  /** the target to point at: nearest unvisited mark, or home */
  target(from: THREE.Vector3): { name: string; x: number; z: number; dist: number } | null {
    if (this.finished) return null;
    let best: Mark | null = null, bd = Infinity;
    for (const m of this.marks) {
      if (m.done) continue;
      const d = Math.hypot(m.x - from.x, m.z - from.z);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) return { name: best.name, x: best.x, z: best.z, dist: bd };
    return { name: 'Start', x: HOME[0], z: HOME[1], dist: Math.hypot(from.x - HOME[0], from.z - HOME[1]) };
  }

  update(dt: number, t: number, boat: THREE.Vector3, waves: WaveField): void {
    if (!this.finished) this.elapsed += dt;
    this.messageT -= dt;
    if (this.messageT <= 0) this.message = '';
    const float = (g: THREE.Group, x: number, z: number) => {
      waves.sample(x, z, t, this.n);
      g.position.set(x, this.n.height - 0.35, z);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(this.n.nx, this.n.ny, this.n.nz));
      const flag = g.getObjectByName('flag');
      if (flag) flag.rotation.y = Math.sin(t * 2.3 + x) * 0.25;
    };
    for (const m of this.marks) {
      float(m.mesh, m.x, m.z);
      if (!m.done && Math.hypot(m.x - boat.x, m.z - boat.z) < REACH) {
        m.done = true;
        m.mesh.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (mat && o.name !== 'flag' && mat.color.getHex() === 0xc8322b) { mat.color.set(0x4a8f55); }
        });
        this.say(this.remaining ? `✓ ${m.name} — zostało ${this.remaining}` : '✓ Wszystkie boje! Wracaj na start', 5);
      }
    }
    this.home.visible = this.remaining === 0 && !this.finished;
    if (this.home.visible) {
      float(this.home, HOME[0], HOME[1]);
      if (Math.hypot(boat.x - HOME[0], boat.z - HOME[1]) < REACH) {
        this.finished = true;
        const time = this.elapsed;
        const record = this.best === null || time < this.best;
        if (record) {
          this.best = time;
          try { localStorage.setItem(BEST_KEY, String(time)); } catch { /* ignore */ }
        }
        this.say(`Meta! Czas ${fmt(time)}${record ? ' — nowy rekord!' : ''}`, 15);
      }
    }
  }
}

export function fmt(s: number): string {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
