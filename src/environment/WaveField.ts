import * as THREE from 'three';

/**
 * CPU-side water surface: a handful of Gerstner waves.
 * This is the *physics* water ("100% predictable"). The GPU uses exactly the same
 * waves for vertex displacement + base normals, and layers the FFT/ripple detail on top.
 */
export interface GerstnerWave {
  /** propagation direction (unit, world xz) */
  dx: number;
  dz: number;
  wavelength: number;
  amplitude: number;
  /** 0..1 share of the maximum horizontal pinch */
  steepness: number;
  phase: number;
}

export const MAX_WAVES = 6;
const G = 9.81;
/** lagoon depth used for the dispersion relation (shallow-ish water slows long waves) */
const DISPERSION_DEPTH = 5.0;

export class WaveField {
  readonly waves: GerstnerWave[] = [];
  /** 0..1 global amplitude scale (weather) */
  intensity = 1;

  // packed for GLSL: (dx, dz, k, omega), (amplitude, Q, phase, 0)
  readonly uniformA = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
  readonly uniformB = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());

  constructor(windTowardAngle: number) {
    this.setWind(windTowardAngle);
  }

  /** @param towardAngle radians, direction the waves travel (world, atan2(z, x)) */
  setWind(towardAngle: number): void {
    const spec: [number, number, number, number][] = [
      // wavelength m, amplitude m, direction offset deg, steepness
      [34, 0.13, 0, 0.35],
      [21, 0.085, 22, 0.4],
      [13.5, 0.06, -28, 0.45],
      [8.7, 0.04, 48, 0.45],
      [5.6, 0.026, -14, 0.5],
      [3.9, 0.016, 70, 0.5],
    ];
    this.waves.length = 0;
    spec.forEach(([wl, a, off, q], i) => {
      const ang = towardAngle + (off * Math.PI) / 180;
      this.waves.push({ dx: Math.cos(ang), dz: Math.sin(ang), wavelength: wl, amplitude: a, steepness: q, phase: i * 1.7 });
    });
    this.pack();
  }

  pack(): void {
    this.waves.forEach((w, i) => {
      const k = (2 * Math.PI) / w.wavelength;
      const omega = Math.sqrt(G * k * Math.tanh(k * DISPERSION_DEPTH));
      const a = w.amplitude * this.intensity;
      // Q normalised so that the sum over waves can never loop (Q*k*A*count <= steepness)
      const q = a > 0 ? w.steepness / (k * a * this.waves.length) : 0;
      this.uniformA[i].set(w.dx, w.dz, k, omega);
      this.uniformB[i].set(a, q, w.phase, 0);
    });
  }

  /** horizontal Gerstner displacement at *parameter* point (px,pz) */
  private displace(px: number, pz: number, t: number, out: { x: number; y: number; z: number }) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const A = this.uniformA[i], B = this.uniformB[i];
      const th = A.z * (A.x * px + A.y * pz) - A.w * t + B.z;
      const c = Math.cos(th), s = Math.sin(th);
      const qa = B.y * B.x;
      x += qa * A.x * c;
      z += qa * A.y * c;
      y += B.x * s;
    }
    out.x = x; out.y = y; out.z = z;
  }

  private readonly tmp = { x: 0, y: 0, z: 0 };

  /** water surface height at world (x,z) — inverts the horizontal Gerstner shift by fixed-point iteration */
  heightAt(x: number, z: number, t: number): number {
    let px = x, pz = z;
    const d = this.tmp;
    for (let i = 0; i < 4; i++) {
      this.displace(px, pz, t, d);
      px = x - d.x;
      pz = z - d.z;
    }
    this.displace(px, pz, t, d);
    return d.y;
  }

  /** surface normal + vertical particle velocity at world (x,z) */
  sample(x: number, z: number, t: number, out: { height: number; nx: number; ny: number; nz: number; vy: number }) {
    let px = x, pz = z;
    const d = this.tmp;
    for (let i = 0; i < 3; i++) {
      this.displace(px, pz, t, d);
      px = x - d.x;
      pz = z - d.z;
    }
    let h = 0, nx = 0, nz = 0, ny = 1, vy = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const A = this.uniformA[i], B = this.uniformB[i];
      const th = A.z * (A.x * px + A.y * pz) - A.w * t + B.z;
      const c = Math.cos(th), s = Math.sin(th);
      const wa = A.z * B.x;
      h += B.x * s;
      nx -= A.x * wa * c;
      nz -= A.y * wa * c;
      ny -= B.y * wa * s;
      vy -= B.x * A.w * c;
    }
    const l = Math.hypot(nx, ny, nz);
    out.height = h; out.nx = nx / l; out.ny = ny / l; out.nz = nz / l; out.vy = vy;
    return out;
  }
}

/** GLSL that mirrors WaveField exactly. Expects `uniform vec4 uWaveA[6], uWaveB[6]; uniform float uWaveTime;` */
export const GERSTNER_GLSL = /* glsl */ `
uniform vec4 uWaveA[${MAX_WAVES}];
uniform vec4 uWaveB[${MAX_WAVES}];
uniform float uWaveTime;
vec3 gerstnerDisplace(vec2 p){
  vec3 d = vec3(0.0);
  for (int i=0;i<${MAX_WAVES};i++){
    vec4 A = uWaveA[i], B = uWaveB[i];
    float th = A.z*dot(A.xy, p) - A.w*uWaveTime + B.z;
    float c = cos(th), s = sin(th);
    d.xz += B.y*B.x*A.xy*c;
    d.y += B.x*s;
  }
  return d;
}
// surface slope (dh/dx, dh/dz) at parameter point p, derived from the analytic Gerstner normal
vec2 gerstnerSlope(vec2 p){
  vec3 n = vec3(0.0, 1.0, 0.0);
  for (int i=0;i<${MAX_WAVES};i++){
    vec4 A = uWaveA[i], B = uWaveB[i];
    float th = A.z*dot(A.xy, p) - A.w*uWaveTime + B.z;
    float wa = A.z*B.x;
    n.xz -= A.xy*wa*cos(th);
    n.y -= B.y*wa*sin(th);
  }
  return -n.xz/n.y;
}
`;
