import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { GameTime } from './GameTime';
import type { Weather } from './Weather';
import { CLOUD_MAP_GLSL } from './Clouds';

/**
 * Sun, moon, sky and image-based lighting, driven by GameTime + Weather.
 *
 * Radiometric convention (matches Clearwater): the sun at full strength is (1, .9, .74) × 6 so an albedo-a
 * Lambert surface gets a/π·E. The Preetham sky is in the same range. The shading light (`lightDir`,
 * `lightRadiance`) is the sun by day and the moon by night — water glints, caustics and shadows follow it.
 */
const SKY_PATCH_UNIFORMS = /* glsl */ `
uniform float uSkyScale, uNight, uOvercast, uFlash, uMoonBright, uStarRot;
uniform vec3 uMoonDir;
uniform sampler2D uCloudMap;
uniform float uCloudCover, uCloudBase;
${CLOUD_MAP_GLSL}
float skyHash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
`;

const SKY_PATCH_NIGHT = /* glsl */ `
			// ---- night sky: stars, moon (lit by the real sun direction → correct phase), airglow ----
			{
				float night = uNight;
				vec3 d = direction;
				texColor += vec3(0.0022, 0.0036, 0.0085) * night * (0.6 + 0.4*smoothstep(0.0, 0.6, d.y)) * (1.0 + 2.5*uMoonBright);
				if (night > 0.001 && d.y > -0.02) {
					float c = cos(uStarRot), s = sin(uStarRot);
					vec3 q = vec3(d.x, d.y*c - d.z*s, d.y*s + d.z*c);
					vec3 p = q * 260.0;
					vec3 cell = floor(p);
					float h = skyHash(cell);
					if (h > 0.9955) {
						vec3 o = vec3(skyHash(cell + 1.3), skyHash(cell + 2.7), skyHash(cell + 4.1));
						float r = length(fract(p) - (0.25 + 0.5*o));
						float tw = 0.75 + 0.25*sin(time*2.5 + h*400.0);
						float mag = pow((h - 0.9955)/0.0045, 3.0);
						vec3 tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), o.x);
						texColor += tint * smoothstep(0.22, 0.0, r) * (0.05 + 1.6*mag) * tw * night * smoothstep(0.0, 0.18, d.y);
					}
				}
				float md = dot(d, uMoonDir);
				const float MR = 0.0125;
				vec3 o = (d - uMoonDir*md) / MR;
				float r2 = dot(o, o);
				float vis = smoothstep(-0.03, 0.02, uMoonDir.y);
				if (md > 0.0 && r2 < 1.2) {
					vec3 n = normalize(o - uMoonDir*sqrt(max(1.0 - r2, 0.0)));
					float lit = smoothstep(-0.08, 0.12, dot(n, vSunDirection));
					float maria = 0.78 + 0.22*smoothstep(0.3, 0.7, skyHash(floor(o*3.0 + 7.0)));
					vec3 moonC = vec3(1.0, 0.96, 0.88) * (lit*maria*1.9 + 0.02);
					float disc = smoothstep(1.0, 0.86, r2);
					// by day the lit part adds to the sky and the dark part is simply sky
					vec3 moonPix = moonC*(0.45 + 0.55*night) + texColor*(1.0 - night)*0.92;
					texColor = mix(texColor, moonPix, disc*vis);
				}
				texColor += vec3(0.55, 0.65, 0.9) * pow(max(md, 0.0), 900.0) * 0.18 * uMoonBright * vis * night;
			}
`;

const SKY_PATCH_END = /* glsl */ `
			// ---- overcast deck + lightning ----
			{
				// an overcast deck glows with the sunlight it lets through (≈ E_transmitted / π), keeping
				// some of the cloud structure; thick storm decks are dark
				float lum = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
				float dayLight = smoothstep(-0.12, 0.45, vSunDirection.y);
				float through = (0.1 + 1.8*dayLight) * (1.04 - uOvercast);
				vec3 deck = vec3(0.86, 0.9, 0.97) * through * (0.7 + 0.6*clamp(lum/(lum + 1.5), 0.0, 1.0))
				          * mix(1.0, 0.85 + 0.3*smoothstep(-0.1, 0.5, direction.y), uOvercast)
				          + vec3(0.002, 0.003, 0.006) * uNight;
				// behind the volumetric clouds only a heavy deck greys the remaining gaps
				texColor = mix(texColor, deck, smoothstep(0.55, 0.95, uOvercast));
				// volumetric clouds (direction map): in front of sky, sun, moon and stars
				// under a cloud layer the air near the horizon is in the clouds' shade: the bright Preetham horizon dims
				texColor *= 1.0 - 0.45*uCloudCover*(1.0 - smoothstep(0.0, 0.3, direction.y));
				if (direction.y > -0.02) {
					// 4-tap lookup softens the per-texel march jitter
					vec2 cuv = cloudMapUV(direction), ct = 0.35/vec2(textureSize(uCloudMap, 0));
					vec4 cl = 0.25*(texture(uCloudMap, cuv + vec2(ct.x, ct.y)) + texture(uCloudMap, cuv + vec2(-ct.x, ct.y))
					              + texture(uCloudMap, cuv + vec2(ct.x, -ct.y)) + texture(uCloudMap, cuv - ct));
					// aerial perspective by the distance to the cloud base along this ray (curved earth, stable form):
					// clouds tens of km away fade into the horizon haze. (The clear-sky Preetham horizon is very
					// bright — clamp it; under a deck that bright clear air isn't there, so haze less.)
					float sy = max(direction.y, 0.0);
					float tc = 2.0*uCloudBase/(sy + sqrt(sy*sy + 2.0*uCloudBase/6371000.0));
					float aerial = (1.0 - exp(-tc/42000.0))*mix(0.8, 0.45, uCloudCover);
					texColor = texColor*cl.a + mix(cl.rgb, min(texColor, vec3(1.6))*(1.0 - cl.a), aerial);
				}
				texColor += uFlash * vec3(0.5, 0.56, 0.72) * (0.35 + 0.65*smoothstep(-0.1, 0.35, direction.y));
			}
			gl_FragColor = vec4( texColor * uSkyScale, 1.0 );`;

export class Environment {
  /** the sun (may be below the horizon) */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly moonDir = new THREE.Vector3(0, -1, 0);
  /** direction of the dominant light (sun by day, moon by night) — used by water, caustics, shadows */
  readonly lightDir = new THREE.Vector3(0, 1, 0);
  /** colour × intensity of that light, for glints */
  readonly sunRadiance = new THREE.Vector3();
  /** hemispherical sky irradiance (water in-scatter, foam) */
  readonly skyIrradiance = new THREE.Vector3(0.43, 0.48, 0.54);
  readonly fogColor = new THREE.Color(0.6, 0.71, 0.82);
  fogDensity = 0.0011;
  /** suggested post exposure (simple eye adaptation) */
  exposure = 0.63;
  /** 0 by day … 1 at full night */
  night = 0;
  /** light that reaches the cloud layer (the sun keeps lighting it a little after sunset) */
  readonly cloudLightDir = new THREE.Vector3(0, 1, 0);
  readonly cloudLight = new THREE.Vector3();
  readonly cloudAmbient = new THREE.Vector3();
  /** 0 … 1 around sunrise / sunset (sky reddening, warm grade) */
  golden = 0;

  readonly sky: Sky;
  readonly light: THREE.DirectionalLight;
  private readonly flashLight = new THREE.HemisphereLight(0xb8c4ff, 0x404858, 0);

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envAge = 1e9;
  private readonly lastEnvLight = new THREE.Vector3();
  private readonly horizonRT = new THREE.WebGLRenderTarget(64, 4, { type: THREE.FloatType, depthBuffer: false });
  // a thin strip 0–5° above the horizon: 4 × 90° wide, 5° tall (a 90° square view would average in the
  // bright lower half of the sky dome)
  private readonly horizonCam = new THREE.PerspectiveCamera(5, Math.tan(Math.PI / 4) / Math.tan((2.5 * Math.PI) / 180), 0.1, 5000);
  private horizonPending = false;
  private readonly skyU: Record<string, THREE.IUniform>;
  private pinned: THREE.Vector3 | null = null;
  private readonly fogTarget = new THREE.Color(0.6, 0.71, 0.82);
  private fogInit = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.2;
    u.rayleigh.value = 1.1;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    Object.assign(u, {
      uSkyScale: { value: 1 }, uNight: { value: 0 }, uOvercast: { value: 0 }, uFlash: { value: 0 },
      uMoonBright: { value: 0 }, uStarRot: { value: 0 }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uCloudMap: { value: null }, uCloudCover: { value: 0 }, uCloudBase: { value: 900 },
    });
    this.skyU = u;
    const fs = this.sky.material.fragmentShader;
    this.sky.material.fragmentShader = fs
      .replace('void main() {', SKY_PATCH_UNIFORMS + '\nvoid main() {')
      .replace('// Clouds', SKY_PATCH_NIGHT + '\n\t\t\t// Clouds')
      .replace('gl_FragColor = vec4( texColor, 1.0 );', SKY_PATCH_END);
    this.sky.material.toneMapped = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);

    this.light = new THREE.DirectionalLight(0xffffff, 6);
    this.light.castShadow = true;
    const sc = this.light.shadow.camera;
    sc.left = sc.bottom = -24;
    sc.right = sc.top = 24;
    sc.near = 1;
    sc.far = 140;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.04;
    scene.add(this.light, this.light.target, this.flashLight);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    const envSky = new Sky();
    envSky.material = this.sky.material; // same patched material and uniforms
    envSky.scale.setScalar(1000);
    this.envScene.add(envSky);
  }

  /** ?sun=el,az debug override: freeze the sun at a fixed position */
  pinSun(elevationDeg: number, azimuthDeg: number): void {
    const el = THREE.MathUtils.degToRad(elevationDeg), az = THREE.MathUtils.degToRad(azimuthDeg);
    this.pinned = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  }

  update(dt: number, time: GameTime, weather: Weather): void {
    const w = weather.p;
    this.sunDir.copy(this.pinned ?? time.sunDir);
    this.moonDir.copy(time.moonDir);
    const sunY = this.sunDir.y, moonY = this.moonDir.y;
    this.night = THREE.MathUtils.smoothstep(-sunY, -0.02, 0.2);
    // golden hour: sun within ~20° of the horizon, fading out once it is well below
    this.golden = (1 - THREE.MathUtils.smoothstep(sunY, 0.06, 0.34)) * THREE.MathUtils.smoothstep(sunY, -0.14, -0.01) * (1 - 0.8 * w.overcast);
    const moonBright = time.moonLit * THREE.MathUtils.smoothstep(moonY, -0.02, 0.12);

    // ---- sky ----
    const u = this.skyU;
    u.sunPosition.value.copy(this.sunDir);
    // a hazier, dustier evening atmosphere: longer red light paths, stronger forward glow around the sun
    const gk = this.golden;
    u.turbidity.value = 2.2 + 5.5 * gk;
    u.rayleigh.value = 1.1 + 2.2 * gk;
    // clean, cloudless air (the 'clear' preset) has little aerosol: a tight, weaker glow around the sun, so
    // the disc stands out instead of drowning in a wide white aureole
    const clean = 1 - THREE.MathUtils.smoothstep(w.cloudCoverage, 0.02, 0.17);
    u.mieCoefficient.value = 0.004 - 0.0025 * clean + 0.003 * gk;
    u.mieDirectionalG.value = 0.82 + 0.1 * clean * (1 - gk) + 0.07 * gk;
    u.cloudCoverage.value = 0; // Preetham's 2D clouds are replaced by the volumetric layer
    u.uCloudCover.value = THREE.MathUtils.smoothstep(w.cloudCoverage, 0.15, 0.9);
    u.uCloudBase.value = w.cloudBase;
    u.time.value += dt * (0.4 + w.wind / 6);
    u.uNight.value = this.night;
    u.uOvercast.value = w.overcast;
    u.uFlash.value = weather.flash;
    u.uMoonBright.value = moonBright;
    u.uMoonDir.value.copy(this.moonDir);
    u.uStarRot.value = (time.hours / 24) * Math.PI * 2 + time.day * 0.0172;

    // ---- the shading light: sun, or the moon once the sun is down ----
    const el = Math.asin(THREE.MathUtils.clamp(sunY, -1, 1));
    // cloud shadows now darken the direct light where it matters; keep only a diffuse-deck share here
    const cloudDim = 1 - 0.45 * w.overcast;
    let intensity: number;
    const color = new THREE.Color();
    if (sunY > -0.03) {
      // warm, dimmer sun near the horizon (cheap air-mass approximation)
      const m = 1 / Math.max(Math.sin(Math.max(el, 0)) + 0.15 * Math.pow(Math.max((el * 180) / Math.PI + 3.885, 0.01), -1.253), 0.02);
      // extinction coefficients grow with the evening haze → a deeper red sun
      const haze = 1 + 0.9 * this.golden;
      const ext = [0.016, 0.052, 0.13].map((k) => Math.exp(-k * m * 1.2 * haze));
      color.setRGB(ext[0] * 1.08, ext[1] * 0.95, ext[2] * 0.8);
      // keep the low sun strong enough to paint the scene
      intensity = 6 * THREE.MathUtils.smoothstep(el, -0.03, 0.07) * (1 + 0.6 * this.golden);
      this.lightDir.copy(this.sunDir);
    } else {
      color.setRGB(0.62, 0.72, 1.0);
      // fade the moon in only once the sun is well gone, so the switch of light source is invisible
      intensity = 0.3 * moonBright * THREE.MathUtils.smoothstep(-sunY, 0.03, 0.12);
      this.lightDir.copy(this.moonDir);
    }
    if (this.lightDir.y < 0.02) this.lightDir.y = 0.02; // keep shadows sane when the light grazes the horizon
    this.lightDir.normalize();
    intensity *= cloudDim;
    this.light.color.copy(color);
    this.light.intensity = intensity;
    this.sunRadiance.set(color.r * intensity, color.g * intensity, color.b * intensity).multiplyScalar(1 - 0.6 * w.overcast);

    // sky irradiance: daylight → twilight → moonlit night, dimmed by the cloud deck
    const day = THREE.MathUtils.smoothstep(sunY, -0.12, 0.3);
    const dusk = Math.max(this.golden, THREE.MathUtils.smoothstep(sunY, -0.15, 0.02) * (1 - THREE.MathUtils.smoothstep(sunY, 0.02, 0.25)));
    this.skyIrradiance.set(0.43, 0.48, 0.54).multiplyScalar(day)
      // warm afterglow from the red half of the sky lights everything from the sunset side
      .add(new THREE.Vector3(0.34, 0.15, 0.1).multiplyScalar(dusk))
      .add(new THREE.Vector3(0.004, 0.006, 0.013).multiplyScalar(1 + 3 * moonBright))
      .multiplyScalar(1 - 0.5 * w.overcast)
      .addScalar(weather.flash * 1.2);

    // clouds at 1–3 km still see the sun ~1–2° below the horizon: pink/red undersides after sunset
    if (sunY > -0.05) {
      const ce = Math.max(el, 0);
      const cm = 1 / Math.max(Math.sin(ce) + 0.15 * Math.pow((ce * 180) / Math.PI + 3.885, -1.253), 0.02);
      const haze = 1 + 0.9 * this.golden;
      const ex = [0.016, 0.052, 0.13].map((k) => Math.exp(-k * cm * 1.2 * haze));
      const k = 6 * THREE.MathUtils.smoothstep(sunY, -0.05, 0.02);
      this.cloudLight.set(ex[0] * 1.08 * k, ex[1] * 0.95 * k, ex[2] * 0.8 * k);
      this.cloudLightDir.copy(this.sunDir);
      if (this.cloudLightDir.y < 0.01) { this.cloudLightDir.y = 0.01; this.cloudLightDir.normalize(); }
    } else {
      const k = 0.3 * moonBright;
      this.cloudLight.set(0.62 * k, 0.72 * k, 1.0 * k);
      this.cloudLightDir.copy(this.moonDir);
    }
    this.cloudAmbient.copy(this.skyIrradiance).multiplyScalar(0.55 / (1 - 0.5 * w.overcast));
    this.flashLight.intensity = weather.flash * 2.2;
    this.fogDensity = w.fog;
    this.fogColor.lerp(this.fogTarget, 1 - Math.exp(-dt * 2.5));

    // simple eye adaptation: the key light of the scene sets the exposure
    const key = intensity * 0.5 + (this.skyIrradiance.x + this.skyIrradiance.y + this.skyIrradiance.z) * 1.4;
    const target = 0.63 * THREE.MathUtils.clamp(Math.pow(4.8 / Math.max(key, 0.01), 0.33), 0.9, 2.6);
    // (dt = 0 on the very first update: start at the target instead of adapting from a default)
    this.exposure += (target - this.exposure) * (dt === 0 ? 1 : 1 - Math.exp(-dt * 1.5));

    // IBL + fog colour: refresh periodically (they follow a slowly changing sky)
    this.envAge += dt;
    const fastSky = Math.abs(sunY) < 0.3 || weather.flash > 0; // twilight: the sky changes quickly
    if (this.envAge > (fastSky ? 0.4 : 1.5) || this.lastEnvLight.distanceTo(this.lightDir) > 0.05) {
      this.envAge = 0;
      this.lastEnvLight.copy(this.lightDir);
      this.refreshEnvironment();
      this.measureHorizon();
    }
  }

  /** re-bake the IBL cube from the current sky */
  refreshEnvironment(): void {
    const prev = this.envRT;
    // the sun itself is lit by the directional light; keep the disc and the lightning out of the IBL
    const disc = this.skyU.showSunDisc, flash = this.skyU.uFlash.value;
    disc.value = 0;
    this.skyU.uFlash.value = 0;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
    disc.value = 1;
    this.skyU.uFlash.value = flash;
    this.scene.environment = this.envRT.texture;
    prev?.dispose();
  }

  /** fog colour = average sky radiance a couple of degrees above the horizon, all around (async readback) */
  private measureHorizon(): void {
    if (this.horizonPending) return;
    const r = this.renderer;
    const disc = this.skyU.showSunDisc;
    disc.value = 0;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.horizonRT);
    for (let i = 0; i < 4; i++) {
      this.horizonCam.rotation.set(0.045, (i * Math.PI) / 2, 0, 'YXZ');
      this.horizonCam.updateMatrixWorld();
      this.horizonRT.viewport.set(i * 16, 0, 16, 4);
      r.setRenderTarget(this.horizonRT);
      r.render(this.envScene, this.horizonCam);
    }
    this.horizonRT.viewport.set(0, 0, 64, 4);
    disc.value = 1;
    r.setRenderTarget(prevTarget);
    const px = new Float32Array(64 * 4 * 4);
    if (!this.fogInit) {
      // the very first measurement is synchronous (once, at start-up) so the first frames already have
      // the right haze instead of a default blue that snaps a moment later
      r.readRenderTargetPixels(this.horizonRT, 0, 0, 64, 4, px);
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 64 * 4; j++) { x += px[j * 4]; y += px[j * 4 + 1]; z += px[j * 4 + 2]; }
      if (Number.isFinite(x + y + z)) { this.fogTarget.setRGB(x / 256, y / 256, z / 256); this.fogColor.copy(this.fogTarget); this.fogInit = true; }
      return;
    }
    this.horizonPending = true;
    r.readRenderTargetPixelsAsync(this.horizonRT, 0, 0, 64, 4, px).then(() => {
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 64 * 4; j++) { x += px[j * 4]; y += px[j * 4 + 1]; z += px[j * 4 + 2]; }
      const n = 64 * 4;
      if (Number.isFinite(x + y + z)) { this.fogTarget.setRGB(x / n, y / n, z / n); if (!this.fogInit) { this.fogColor.copy(this.fogTarget); this.fogInit = true; } }
      this.horizonPending = false;
    }, () => { this.horizonPending = false; });
  }

  /** keep the shadow frustum around the focus point (the boat) */
  follow(focus: THREE.Vector3): void {
    this.light.target.position.copy(focus);
    this.light.position.copy(focus).addScaledVector(this.lightDir, 70);
    this.light.target.updateMatrixWorld();
    this.sky.position.copy(focus).setY(0);
  }
}
