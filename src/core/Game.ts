import * as THREE from 'three';
import { Config, VIEW_MODES, type ViewMode } from './Config';
import { Input } from './Input';
import { Blitter } from '../render/gpu';
import { Pipeline } from '../render/Pipeline';
import { WaterSpectrum } from '../render/water/WaterSpectrum';
import { Ripples } from '../render/water/Ripples';
import { Caustics } from '../render/water/Caustics';
import { WaterSurface } from '../render/water/WaterSurface';
import { UnderwaterPass } from '../render/water/UnderwaterPass';
import { underwaterUniforms } from '../render/water/underwaterLight';
import { UnderwaterParticles } from '../render/water/UnderwaterParticles';
import { Environment } from '../environment/Environment';
import { Wind } from '../environment/Wind';
import { WaveField } from '../environment/WaveField';
import { GameTime } from '../environment/GameTime';
import { Weather } from '../environment/Weather';
import { WeatherFX } from '../environment/WeatherFX';
import { BANDS, Clouds, cloudShadowUniforms } from '../environment/Clouds';
import { Terrain } from '../world/Terrain';
import { ChannelMarkers } from '../world/ChannelMarkers';
import { Discovery } from '../map/Discovery';
import { MapUI } from '../map/MapUI';
import { DeckMap } from '../boat/DeckMap';
import { FishLife } from '../life/Fish';
import { DeckWalker } from '../camera/DeckWalker';
import { LENS_R, Spyglass } from '../camera/Spyglass';
import { featuresNear, terrainHeight } from '../world/WorldGen';
import { placeName } from '../map/names';
import { Vegetation } from '../world/Vegetation';
import { Mission } from '../gameplay/Mission';
import { Boat } from '../boat/Boat';
import { BoatPhysics } from '../physics/BoatPhysics';
import { SailingCamera } from '../camera/SailingCamera';
import { DebugUI } from '../debug/DebugUI';
import { Hud } from '../debug/Hud';
import { AudioSystem } from '../audio/AudioSystem';

/** how much faster than real time the clouds move while the day clock runs (a 7-min day is ~200× faster) */
const CLOUD_TIMELAPSE = 6;
/** fast-travel multipliers (− / +) */
const TRAVEL = [1, 1.5, 2, 4, 6];

const START_BEARING = THREE.MathUtils.degToRad(190);
const VIEW_IDS: Record<ViewMode, number> = { final: 0, normals: 1, caustics: 2, reflection: 3, depth: 4, ripples: 5, fft: 6 };

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly input: Input;
  readonly wind = new Wind();
  readonly clock = new GameTime(Config.startTime, Config.dayLengthSec, Config.moonPhase, Config.paused);
  readonly weather = new Weather(Config.weather && Config.weather !== 'auto' ? Config.weather : 'fair', !Config.weather || Config.weather === 'auto');
  readonly waves: WaveField;
  readonly env: Environment;
  readonly blit: Blitter;
  readonly spectrum: WaterSpectrum;
  readonly ripples: Ripples;
  readonly caustics: Caustics;
  readonly water: WaterSurface;
  readonly pipeline: Pipeline;
  readonly boat = new Boat();
  readonly particles = new UnderwaterParticles();
  readonly weatherFx = new WeatherFX();
  readonly clouds: Clouds;
  private readonly flashDir = new THREE.Vector3(1, 0.2, 0);
  terrain!: Terrain;
  vegetation!: Vegetation;
  mission!: Mission;
  readonly markers = new ChannelMarkers();
  readonly fish = new FishLife();
  readonly discovery = new Discovery(Config.worldSeed);
  map!: MapUI;
  physics!: BoatPhysics;
  deck!: DeckMap;
  walker!: DeckWalker;
  /** first-person view from the deck (F) */
  onDeck = false;
  readonly spyglass = new Spyglass();
  private scopeT = 0;
  private scopeLabel = '';
  readonly cam: SailingCamera;
  readonly debug: DebugUI;
  readonly hud: Hud;
  readonly audio = new AudioSystem();
  private shore = 0;
  private shoreT = 0;

  view: ViewMode = (VIEW_MODES as string[]).includes(Config.view) ? (Config.view as ViewMode) : 'final';
  quality: number;
  time = 0;
  private last = 0;
  private ftAvg = 16;
  private framesSinceResize = 0;
  private readonly followV2 = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: Config.fixedTime !== null });
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;

    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.quality = Config.initialQuality ?? (dpr > 1.5 ? 0.7 : 1.0);

    this.input = new Input(canvas);
    this.blit = new Blitter(this.renderer);
    this.wind.baseSpeed = this.weather.p.wind;
    this.wind.gustiness = this.weather.p.gustiness;
    this.wind.update(0);
    const windToward = Math.atan2(this.wind.dir.z, this.wind.dir.x);
    this.waves = new WaveField(windToward);
    this.env = new Environment(this.renderer, this.scene);
    this.clouds = new Clouds(this.blit);
    this.env.sky.material.uniforms.uCloudMap.value = this.clouds.map.texture;
    cloudShadowUniforms.uCloudShadow.value = this.clouds.shadow.texture;
    this.updateClouds(0);
    if (Config.sunOverride) this.env.pinSun(Config.sunOverride.elevation, Config.sunOverride.azimuth);
    this.env.update(0, this.clock, this.weather);
    // fill the whole cloud map once (it normally refreshes a quarter per frame), then re-bake the IBL with it
    for (let i = 0; i < BANDS; i++) this.updateClouds(0);
    this.env.refreshEnvironment();
    this.scene.fog = new THREE.FogExp2(this.env.fogColor, this.env.fogDensity);

    this.spectrum = new WaterSpectrum(this.blit, Config.fft.N, Config.fft.L, Config.fft.targetSlope, [this.wind.dir.x, this.wind.dir.z]);
    this.ripples = new Ripples(this.blit, this.renderer, Config.ripples.N, Config.ripples.size, Config.ripples.speed);
    const cc = Config.caustics;
    this.caustics = new Caustics(this.renderer, this.spectrum.surface.texture, Config.fft.L, cc.grid, cc.size, cc.patch, cc.depth);
    this.water = new WaterSurface(this.waves, this.spectrum.surface.texture, Config.fft.L);
    this.water.uniforms.uRip.value = this.ripples.field.texture;
    this.water.uniforms.uRipSize.value = this.ripples.size;
    this.water.uniforms.uRipCenter.value = this.ripples.center;
    this.pipeline = new Pipeline(this.renderer, this.blit, this.scene, this.water, new UnderwaterPass(this.waves));
    const uw = underwaterUniforms;
    uw.uCaus.value = this.caustics.target.texture;
    uw.uCausShift.value = this.caustics.shift;
    uw.uCausPatch.value = this.caustics.patch;
    uw.uCausDepth.value = this.caustics.depth;
    uw.uSunW.value = this.env.lightDir;
    this.scene.add(this.particles.points, this.weatherFx.group);
    this.weather.onStrike = (s) => {
      this.weatherFx.onStrike(s, this.cam.camera.position);
      // pan the thunder by where the strike is relative to the view direction
      const f = this.cam.camera.getWorldDirection(new THREE.Vector3());
      const fl = Math.hypot(f.x, f.z) || 1;
      this.audio.thunder({ distance: s.distance, pan: (Math.sin(s.angle) * -f.z + Math.cos(s.angle) * f.x) / fl });
    };

    this.cam = new SailingCamera(innerWidth / innerHeight);
    this.debug = new DebugUI(this);
    this.hud = new Hud();
    addEventListener('resize', () => this.resize());
  }

  async init(progress: (f: number) => void): Promise<void> {
    const pebbles = await new THREE.TextureLoader().loadAsync('assets/textures/pebbles.jpg');
    pebbles.colorSpace = THREE.SRGBColorSpace;
    pebbles.wrapS = pebbles.wrapT = THREE.RepeatWrapping;
    pebbles.anisotropy = 8;
    progress(0.1);

    this.vegetation = new Vegetation();
    this.terrain = new Terrain(pebbles, Config.worldSeed, this.vegetation);
    this.scene.add(this.terrain.group);
    const start = Config.freeCam ? new THREE.Vector3(Config.freeCam[0], 0, Config.freeCam[2]) : new THREE.Vector3();
    await this.terrain.ready(start, (f) => progress(0.1 + 0.2 * f));
    progress(0.3);

    await this.boat.load('assets/boats/amadis.glb', (f) => progress(0.3 + 0.65 * f));
    this.scene.add(this.boat.root);
    this.deck = new DeckMap(this.renderer, this.boat);
    this.walker = new DeckWalker(this.deck);
    this.walker.onStep = (pace) => this.audio.footstep(pace);
    this.walker.onLand = (h) => this.audio.footstep(0.5, 1 + Math.min(1.2, h * 1.6));
    this.walker.onJump = () => this.audio.footstep(0.8, 0.8);
    this.spyglass.onOpen = (open) => this.audio.spyglass(open);
    this.physics = new BoatPhysics(this.boat.info, this.waves, this.wind, (x, z) => this.terrain.heightAt(x, z));
    this.physics.reset(new THREE.Vector3(0, 0, 0), START_BEARING, Config.startSpeed);
    this.mission = new Mission((x, z) => this.terrain.heightAt(x, z));
    this.scene.add(this.mission.group, this.markers.group, this.fish.mesh);
    this.map = new MapUI(this.discovery, Config.worldSeed);
    progress(1);

    this.resize();
    // compile everything up front so the first frames don't hitch
    this.renderer.compile(this.scene, this.cam.camera);
  }

  resize(): void {
    // a tab (re)loaded in the background can report a 0×0 window: an ∞ aspect ratio would put NaNs in
    // every camera matrix (and make three's clipping-plane upload throw). Keep the last good size.
    if (innerWidth < 1 || innerHeight < 1) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(innerWidth * dpr * this.quality));
    const h = Math.max(1, Math.round(innerHeight * dpr * this.quality));
    this.renderer.setSize(w, h, false);
    this.pipeline.setSize(w, h);
    this.cam.camera.aspect = innerWidth / innerHeight;
    this.cam.camera.updateProjectionMatrix();
    this.framesSinceResize = 0;
  }

  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private handleKeys(): void {
    const inp = this.input;
    if (inp.wasPressed('F1') || inp.wasPressed('Backquote')) this.debug.toggle();
    const fkeys: [string, ViewMode][] = [['F2', 'final'], ['F3', 'normals'], ['F4', 'caustics'], ['F5', 'reflection'], ['F6', 'depth'], ['F7', 'ripples'], ['F8', 'fft']];
    for (const [k, v] of fkeys) if (inp.wasPressed(k)) this.view = v;
    if (inp.wasPressed('KeyR')) this.physics.reset(new THREE.Vector3(0, 0, 0), START_BEARING, 0);
    if (inp.wasPressed('KeyH')) this.hud.toggleHelp();
    if (inp.wasPressed('KeyV') && !this.onDeck) this.cam.toggleDive();
    if (inp.wasPressed('KeyF')) this.setOnDeck(!this.onDeck);
    // L: the spyglass (from the chase camera it first takes you on deck)
    if (inp.wasPressed('KeyL')) { if (!this.onDeck) this.setOnDeck(true); this.spyglass.toggle(); }
    if (inp.wasPressed('KeyN')) this.weather.cycle();
    if (inp.wasPressed('KeyM')) this.audio.toggleMute();
    if (inp.wasPressed('KeyP')) this.clock.paused = !this.clock.paused;
    // fast travel: − / + step through the multipliers
    const k = TRAVEL.indexOf(this.physics.travel);
    if (inp.wasPressed('Minus') || inp.wasPressed('NumpadSubtract')) this.physics.travel = TRAVEL[Math.max(0, k - 1)];
    if (inp.wasPressed('Equal') || inp.wasPressed('NumpadAdd')) this.physics.travel = TRAVEL[Math.min(TRAVEL.length - 1, k + 1)];
    // the chart needs a visible cursor: release the deck view's mouse lock (the next click takes it back)
    if (inp.wasPressed('Tab')) { this.map.toggle(); if (this.map.open) this.input.unlock(); }
    if (inp.wasPressed('Escape')) this.map.close();
    if (inp.wasPressed('KeyC') && this.map.open) this.map.center();
    // an hour of clock jump moves the clouds by an hour of wind as well: a different sky, not the same one
    const cloudWind = () => ({ x: this.wind.dir.x * this.wind.speed, z: this.wind.dir.z * this.wind.speed });
    if (inp.wasPressed('BracketRight')) { this.clock.advance(1); this.clouds.skip(3600, cloudWind()); }
    if (inp.wasPressed('BracketLeft')) { this.clock.advance(-1); this.clouds.skip(-3600, cloudWind()); }
  }

  frame(now: number): void {
    // apply a deferred resolution change before anything is drawn this frame
    if (this.pendingQuality !== null) {
      this.quality = this.pendingQuality;
      this.pendingQuality = null;
      this.outOfBand = 0;
      this.resize();
    }
    // rAF timestamps can predate performance.now() taken at start → never let time run backwards
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time = Config.fixedTime ?? this.time + dt;
    const t = this.time;
    const stepDt = Config.fixedTime !== null ? 1 / 60 : dt;

    this.renderer.info.reset();
    this.handleKeys();
    // ---- time of day + weather drive everything below ----
    const realDt = Config.fixedTime !== null ? 0 : dt;
    this.clock.update(realDt);
    this.weather.update(Config.fixedTime !== null ? 1 / 60 : dt);
    const wp = this.weather.p;
    this.wind.baseSpeed = wp.wind;
    this.wind.gustiness = wp.gustiness;
    this.wind.update(t);
    if (Math.abs(this.waves.intensity - wp.waves) > 0.005) { this.waves.intensity = wp.waves; this.waves.pack(); }
    // timelapse: while the (compressed) day runs, clouds drift and evolve faster than real time
    const cloudRate = this.clock.paused || this.clock.dayLength <= 0 ? 1 : CLOUD_TIMELAPSE;
    this.updateClouds((Config.fixedTime !== null ? 1 / 60 : dt) * cloudRate);
    this.env.update(Config.fixedTime !== null ? 1 / 60 : dt, this.clock, this.weather);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.env.fogColor);
    fog.density = this.env.fogDensity;
    this.pipeline.post.exposure = this.env.exposure;
    this.pipeline.post.golden = this.env.golden;

    // --- simulation ---
    this.physics.update(stepDt, t, this.input);
    const body = this.physics;
    body.applyVisuals(this.boat, t);
    this.boat.setLantern(Math.max(this.env.night, this.weather.p.overcast > 0.85 ? 0.4 : 0), t);
    this.mission.update(stepDt, t, body.origin, this.waves);
    this.markers.update(t, this.cam.camera.position, this.waves, this.env.night);
    this.fish.update(stepDt, body.origin, body.origin, 1 - this.env.night);
    this.discovery.update(dt, body.origin.x, body.origin.z);
    this.map.update(dt, { x: body.origin.x, z: body.origin.z, heading: body.heading });

    // --- camera ---
    const focus = body.origin.clone();
    if (Config.freeCam) {
      const c = Config.freeCam;
      this.cam.camera.position.set(c[0], c[1], c[2]);
      this.cam.camera.lookAt(c[3] ?? 0, c[4] ?? 0, c[5] ?? 0);
    } else {
      if (this.onDeck) {
        const sg = this.spyglass;
        sg.update(dt, this.input, !this.map.open);
        this.walker.scope = sg.raise;
        this.walker.magnification = sg.magnification;
        this.walker.tremor = sg.tremor();
        this.walker.update(dt, this.input, this.boat.root, this.cam.camera);
      }
      else this.cam.update(dt, this.input, focus, body.heading, (x, z) => this.terrain.heightAt(x, z));
    }
    this.cam.camera.updateMatrixWorld();
    this.updateLens(dt);

    // --- water simulation ---
    const u = this.water.uniforms;
    u.uWaveTime.value = t;
    u.uTime.value = t;
    u.uView.value = VIEW_IDS[this.view];
    u.uSunDir.value.copy(this.env.lightDir);
    u.uSunRadIn.value.copy(this.env.sunRadiance);
    u.uSkyIrr.value.copy(this.env.skyIrradiance);
    u.uChop.value = wp.chop;
    u.uWhitecaps.value = wp.whitecaps;
    u.uRain.value = wp.rain;
    u.uFogColor.value.copy(this.env.fogColor);
    u.uFogDensity.value = this.env.fogDensity;

    this.spectrum.update(t * 0.9);
    this.followV2.set(focus.x + body.velocity.x * 1.5, focus.z + body.velocity.z * 1.5);
    this.ripples.update(stepDt, this.followV2, body.wakeDisturbance());
    this.caustics.update(this.env.lightDir);

    this.vegetation.update(t, this.wind.dir.x, this.wind.dir.z, this.wind.speed);
    this.env.follow(focus);

    if (this.inspect) { this.renderInspect(); return this.input.endFrame(); }
    const cp = this.cam.camera.position;
    const submerged = this.waves.heightAt(cp.x, cp.z, t) - cp.y;
    this.particles.update(t, cp, submerged > -1.5, this.env.sunRadiance, this.env.lightDir);
    this.weatherFx.update(t, cp, this.weather, this.wind.dir.x * this.wind.speed, this.wind.dir.z * this.wind.speed, this.env.skyIrradiance);
    this.pipeline.render(this.cam.camera, t, this.view, this.caustics.target.texture, submerged);

    // ---- sound ----
    this.shoreT -= dt;
    if (this.shoreT <= 0) { this.shoreT = 0.5; this.shore = this.shoreProximity(focus); }
    const av = body.angVel;
    this.audio.update(dt, {
      windSpeed: this.wind.speed, rain: wp.rain, speed: body.speed, motion: Math.hypot(av.x, av.z),
      luffing: body.luffing, sailsUp: body.sailsUp, submerged, night: this.env.night, shore: this.shore,
      waves: wp.waves, daylight: 1 - this.env.night,
    });

    this.hud.update(this);
    this.debug.update(dt);
    this.adaptQuality(dt);
    this.input.endFrame();
  }

  /** ?inspect=side|front|top — orthographic boat view with a 1 m grid (for rigging measurements) */
  private readonly inspect = new URLSearchParams(location.search).get('inspect');
  private inspectCam?: THREE.OrthographicCamera;
  private renderInspect(): void {
    if (!this.inspectCam) {
      const a = innerWidth / innerHeight, h = 16;
      this.inspectCam = new THREE.OrthographicCamera(-h * a, h * a, h, -h, -100, 100);
      const v = this.inspect;
      const grid = new THREE.GridHelper(60, 60, 0xff0000, 0x333333);
      if (v === 'side') { this.inspectCam.position.set(-50, 10, 3); grid.rotation.z = Math.PI / 2; this.inspectCam.lookAt(0, 10, 3); }
      else if (v === 'front') { this.inspectCam.position.set(0, 10, 50); grid.rotation.x = Math.PI / 2; this.inspectCam.lookAt(0, 10, 0); }
      else { this.inspectCam.position.set(0, 50, 3); this.inspectCam.up.set(1, 0, 0); this.inspectCam.lookAt(0, 0, 3); }
      grid.position.y = 0;
      (grid.material as THREE.Material).depthTest = false;
      grid.renderOrder = 10;
      this.boat.model.add(grid);
      this.boat.root.position.set(0, 0, 0);
      this.boat.root.quaternion.identity();
      this.boat.sail.forEach((m) => (m.visible = true));
      this.scene.background = new THREE.Color(0xdddddd);
      this.terrain.group.visible = false;
      this.env.sky.visible = false;
      this.scene.fog = null;
    }
    this.boat.root.position.set(0, 0, 0);
    this.boat.root.quaternion.identity();
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.inspectCam);
  }

  /** switch between the chase camera and walking the deck */
  setOnDeck(on: boolean): void {
    this.onDeck = on;
    const cam = this.cam.camera;
    // the mast and rails come within a hand's reach of the eye: a closer near plane on deck
    cam.near = on ? 0.08 : 0.3;
    cam.updateProjectionMatrix();
    this.physics.wasd = !on;
    this.input.wantLock = on;
    if (on) this.walker.spawn(this.boat.info.hullStern);
    else { this.input.unlock(); this.spyglass.close(); this.spyglass.raise = 0; this.spyglass.update(0, this.input, false); }
  }

  /** is the top of the island at (x, z) visible from the eye, or does nearer land stand in the way? */
  private inSight(eye: THREE.Vector3, x: number, z: number, radius: number): boolean {
    const top = Math.max(1, terrainHeight(x, z));
    const dx = x - eye.x, dz = z - eye.z, D = Math.hypot(dx, dz);
    const n = Math.min(80, Math.ceil(D / 25));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (D * (1 - t) < radius) break; // reached the island itself
      const line = eye.y + (top - eye.y) * t;
      if (terrainHeight(eye.x + dx * t, eye.z + dz * t) > line + 0.3) return false;
    }
    return true;
  }

  /**
   * Spyglass optics for everything that depends on the view: narrow field of view, finer terrain and water
   * detail inside the lens, the round field in the post pass, and naming (and charting) what is in it.
   */
  private updateLens(dt: number): void {
    const cam = this.cam.camera, sg = this.spyglass, mag = this.onDeck ? sg.magnification : 1;
    const fov = (2 * Math.atan(Math.tan((55 * Math.PI) / 360) / mag) * 180) / Math.PI;
    if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const halfAngle = Math.atan(Math.tan((fov * Math.PI) / 360) * cam.aspect);
    this.terrain.update(cam.position, undefined, mag > 1.01 ? { dir, halfAngle, zoom: mag } : undefined);
    this.water.uniforms.uLodScale.value = 1 / mag;
    this.pipeline.post.scope = this.onDeck ? sg.raise : 0;
    this.pipeline.post.scopeR = LENS_R;
    if (!this.onDeck || sg.raise < 0.02) return;

    // what is in the lens: the island nearest the centre of the field, if the haze lets it be seen
    this.scopeT -= dt;
    if (this.scopeT <= 0 && sg.raise > 0.8) {
      this.scopeT = 0.2;
      this.scopeLabel = '';
      const p = cam.position, fl = Math.hypot(dir.x, dir.z) || 1;
      let best = Infinity;
      for (const f of featuresNear(p.x, p.z, 6000)) {
        const dx = f.x - p.x, dz = f.z - p.z, D = Math.hypot(dx, dz);
        if (D < f.radius) continue; // (inside it: the home lagoon)
        const shore = D - f.radius;
        if (Math.exp(-((this.env.fogDensity * shore) ** 2)) < 0.06) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, (dx * dir.x + dz * dir.z) / (D * fl))));
        const off = ang - Math.atan(f.radius / D);
        if (off < halfAngle * 0.45 && off < best && this.inSight(p, f.x, f.z, f.radius)) {
          best = off;
          const km = shore < 1000 ? `${Math.round(shore / 10) * 10} m` : `${(shore / 1000).toFixed(1).replace('.', ',')} km`;
          this.scopeLabel = `${placeName(f.kind, f.x, f.z)} · ${km}`;
          this.discovery.revealAt(f.x, f.z, f.radius + 150);
        }
      }
    }
    // compass bearing of the view: north = −z, east = +x
    sg.show((Math.atan2(dir.x, -dir.z) * 180) / Math.PI, this.scopeLabel);
  }

  private updateClouds(dt: number): void {
    const w = this.weather.p, s = this.weather.strike;
    if (s) this.flashDir.set(Math.sin(s.angle), 0.25, Math.cos(s.angle)).normalize();
    const focus = this.cam?.camera.position ?? new THREE.Vector3();
    this.clouds.update(dt, focus, { coverage: w.cloudCoverage, density: w.cloudDensity, base: w.cloudBase, top: w.cloudTop, type: w.cloudType },
      { x: this.wind.dir.x * this.wind.speed, z: this.wind.dir.z * this.wind.speed },
      { dir: this.env.cloudLightDir, color: this.env.cloudLight, ambient: this.env.cloudAmbient, flash: this.weather.flash, flashDir: this.flashDir });
    const r = cloudShadowUniforms.uCloudShadowRect.value;
    r.set(this.clouds.shadowCenter.x, this.clouds.shadowCenter.y, this.clouds.shadowSize);
  }

  /** 0 in open water … 1 next to a beach (for surf / crickets / gulls) */
  private shoreProximity(p: THREE.Vector3): number {
    let best = 160;
    for (const r of [20, 45, 80, 130]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        if (this.terrain.heightAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r) > 0.2) { best = Math.min(best, r); break; }
      }
      if (best < 160) break;
    }
    return THREE.MathUtils.clamp(1 - best / 160, 0, 1);
  }

  /**
   * Adaptive render resolution. The resize itself is *deferred to the start of the next frame*: resizing the
   * canvas after this frame has been drawn clears it, and the browser would present a black frame (flicker).
   * Hysteresis: the frame time must stay out of the band for ~2 s, and steps are at least 4 s apart.
   */
  private adaptQuality(dt: number): void {
    if (!Config.adaptiveQuality) return;
    this.ftAvg = this.ftAvg * 0.95 + dt * 1000 * 0.05;
    this.framesSinceResize++;
    const slow = this.ftAvg > 21, fast = this.ftAvg < 13.5;
    this.outOfBand = slow || fast ? this.outOfBand + dt : 0;
    if (this.framesSinceResize < 240 || this.outOfBand < 2) return;
    if (slow && this.quality > 0.45) this.pendingQuality = Math.max(0.45, this.quality * 0.88);
    else if (fast && this.quality < 1.0) this.pendingQuality = Math.min(1.0, this.quality * 1.06);
  }
  private outOfBand = 0;
  private pendingQuality: number | null = null;

  get fps(): number { return 1000 / this.ftAvg; }

  /** used by tools/shot.mjs */
  debugSnapshot() {
    const p = this.physics;
    return { t: this.time.toFixed(2), fps: this.fps.toFixed(0), q: this.quality.toFixed(2), size: `${this.pipeline.width}x${this.pipeline.height}`, ...p.telemetry() };
  }
}
