// Offline physics check: sail each heading for 90 s with auto-trim, print steady state.
// usage: npx tsx tools/sim.ts
import * as THREE from 'three';
import { BoatPhysics } from '../src/physics/BoatPhysics';
import { WaveField } from '../src/environment/WaveField';
import { Wind } from '../src/environment/Wind';
import type { Input } from '../src/core/Input';

const info = { hullStern: -10.1, hullBow: 7.9, beam: 5.5, keelDepth: 2.25, deckHeight: 1.7 };
const idle = { axis: () => 0, wasPressed: () => false, isDown: () => false } as unknown as Input;

const wind = new Wind();
wind.gustiness = 0;
wind.update(0);
const waves = new WaveField(Math.atan2(wind.dir.z, wind.dir.x));
const fromDeg = (wind.from * 180) / Math.PI;
console.log(`wind ${wind.speed.toFixed(1)} m/s from ${fromDeg.toFixed(0)}°`);
console.log('TWA   kn    heel  leeway  AWA  sheet  aoa');
for (const twa of [30, 40, 50, 60, 75, 90, 110, 130, 150, 170, 180]) {
  const p = new BoatPhysics(info, waves, wind, () => -20);
  const bearing = ((fromDeg + twa) * Math.PI) / 180;
  p.reset(new THREE.Vector3(), bearing, 2);
  let t = 0;
  const hold = () => {
    // simple autopilot holding the bearing with the rudder
    let e = bearing - p.bearing;
    e = Math.atan2(Math.sin(e), Math.cos(e));
    p.rudder = THREE.MathUtils.clamp(e * 2 - p.angVel.y * 1.5, -0.6, 0.6);
  };
  for (let i = 0; i < 90 * 60; i++) { hold(); p.update(1 / 60, t, idle); t += 1 / 60; }
  const d = (r: number) => ((r * 180) / Math.PI).toFixed(0).padStart(4);
  console.log(`${String(twa).padStart(3)}  ${(p.speed * 1.9438).toFixed(1).padStart(5)} ${d(p.heel)}  ${d(p.leeway)}   ${d(p.awa)} ${d(p.sheet)} ${d(p.sailAoa)}`);
}
