import * as THREE from 'three';

/**
 * Time of day. A full day lasts `dayLength` real seconds (default 7 min). Sun and moon follow a simple
 * spherical-astronomy model for a tropical latitude, so the sun rises ~6:00 in the east, stands high at
 * noon, sets ~18:00 in the west; the moon runs ~50 min later each day and its phase follows from the
 * sun–moon angle (the sky shader lights the disc with the real sun direction).
 */
const LAT = THREE.MathUtils.degToRad(-14);
const SUN_DECL = THREE.MathUtils.degToRad(9);
const MOON_DECL = THREE.MathUtils.degToRad(-4);

function skyDir(hourAngle: number, decl: number, out: THREE.Vector3): THREE.Vector3 {
  // local horizon frame: x = east, y = up, z = south (world: +X east, −Z north)
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(hourAngle);
  const el = Math.asin(sinEl);
  // azimuth from north, clockwise
  const az = Math.atan2(-Math.sin(hourAngle) * Math.cos(decl), Math.cos(LAT) * Math.sin(decl) - Math.sin(LAT) * Math.cos(decl) * Math.cos(hourAngle));
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export class GameTime {
  /** 0..24 */
  hours: number;
  /** days since start (for the moon) */
  day = 0;
  /** real seconds per game day; 0 = clock stopped */
  dayLength: number;
  /** 0 = new moon, 0.5 = full */
  moonPhase0 = 0.42;
  /** P key: stop the clock (admire a sunset) */
  paused = false;

  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();

  constructor(hours: number, dayLengthSec: number, moonPhase: number | null = null, paused = false) {
    this.hours = ((hours % 24) + 24) % 24;
    this.dayLength = dayLengthSec;
    if (moonPhase !== null) this.moonPhase0 = ((moonPhase % 1) + 1) % 1;
    this.paused = paused;
    this.compute();
  }

  get moonPhase(): number {
    return (this.moonPhase0 + this.day / 29.53) % 1;
  }

  /** fraction of the moon disc that is lit, 0..1 */
  get moonLit(): number {
    return 0.5 * (1 - Math.cos(this.moonPhase * Math.PI * 2));
  }

  update(dt: number): void {
    if (this.dayLength > 0 && !this.paused) this.advance((dt / this.dayLength) * 24);
    this.compute();
  }

  advance(h: number): void {
    this.hours += h;
    while (this.hours >= 24) { this.hours -= 24; this.day++; }
    while (this.hours < 0) { this.hours += 24; this.day--; }
    this.compute();
  }

  private compute(): void {
    const H = ((this.hours - 12) / 24) * Math.PI * 2;
    skyDir(H, SUN_DECL, this.sunDir);
    // the moon lags the sun by its phase angle
    skyDir(H - this.moonPhase * Math.PI * 2, MOON_DECL, this.moonDir);
  }

  get label(): string {
    const h = Math.floor(this.hours), m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

/** "18:30", "18.5", "6" → hours */
export function parseTime(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(s.trim());
  if (m) return Number(m[1]) + Number(m[2] ?? 0) / 60;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}
