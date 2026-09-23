import * as THREE from 'three';
import type { Input } from '../core/Input';

/**
 * Chase/orbit camera around the boat. Drag to orbit, wheel to zoom. Lazily swings behind the boat
 * when the player isn't orbiting. Never dips under the water or into the terrain.
 */
export class SailingCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** orbit angles relative to the boat heading */
  yaw = 0.55;
  pitch = 0.28;
  distance = 42;
  private readonly target = new THREE.Vector3();
  private readonly smoothPos = new THREE.Vector3();
  private headingYaw = 0;
  private idle = 0;
  private first = true;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.3, 40000);
    this.camera.layers.enable(1); // underwater particles
  }

  /** V: duck under the hull / come back up */
  toggleDive(): void {
    if (this.pitch > -0.1) {
      this.pitch = -0.3;
      this.distance = Math.min(this.distance, 32);
    } else this.pitch = 0.28;
    this.idle = 0;
  }

  update(dt: number, input: Input, focus: THREE.Vector3, heading: number, groundAt: (x: number, z: number) => number): void {
    const k = 0.005;
    if (input.dragDX || input.dragDY) this.idle = 0;
    this.yaw -= input.dragDX * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.dragDY * k, -0.75, 1.35);
    this.distance = THREE.MathUtils.clamp(this.distance * Math.pow(1.1, input.wheel), 9, 160);
    this.idle += dt;

    // follow the heading with a lag; unwrap to avoid spinning the long way round
    let dh = heading - this.headingYaw;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.headingYaw += dh * (1 - Math.exp(-dt * 0.8));
    // drift back behind the boat after a while without input
    if (this.idle > 4 && !input.dragging) this.yaw += (0.35 - this.yaw) * (1 - Math.exp(-dt * 0.25));

    this.target.lerp(focus, this.first ? 1 : 1 - Math.exp(-dt * 6));
    const a = this.headingYaw + Math.PI + this.yaw;
    const cp = Math.cos(this.pitch);
    const want = new THREE.Vector3(
      this.target.x + Math.sin(a) * cp * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance + 3,
      this.target.z + Math.cos(a) * cp * this.distance,
    );
    // the camera may cross the surface (split view) — only keep it off the seabed / terrain
    const floor = groundAt(want.x, want.z) + 1.2;
    want.y = Math.max(want.y, floor);
    if (this.first) this.smoothPos.copy(want);
    this.smoothPos.lerp(want, 1 - Math.exp(-dt * 8));
    this.smoothPos.y = Math.max(this.smoothPos.y, floor);
    this.camera.position.copy(this.smoothPos);
    // looking up at the hull from below: aim at the keel instead of the deck
    const aimY = THREE.MathUtils.lerp(4, -1.2, THREE.MathUtils.smoothstep(-this.pitch, 0.02, 0.3));
    this.camera.lookAt(this.target.x, this.target.y + aimY, this.target.z);
    this.first = false;
  }
}
