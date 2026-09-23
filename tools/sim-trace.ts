import * as THREE from 'three';
import { BoatPhysics } from '../src/physics/BoatPhysics';
import { WaveField } from '../src/environment/WaveField';
import { Wind } from '../src/environment/Wind';
import type { Input } from '../src/core/Input';
const info = { hullStern: -10.1, hullBow: 7.9, beam: 5.5, keelDepth: 2.25, deckHeight: 1.7 };
const idle = { axis: () => 0, wasPressed: () => false, isDown: () => false } as unknown as Input;
const wind = new Wind(); wind.gustiness = 0; wind.update(0);
const waves = new WaveField(Math.atan2(wind.dir.z, wind.dir.x));
const fromDeg = (wind.from * 180) / Math.PI;
const twa = Number(process.argv[2] ?? 60), mode = process.argv[3] ?? 'pilot';
const p = new BoatPhysics(info, waves, wind, () => -20);
const bearing = ((fromDeg + twa) * Math.PI) / 180;
p.reset(new THREE.Vector3(), bearing, 3);
let t = 0;
const d = (r: number) => ((r * 180) / Math.PI).toFixed(0).padStart(4);
for (let i = 0; i < 60 * 60; i++) {
  if (mode === 'pilot') { let e = bearing - p.bearing; e = Math.atan2(Math.sin(e), Math.cos(e)); p.rudder = THREE.MathUtils.clamp(-(e * 1.5 - p.angVel.y * 3), -0.6, 0.6); }
  else p.rudder = 0;
  p.update(1 / 60, t, idle); t += 1 / 60;
  if (i % 120 === 0) console.log(`t${t.toFixed(0).padStart(3)} kn ${(p.speed * 1.9438).toFixed(1)} brg ${d(p.bearing)} twa ${d(p.twa)} awa ${d(p.awa)} heel ${d(p.heel)} rud ${d(p.rudder)} aoa ${d(p.sailAoa)} yawrate ${(p.angVel.y).toFixed(3)}`);
}
