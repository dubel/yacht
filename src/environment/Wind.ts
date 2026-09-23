import { noise1 } from '../core/noise';

/**
 * Single source of truth for wind. Direction is meteorological: the compass bearing the wind
 * blows FROM (0 = north = -Z, 90 = east = +X).
 */
export class Wind {
  /** mean wind speed, m/s */
  baseSpeed = 6.5;
  /** mean "from" bearing, radians */
  baseFrom = (40 * Math.PI) / 180;
  gustiness = 0.22;

  speed = this.baseSpeed;
  from = this.baseFrom;
  /** unit vector the air moves TOWARD (world xz) */
  readonly dir = { x: 0, z: 0 };

  update(t: number): void {
    const g = noise1(t * 0.07, 1) * 0.6 + noise1(t * 0.23, 2) * 0.3 + noise1(t * 0.9, 3) * 0.1;
    this.speed = Math.max(0.5, this.baseSpeed * (1 + this.gustiness * g));
    this.from = this.baseFrom + 0.12 * noise1(t * 0.035, 4) + 0.04 * noise1(t * 0.3, 5);
    // blowing toward = from + 180°. Bearing b → world (sin b, -cos b)
    this.dir.x = -Math.sin(this.from);
    this.dir.z = Math.cos(this.from);
  }

  /** velocity of the air (m/s) at world position — height ignored for now */
  velocity(out: { x: number; z: number }): { x: number; z: number } {
    out.x = this.dir.x * this.speed;
    out.z = this.dir.z * this.speed;
    return out;
  }
}
