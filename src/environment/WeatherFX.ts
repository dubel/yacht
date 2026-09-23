import * as THREE from 'three';
import type { Weather, Strike } from './Weather';

/**
 * Visible weather: rain streaks around the camera (world-anchored, wind-slanted, only above water) and
 * lightning bolts at the strike positions reported by Weather.
 */
export class WeatherFX {
  readonly group = new THREE.Group();
  private readonly rain: THREE.LineSegments;
  private readonly rainU = {
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2() },
    uAmount: { value: 0 },
    uLight: { value: new THREE.Vector3(1, 1, 1) },
  };
  private bolt: THREE.Mesh | null = null;
  private readonly boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(40, 44, 60), fog: false, toneMapped: false, transparent: true });

  constructor(count = 9000) {
    // two vertices per drop; aEnd = 0 (head) / 1 (tail)
    const pos = new Float32Array(count * 2 * 3);
    const end = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), r = Math.random();
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        end[i * 2 + k] = k;
        rnd[i * 2 + k] = r;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.rainU,
      vertexShader: /* glsl */ `
uniform vec3 uCam; uniform float uTime, uAmount; uniform vec2 uWind;
attribute float aEnd, aRnd;
varying float vA;
const float S = 44.0;
void main(){
  vec3 vel = vec3(uWind.x, -9.0 - 2.0*aRnd, uWind.y);
  vec3 p = position*S + vel*uTime*(0.9 + 0.2*aRnd);
  vec3 base = uCam - S*0.5;
  vec3 w = base + mod(p - base, S);
  w -= vel * aEnd * 0.045;           // streak length = motion during the shutter
  float keep = step(aRnd, uAmount);  // fewer drops in light rain
  vA = keep * smoothstep(S*0.5, S*0.2, length(w - uCam)) * step(0.0, w.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uLight;
varying float vA;
void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(uLight*vA*0.3, 1.0); }`,
      transparent: true,
      depthWrite: false,
      // drops catch light: they may only brighten what is behind them
      blending: THREE.AdditiveBlending,
    });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.layers.set(1); // main camera only
    this.group.add(this.rain);
  }

  onStrike(s: Strike, cam: THREE.Vector3): void {
    // jagged bolt from the cloud base to the water at the strike position
    const tx = cam.x + Math.sin(s.angle) * s.distance, tz = cam.z + Math.cos(s.angle) * s.distance;
    const pts: THREE.Vector3[] = [];
    let x = tx + (Math.random() - 0.5) * 200, z = tz + (Math.random() - 0.5) * 200;
    const top = 650;
    for (let y = top; y > 0; y -= 35 + Math.random() * 40) {
      pts.push(new THREE.Vector3(x, y, z));
      x += (tx - x) * 0.15 + (Math.random() - 0.5) * 60;
      z += (tz - z) * 0.15 + (Math.random() - 0.5) * 60;
    }
    pts.push(new THREE.Vector3(tx, 0, tz));
    if (this.bolt) { this.group.remove(this.bolt); this.bolt.geometry.dispose(); }
    const r = Math.max(1.2, s.distance * 0.0012);
    this.bolt = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1), 60, r, 4, false), this.boltMat);
    this.bolt.frustumCulled = false;
    this.group.add(this.bolt);
  }

  update(t: number, cam: THREE.Vector3, weather: Weather, windX: number, windZ: number, skyIrr: THREE.Vector3): void {
    const u = this.rainU;
    u.uCam.value.copy(cam);
    u.uTime.value = t;
    u.uWind.value.set(windX * 0.6, windZ * 0.6);
    u.uAmount.value = weather.p.rain;
    // drops are lit by the sky (and the flashes)
    u.uLight.value.copy(skyIrr).multiplyScalar(0.9).addScalar(0.02 + weather.flash * 3);
    this.rain.visible = weather.p.rain > 0.02;
    if (this.bolt) {
      const age = weather.strike?.age ?? 1;
      this.bolt.visible = age < 0.35 && weather.flash > 0.02;
      this.boltMat.opacity = Math.min(1, weather.flash * 3);
    }
  }
}
