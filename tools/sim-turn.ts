// Turning test: steady beam reach, then hard rudder; prints yaw rate and speed over time.
import * as THREE from 'three';
import { BoatPhysics } from '../src/physics/BoatPhysics';
import { WaveField } from '../src/environment/WaveField';
import { Wind } from '../src/environment/Wind';
import type { Input } from '../src/core/Input';
const info = { hullStern: -9.0, hullBow: 9.0, beam: 5.4, keelDepth: 2.25, deckHeight: 1.7 };
const wind = new Wind(); wind.gustiness = 0; wind.update(0);
const waves = new WaveField(Math.atan2(wind.dir.z, wind.dir.x));
let steer = 0;
const inp = { axis: (a: string) => (a === 'KeyA' ? -steer : 0), wasPressed: () => false, isDown: () => false } as unknown as Input;
const p = new BoatPhysics(info, waves, wind, () => -20);
const fromDeg = (wind.from * 180) / Math.PI;
p.reset(new THREE.Vector3(), ((fromDeg + 90) * Math.PI) / 180, Number(process.argv[2] ?? 3));
let t = 0;
for (let i = 0; i < 40 * 60; i++) {
  steer = i > 10 * 60 ? 1 : 0;
  p.update(1 / 60, t, inp); t += 1 / 60;
  if (i % 60 === 0) console.log(`t${t.toFixed(0).padStart(3)} kn ${(p.speed * 1.9438).toFixed(1)} brg ${((p.bearing * 180) / Math.PI).toFixed(0).padStart(4)} yawrate ${((p.angVel.y * 180) / Math.PI).toFixed(1)}°/s rud ${((p.rudder * 180) / Math.PI).toFixed(0)} heel ${((p.heel * 180) / Math.PI).toFixed(0)}`);
}
