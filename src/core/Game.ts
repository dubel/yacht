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
import { Discovery } from '../map/Discovery';
import { MapUI } from '../map/MapUI';
import { DeckMap } from '../boat/DeckMap';
import { FishLife } from '../life/Fish';
import { Gulls } from '../life/Gulls';
import { Flamingos } from '../life/Flamingos';
import { Dolphins } from '../life/Dolphins';
import { Splash } from '../life/Splash';
import { DeckWalker } from '../camera/DeckWalker';
import { LandWalker } from '../camera/LandWalker';
import { LENS_R, Spyglass } from '../camera/Spyglass';
import { GunSight } from '../camera/GunSight';
import { Guns } from '../combat/Guns';
import { Artillery, RELOAD } from '../combat/Artillery';
import { Musketry } from '../combat/Musketry';
import { Weapons } from '../fpv/Weapons';
import { Kedge } from '../gameplay/Kedge';
import { Anchor } from '../gameplay/Anchor';
import { Landing } from '../gameplay/Landing';
import { Inventory, ITEMS, SLOTS } from '../gameplay/Inventory';
import { Hotbar } from '../ui/Hotbar';
import { ItemIcons } from '../ui/ItemIcons';
import { InventoryUI } from '../ui/InventoryUI';
import { Status } from '../ui/Status';
import { Vomit } from '../fpv/Vomit';
import { OFF } from '../boat/DeckMap';
import { SkullIsland } from '../world/SkullIsland';
import { Tortuga } from '../world/Tortuga';
import { resetWorldState } from '../gameplay/worldState';
import { SKULL_ISLAND } from '../world/WorldGen';
import type { Weapon } from '../fpv/Weapons';
import { Leadsman } from '../gameplay/Leadsman';
import { Music, type Mood } from '../audio/Music';
import { terrainHeight as landAt } from '../world/WorldGen';
import { featuresNear, terrainHeight, TORTUGA_QUAY } from '../world/WorldGen';
import { Vegetation } from '../world/Vegetation';
import { Messages } from '../gameplay/Messages';
import { Surf } from '../world/Surf';
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
  /** short messages across the screen */
  readonly messages = new Messages();
  surf!: Surf;
  readonly fish = new FishLife();
  readonly gulls = new Gulls();
  /** flamingos wading on the home lagoon's shallows */
  readonly flamingos = Config.flamingos ? new Flamingos({ x: 0, z: 0 }) : null;
  readonly dolphins = new Dolphins();
  readonly splash = new Splash();
  /** F9: all the animals (fish, gulls, dolphins, their spray and calls) — off to save frame time */
  fauna = (() => { try { return localStorage.getItem('lagoon.fauna') !== 'off'; } catch { return true; } })();
  readonly discovery = new Discovery(Config.worldSeed);
  map!: MapUI;
  physics!: BoatPhysics;
  deck!: DeckMap;
  walker!: DeckWalker;
  /** first-person view from the deck (F) */
  onDeck = false;
  /** the sailor ashore (rowed there from the ship at anchor, B) */
  land!: LandWalker;
  landing!: Landing;
  /** Tortuga's waterfront: its piers, and going ashore there straight from the ship */
  tortuga!: Tortuga;
  get ashore(): boolean { return (this.landing?.ashore ?? false) || (this.tortuga?.ashore ?? false); }
  /** first person: on deck or ashore */
  get fpv(): boolean { return this.onDeck || this.ashore; }
  private deepSaid = -Infinity;
  /** the Skull Island's cave, its guards and its gold */
  skull!: SkullIsland;
  /** game hours on the clock last frame (the island's respawn clock runs on game time) */
  private lastHours = 0;
  private dead = false;
  /** rum in him, in swigs (a bottle holds 8); one wears off in some 22 s */
  drunk = 0;
  private hicT = 10;
  /** too much rum coming back up; when the next fit is due (s, game time; Infinity: none), the last one */
  vomit!: Vomit;
  private vomitAt = Infinity;
  private lastVomit = -1e9;
  private readonly hurtEl = Object.assign(document.createElement('div'), { id: 'hurt' });
  private revealT = 0;
  readonly spyglass = new Spyglass();
  guns!: Guns;
  readonly artillery = new Artillery();
  readonly gunSight = new GunSight();
  readonly weapons = new Weapons();
  musketry!: Musketry;
  kedge!: Kedge;
  anchor!: Anchor;
  readonly leadsman = new Leadsman();
  readonly music = new Music();
  /** what he owns: slots 1–9, the bag, ducats, health */
  readonly inventory = new Inventory();
  readonly hotbar = new Hotbar(this.inventory);
  /** the things' icons: their models, turning */
  readonly icons = new ItemIcons((use) => this.weapons.pieceCopy(use as Exclude<Weapon, 'none'>));
  /** the captain's chest (I) */
  readonly chest = new InventoryUI(this.inventory, this.icons);
  /** top right: the ducats and his life */
  readonly status = new Status(this.inventory);
  private hotbarDirty = true;
  private coinDone = false;
  private iconT = 0;
  private landNear = true;
  private landT = 0;
  private lastWeather = '';
  private knockT = 0;
  /** gun the sailor on deck is standing at (−1: none) */
  private nearGun = -1;
  /** the Ctrl that manned the gun this frame must not also fire it */
  private justManned = false;
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
    // the chest open: the game hears no keys but its own, the pointer is free
    this.chest.onOpen = (open) => {
      this.input.suspended = open;
      if (open) this.input.unlock();
      this.audio.paper();
    };
    this.chest.onPick = () => this.audio.tap(false);
    this.chest.onDrop = () => this.audio.tap(true);
    this.inventory.onChange(() => { this.hotbarDirty = true; });
    if (Config.inventory) this.inventory.debug(Config.inventory);
    addEventListener('resize', () => this.resize());
  }

  async init(progress: (f: number) => void): Promise<void> {
    const pebbles = await new THREE.TextureLoader().loadAsync('assets/textures/pebbles.jpg');
    pebbles.colorSpace = THREE.SRGBColorSpace;
    pebbles.wrapS = pebbles.wrapT = THREE.RepeatWrapping;
    pebbles.anisotropy = 8;
    progress(0.1);

    this.vegetation = new Vegetation();
    this.terrain = new Terrain(pebbles, Config.worldSeed, this.vegetation, Config.flamingos);
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
    this.guns = new Guns(this.boat);
    // what the sailor carries: pistol and rapier, drawn over everything
    this.pipeline.overlay = this.weapons.overlay;
    await this.weapons.load();
    // throwing up: the fit's sounds, the splats, where the stuff lands (the deck under it, the ground, the sea)
    this.vomit = new Vomit({
      sound: (k) => { this.audio.retch(k); if (k === 'gush') this.messages.say('Rum wraca tą samą drogą…', 3); },
      splat: (at, big) => { const h = this.heardFrom(at.x, at.z); this.audio.splat(h.pan, Math.hypot(h.d, at.y - this.cam.camera.position.y), big); },
      floor: (x, z) => {
        if (this.onDeck) {
          const root = this.boat.root, l = root.worldToLocal(new THREE.Vector3(x, this.cam.camera.position.y, z)), f = this.deck.at(l.x, l.z);
          // (over the side: down into the sea)
          if (f === OFF) return { y: -0.3, deck: false };
          return { y: root.localToWorld(l.setY(f)).y, deck: true };
        }
        return { y: terrainHeight(x, z), deck: false };
      },
    }, this.boat.root);
    this.scene.add(this.vomit.group);
    this.boat.root.add(this.vomit.deckGroup);
    this.scene.add(this.weapons.worldLight);
    this.musketry = new Musketry(this.deck, this.boat.root);
    this.scene.add(this.musketry.mesh);
    this.weapons.onPan = (hang) => this.audio.pistol(hang);
    this.weapons.onReady = () => this.audio.cock();
    // the rum: a swig, its gulps, the head swimming the more for each; an empty bottle filled from the ship's cask
    this.weapons.onSwig = () => this.audio.swig();
    this.weapons.onGulp = () => this.audio.gulp();
    this.weapons.onDrunk = () => {
      this.drunk = Math.min(11, this.drunk + 1);
      // from the second swig on, the rum may not stay down (not more than once in a while)
      const chance = this.drunk >= 3 ? 0.5 : this.drunk >= 1.8 ? 0.3 : 0;
      if (this.fpv && !this.vomit.active && this.vomitAt === Infinity && this.time - this.lastVomit > 25 && Math.random() < chance)
        this.vomitAt = this.time + 1 + Math.random() * 1.5;
    };
    this.weapons.onEmpty = () => {
      if (this.onDeck) { this.messages.say('Napełniasz flaszkę rumem z beczki w ładowni.', 3); return true; }
      this.messages.say('Pusta flaszka. Napełnisz ją na statku.', 3);
      return false;
    };
    this.weapons.onSlash = (cut) => this.audio.swoosh(cut === 0 ? 0.3 : -0.3);
    this.weapons.onPistol = (muzzle, dir) => {
      this.musketry.fire(muzzle, dir, this.ashore ? new THREE.Vector3() : this.physics.velocity);
      this.artillery.pistolSmoke(muzzle, dir);
    };
    this.musketry.onHit = (kind, at) => {
      this.artillery.chips(at, kind === 'ricochet' ? 'wood' : kind === 'bone' ? 'land' : kind);
      if (kind === 'water') { this.splash.burst(at.x, at.y, at.z, 10, 3); this.ripples.disturb(at.x, at.z, 0.35, 0.04); }
      // (a guard struck: the island sounds the bone itself)
      if (kind === 'bone') return;
      const h = this.heardFrom(at.x, at.z);
      this.audio.bullet(kind, h.pan, Math.hypot(h.d, at.y - this.cam.camera.position.y));
    };
    if (Config.worldStateReset) resetWorldState();
    // the Skull Island: its rocks, torches, guards and gold
    const sound = { boneHit: 'boneHit', collapse: 'collapse', rise: 'rise' } as const;
    this.skull = new SkullIsland({
      say: (text, sec) => this.messages.say(text, sec),
      hurt: (k) => this.hurt(k),
      gold: (n) => this.inventory.setDucats(this.inventory.ducats + n),
      voice: (kind, at, echo) => {
        const h = this.heardFrom(at.x, at.z);
        this.audio.growl(kind, h.pan, h.d, echo);
        // (near, the music steps aside for it)
        if (kind !== 'grunt' && h.d < 18) this.music.duckFor(kind === 'roar' ? 0.6 : 0.4, kind === 'roar' ? 3 : 2);
      },
      sound: (kind, at) => {
        const h = this.heardFrom(at.x, at.z);
        if (kind === 'swing') this.audio.swoosh(h.pan * 0.5);
        else if (kind === 'coins') this.audio.coins();
        else this.audio[sound[kind]](h.pan, h.d);
      },
    });
    await this.skull.load();
    this.scene.add(this.skull.group, ...this.skull.lights);
    this.musketry.target = (a, b) => this.skull.shoot(a, b);
    // the rapier through the middle of its cut: a guard in reach is struck
    this.weapons.onCutHit = () => {
      const cam = this.cam.camera, at = this.skull.cut(cam.position, cam.getWorldDirection(new THREE.Vector3()));
      if (at) this.artillery.chips(at, 'land');
    };
    document.body.append(this.hurtEl);
    this.scene.add(this.artillery.balls);
    this.pipeline.late.add(this.artillery.late);
    // surf breaking on the reefs (the white line; a pass is the gap in it)
    const wu = this.water.uniforms;
    this.surf = new Surf({ uWaveA: wu.uWaveA, uWaveB: wu.uWaveB, uWaveTime: wu.uWaveTime });
    this.pipeline.late.add(this.surf.group);
    this.artillery.onFire = (x, _y, z) => {
      const h = this.heardFrom(x, z);
      this.audio.cannon(h.pan, h.d);
      if (this.gunSight.active) this.gunSight.recoil();
    };
    this.artillery.onImpact = (kind, x, y, z) => {
      if (kind === 'water') {
        // a column of white water, and rings where the ball went in
        this.splash.burst(x, y, z, 70, 10);
        this.ripples.disturb(x, z, 1.4, 0.25);
      }
      const h = this.heardFrom(x, z);
      this.audio.impact(kind, h.pan, h.d);
    };
    this.spyglass.onOpen = (open) => this.audio.spyglass(open);
    this.physics = new BoatPhysics(this.boat.info, this.waves, this.wind, (x, z) => this.terrain.heightAt(x, z));
    this.physics.reset(new THREE.Vector3(0, 0, 0), START_BEARING, Config.startSpeed);
    // aground: kedging off (K); underway: the leadsman sounding ahead
    this.kedge = new Kedge(this.physics, {
      say: (text, s) => this.messages.say(text, s),
      oar: (at) => { const h = this.heardFrom(at.x, at.z); this.audio.oar(h.pan, h.d); },
      anchor: (at) => { const h = this.heardFrom(at.x, at.z); this.audio.anchorDrop(h.pan, h.d); this.splash.burst(at.x, 0.1, at.z, 25, 4); this.ripples.disturb(at.x, at.z, 0.8, 0.12); },
      capstan: () => this.audio.capstan(),
      scrape: (k) => this.audio.scrape(k),
      done: (hours) => { this.clock.advance(hours); this.clouds.skip(hours * 3600, { x: this.wind.dir.x * this.wind.speed, z: this.wind.dir.z * this.wind.speed }); },
    }, () => this.discovery.track);
    this.scene.add(this.kedge.group);
    // Z: come to anchor off an island (and weigh it again)
    this.anchor = new Anchor(this.physics, {
      say: (text, s) => this.messages.say(text, s),
      letGo: (at) => {
        const h = this.heardFrom(at.x, at.z);
        this.audio.anchorDrop(h.pan, h.d);
        this.audio.cableOut(h.pan, h.d);
        this.splash.burst(at.x, 0.1, at.z, 25, 4);
        this.ripples.disturb(at.x, at.z, 0.8, 0.12);
      },
      capstan: () => this.audio.capstan(),
      hawse: (out) => out.set(0, this.boat.info.deckHeight * 0.7, this.boat.info.hullBow - 0.6).applyMatrix4(this.boat.root.matrixWorld),
    });
    this.scene.add(this.anchor.group);
    // ashore: walking the island, and the jolly boat that takes him there and back
    this.land = new LandWalker();
    this.land.onStep = (pace, ground, wade) => this.audio.groundStep(pace, ground, 1, wade);
    this.land.onLand = (h) => this.audio.groundStep(0.5, this.land.ground(), 1 + Math.min(1.2, h * 1.6), this.land.wade);
    this.land.onJump = () => this.audio.groundStep(0.8, this.land.ground(), 0.8, this.land.wade);
    this.land.onDeep = () => {
      if (this.time - this.deepSaid < 6) return;
      this.deepSaid = this.time;
      this.messages.say('Dalej nie — jak większość marynarzy, nie umiesz pływać.', 3);
    };
    this.landing = new Landing({
      say: (text, s) => this.messages.say(text, s),
      oar: (at) => { const h = this.heardFrom(at.x, at.z); this.audio.oar(h.pan, h.d); },
      goAshore: (stand, yaw) => this.goAshore(stand, yaw),
      comeAboard: () => this.setOnDeck(true),
      hours: (h) => { this.clock.advance(h); this.clouds.skip(h * 3600, { x: this.wind.dir.x * this.wind.speed, z: this.wind.dir.z * this.wind.speed }); },
    });
    this.land.obstacles = this.landing.obstacles;
    this.tortuga = new Tortuga({
      say: (text, s) => this.messages.say(text, s),
      moor: () => { this.anchor.dropNow(); this.physics.setSails(false); this.physics.sailsUp = 0; this.messages.say('Cumy na keję! Statek przycumowany.', 3); },
      goAshore: (stand, yaw) => this.goAshore(stand, yaw),
      comeAboard: () => this.setOnDeck(true),
    });
    this.land.blocked = (x, z) => this.skull.blocked(x, z) || this.tortuga.blocked(x, z);
    this.land.floorAt = (x, z) => this.tortuga.floorAt(x, z);
    this.physics.fenders = (x, z) => this.tortuga.push(x, z);
    await Promise.all([this.landing.load('assets/boats/jollyboat.glb'), this.tortuga.load()]);
    this.scene.add(this.tortuga.group);
    this.scene.add(this.landing.group);
    this.leadsman.onCall = (c) => this.audio.bell(c.level);
    this.scene.add(this.fish.mesh, this.gulls.mesh);
    this.gulls.onCall = (pan, d) => this.audio.gull(pan, d);
    if (this.flamingos) {
      await this.flamingos.load('assets/life/flamingo.glb');
      this.scene.add(this.flamingos.group);
      this.flamingos.onCall = (x, z) => { const h = this.heardFrom(x, z); this.audio.flamingo(h.pan, h.d); };
    }
    this.scene.add(this.dolphins.mesh, this.splash.points);
    if (!this.fauna) this.setFauna(false, true);
    // where a sound comes from relative to the camera: pan −1…1 and distance
    const heard = (x: number, z: number) => {
      const cam = this.cam.camera, r = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const dx = x - cam.position.x, dz = z - cam.position.z, d = Math.hypot(dx, dz) || 1;
      return { pan: (dx * r.x + dz * r.z) / d, d };
    };
    this.dolphins.onSplash = (x, y, z, power, vx, vz) => {
      this.splash.burst(x, y, z, Math.round(10 + power * 7), power, { x: vx, z: vz });
      this.ripples.disturb(x, z, 0.9 + power * 0.2, 0.05 + power * 0.035);
      const h = heard(x, z);
      this.audio.splash(h.pan, h.d, power);
    };
    this.dolphins.onBlow = (x, z) => {
      this.splash.burst(x, 0.3, z, 8, 1.6);
      const h = heard(x, z);
      this.audio.blow(h.pan, h.d);
    };
    this.map = new MapUI(this.discovery, Config.worldSeed);
    if (Config.location === 'skull') this.startAtSkull();
    if (Config.location === 'tortuga') this.startOffTortuga();
    if (Config.location === 'tortuga-quay') this.startAtTortuga();
    this.lastHours = this.clock.day * 24 + this.clock.hours;
    progress(1);

    this.resize();
    // compile everything up front so the first frames don't hitch
    this.renderer.compile(this.scene, this.cam.camera);
    // the late pass (gun smoke, flashes) too — its meshes are hidden until the first shot, which would
    // otherwise compile them mid-broadside
    const hidden = this.artillery.late.children.filter((o) => !o.visible);
    hidden.forEach((o) => (o.visible = true));
    this.renderer.compile(this.pipeline.late, this.cam.camera);
    hidden.forEach((o) => (o.visible = false));
    // and what the sailor carries (hidden until drawn)
    const held = this.weapons.overlay.getObjectsByProperty('visible', false);
    held.forEach((o) => (o.visible = true));
    this.renderer.compile(this.weapons.overlay, this.cam.camera);
    held.forEach((o) => (o.visible = false));
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
    const fkeys: [string, ViewMode][] = [['F2', 'final'], ['F3', 'normals'], ['F4', 'caustics'], ['F5', 'reflection'], ['F6', 'depth'], ];
    for (const [k, v] of fkeys) if (inp.wasPressed(k)) this.view = v;
    if (inp.wasPressed('KeyR') && this.ashore) this.messages.say('Najpierw wróć na statek (szalupą, B).', 3);
    else if (inp.wasPressed('KeyR')) this.physics.reset(new THREE.Vector3(0, 0, 0), START_BEARING, 0);
    // F8 (or H): the controls panel on / off
    if (inp.wasPressed('F8') || inp.wasPressed('KeyH')) this.hud.toggleHelp();
    if (inp.wasPressed('KeyV') && !this.fpv) this.cam.toggleDive();
    if (inp.wasPressed('KeyF') && this.ashore) this.messages.say('Jesteś na lądzie — wróć do szalupy (B).', 3);
    else if (inp.wasPressed('KeyF')) this.setOnDeck(!this.onDeck);
    // guns: from the chase camera, left Ctrl fires the port broadside, right Ctrl the starboard one
    const ctrlL = inp.wasPressed('ControlLeft'), ctrlR = inp.wasPressed('ControlRight');
    if (!this.fpv && !this.map.open && (ctrlL || ctrlR)) this.broadside(ctrlL ? 'port' : 'starboard');
    // on deck: Ctrl at a gun mans it; manning, Ctrl or a click fires, walking away (or Esc) leaves it
    if (this.onDeck && !this.map.open) {
      if (this.gunSight.active) {
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Escape', 'KeyF'].some((k) => inp.wasPressed(k))) this.gunSight.exit();
      } else if ((ctrlL || ctrlR) && this.nearGun >= 0 && this.spyglass.raise < 0.1 && !this.weapons.drawn) {
        this.gunSight.enter(this.nearGun);
        this.justManned = true;
      }
    }
    if (inp.wasPressed('F9')) this.setFauna(!this.fauna);
    if (inp.wasPressed('F10')) this.messages.say(this.hud.toggleInstruments() ? 'Przyrządy statku widoczne (F10)' : 'Przyrządy statku schowane (F10)', 2.5);
    if (inp.wasPressed('F7')) this.messages.say(this.music.toggle() ? 'Muzyka włączona (F7)' : 'Muzyka wyłączona (F7)', 2.5);
    // 1–9: use what lies in that slot — a weapon or lantern taken out (again: put away), the spyglass raised;
    // on deck (from the chase camera, it takes you there). What is in which slot is the inventory's (I).
    let key = -1;
    for (let i = 0; i < SLOTS; i++) if (inp.wasPressed(`Digit${i + 1}`)) key = i;
    const use = key >= 0 ? ITEMS[this.inventory.slot(key)?.id ?? '']?.use : undefined;
    if (use && !this.map.open) {
      if (!this.fpv) this.setOnDeck(true);
      if (this.gunSight.active) this.gunSight.exit();
      if (use === 'spyglass') { this.weapons.holster(); this.spyglass.toggle(); }
      else { this.spyglass.close(); this.weapons.select(use); }
    }
    // L: the spyglass, if he has one (from the chase camera it first takes you on deck)
    if (inp.wasPressed('KeyL') && this.inventory.has('spyglass')) { if (!this.fpv) this.setOnDeck(true); this.spyglass.toggle(); }
    if (inp.wasPressed('KeyN')) this.weather.cycle();
    if (inp.wasPressed('KeyM')) this.audio.toggleMute();
    if (inp.wasPressed('KeyP')) this.clock.paused = !this.clock.paused;
    // fast travel: − / + step through the multipliers
    const k = TRAVEL.indexOf(this.physics.travel);
    if (inp.wasPressed('Minus') || inp.wasPressed('NumpadSubtract')) this.physics.travel = TRAVEL[Math.max(0, k - 1)];
    if (inp.wasPressed('Equal') || inp.wasPressed('NumpadAdd')) this.physics.travel = TRAVEL[Math.min(TRAVEL.length - 1, k + 1)];
    // the chart needs a visible cursor: release the deck view's mouse lock (the next click takes it back)
    if (inp.wasPressed('Tab')) { this.chest.close(); this.map.toggle(); if (this.map.open) this.input.unlock(); }
    if (inp.wasPressed('KeyI')) { this.map.close(); this.chest.toggle(); }
    if (inp.wasPressed('Escape')) { this.map.close(); this.chest.close(); }
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
    // in the Skull Island's passage: the sky's light shut out (the torches are what light it), the eye opening
    const dark = this.skull?.dark ?? 0;
    this.env.light.intensity *= 1 - 0.96 * dark;
    this.scene.environmentIntensity = 1 - 0.93 * dark;
    this.weatherFx.group.visible = !this.skull?.inside;
    this.pipeline.post.exposure = this.env.exposure * (1 + 0.6 * dark);
    this.pipeline.post.golden = this.env.golden;

    // --- simulation ---
    this.physics.update(stepDt, t, this.input);
    const body = this.physics;
    body.applyVisuals(this.boat, t);
    {
      const sky = this.env.skyIrradiance;
      this.boat.setLantern(Math.max(this.env.night, this.weather.p.overcast > 0.85 ? 0.4 : 0), t, (sky.x + sky.y + sky.z) / 3);
    }
    this.messages.update(stepDt);
    this.kedge.update(stepDt, t, this.input.wasPressed('KeyK'), this.waves);
    this.anchor.update(stepDt, this.input.wasPressed('KeyZ') && !this.ashore, this.wind.speed, this.kedge.state !== 'afloat');
    // (at Tortuga the ship goes alongside a pier and B takes him straight ashore: no jolly boat)
    const bKey = this.input.wasPressed('KeyB') && !this.map.open;
    const info = this.boat.info;
    const quay = !this.landing.ashore && this.tortuga.update(stepDt,
      { origin: body.origin, heading: body.heading, speed: body.speed, bow: info.hullBow, stern: info.hullStern, beam: info.beam },
      this.tortuga.ashore ? this.land.pos : null, bKey, !this.gunSight.active);
    this.landing.update(stepDt, {
      canGo: this.anchor.riding && !this.gunSight.active && !quay, ship: body.origin,
      sailor: this.landing.ashore ? this.land.pos : null, b: bKey && !quay,
    });
    // a squall coming on: the call to strike sail; laid over past ~78°: the crew lets everything fly
    if (this.weather.kind !== this.lastWeather) {
      if (this.weather.kind === 'squall') this.messages.say('Biały szkwał! Zrzucić żagle (X)!', 5);
      this.lastWeather = this.weather.kind;
    }
    this.knockT = Math.abs(body.heel) > (78 * Math.PI) / 180 ? this.knockT + stepDt : 0;
    if (this.knockT > 0.4 && body.sailsUp > 0.2) {
      body.dropSails();
      this.messages.say('Szkwał kładzie statek na burtę! Załoga puszcza szoty i zrzuca żagle!', 5);
    }
    {
      const o = body.origin, h = body.heading, bow = this.boat.info.hullBow;
      this.leadsman.update(stepDt, o.x + Math.sin(h) * bow, o.z + Math.cos(h) * bow, h, body.speed * body.travel, this.kedge.state !== 'afloat' || body.grounded);
    }
    if (this.fauna) {
      this.fish.update(stepDt, body.origin, body.origin, 1 - this.env.night);
      // gulls: a follower trails ~16 m astern; they keep away at night and in rain or heavy weather
      const o = body.origin, h = body.heading;
      const stern = new THREE.Vector3(o.x - Math.sin(h) * 16, 0, o.z - Math.cos(h) * 16);
      const ok = this.env.night < 0.3 && wp.rain < 0.15 && wp.wind < 13;
      const cam = this.cam.camera, right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      this.gulls.update(stepDt, t, o, stern, body.speed, ok, this.waves, cam.position, right);
      const bow = new THREE.Vector3(o.x + Math.sin(h) * this.boat.info.hullBow, 0, o.z + Math.cos(h) * this.boat.info.hullBow);
      this.dolphins.update(stepDt, t, o, bow, h, body.speed, wp.wind < 13 && this.env.night < 0.6, this.waves);
      // flamingos shy of a man on foot at some 30 m, of the ship (her bulk, her crew) from further
      const who = this.ashore ? this.land.pos : new THREE.Vector2(o.x, o.z);
      this.flamingos?.update(stepDt, who, this.ashore ? 30 : 70, this.cam.camera.position, this.env.night);
    }
    {
      // spray (dolphins, cannonballs) is white water: lit like the foam
      const sun = this.env.sunRadiance, sky = this.env.skyIrradiance, cam = this.cam.camera;
      const light = new THREE.Vector3(sun.x * 0.3 + sky.x * 0.6, sun.y * 0.3 + sky.y * 0.6, sun.z * 0.3 + sky.z * 0.6);
      this.splash.update(stepDt, light, this.pipeline.height, cam.fov);
      // guns: pieces nobody mans swing back; balls in flight, smoke drifting downwind
      this.guns.relax(stepDt, this.gunSight.active ? this.gunSight.gun : -1);
      const wv = { x: this.wind.dir.x * this.wind.speed, z: this.wind.dir.z * this.wind.speed };
      this.musketry.update(stepDt, t, this.waves);
      this.surf.update(stepDt, this.cam.camera.position, 0.8 + 0.06 * wp.waves + 0.25 * wp.whitecaps, sun, sky, this.env.fogColor, this.env.fogDensity,
        this.pipeline.sceneDepth, new THREE.Vector2(this.pipeline.width, this.pipeline.height), cam);
      this.artillery.update(stepDt, t, this.waves, wv, cam, this.pipeline.sceneDepth, new THREE.Vector2(this.pipeline.width, this.pipeline.height), sun, sky);
    }
    this.discovery.update(dt, body.origin.x, body.origin.z);
    // ashore, the map follows him and charts what he walks
    this.revealT -= dt;
    if (this.ashore && this.revealT <= 0) { this.revealT = 1; this.discovery.revealAt(this.land.pos.x, this.land.pos.y, 150); }
    this.map.update(dt, { x: body.origin.x, z: body.origin.z, heading: body.heading }, this.ashore ? { x: this.land.pos.x, z: this.land.pos.y } : null);

    this.updateDrunk(dt, t);
    // --- camera ---
    const focus = body.origin.clone();
    // where the player is (the ship, or him ashore): shadows, the sound of the shore
    const here = this.ashore ? new THREE.Vector3(this.land.pos.x, this.land.footY, this.land.pos.y) : focus;
    if (Config.freeCam) {
      const c = Config.freeCam;
      this.cam.camera.position.set(c[0], c[1], c[2]);
      this.cam.camera.lookAt(c[3] ?? 0, c[4] ?? 0, c[5] ?? 0);
    } else {
      if (this.onDeck && this.gunSight.active) {
        const gi = this.gunSight.gun, g = this.guns.list[gi];
        const shot = this.gunSight.update(dt, this.input, this.boat.root, g, this.cam.camera, this.artillery.reloading, RELOAD);
        // the piece follows the sight (a touch behind, like a heavy thing on a swivel)
        this.guns.aim(gi, this.gunSight.yaw, this.gunSight.pitch, 1 - Math.exp(-dt * 14));
        const inp = this.input;
        if (!this.justManned && (inp.wasPressed('ControlLeft') || inp.wasPressed('ControlRight') || inp.click)) this.artillery.fire(shot.muzzle, shot.dir, body.velocity);
        this.justManned = false;
        this.guns.highlight(-1, t);
        this.gunHint.hidden = true;
        this.weapons.overlay.visible = false;
        this.weapons.hideHud();
        this.hotbar.show(false);
      } else if (this.ashore) {
        const sg = this.spyglass;
        sg.update(dt, this.input, !this.map.open && !this.chest.open && this.inventory.has('spyglass'));
        this.land.scope = sg.raise;
        this.land.magnification = sg.magnification;
        this.land.tremor = sg.tremor();
        this.land.update(dt, this.input, this.cam.camera);
        const L = this.env.light;
        this.weapons.update(dt, this.input, this.cam.camera, this.land.stride, sg.raise > 0.08 || this.map.open || this.chest.open || this.vomit.active,
          this.env.lightDir, L.color, L.intensity, this.scene.environment);
        this.markSlots(sg.raise > 0.3);
        this.nearGun = -1;
        this.guns.highlight(-1, t);
        this.gunHint.hidden = true;
      } else if (this.onDeck) {
        const sg = this.spyglass;
        sg.update(dt, this.input, !this.map.open && !this.chest.open && this.inventory.has('spyglass'));
        this.walker.scope = sg.raise;
        this.walker.magnification = sg.magnification;
        this.walker.tremor = sg.tremor();
        this.walker.update(dt, this.input, this.boat.root, this.cam.camera);
        // what is in hand: follows the view, fires / cuts on Ctrl
        const L = this.env.light;
        this.weapons.update(dt, this.input, this.cam.camera, this.walker.stride, sg.raise > 0.08 || this.map.open || this.chest.open || this.vomit.active,
          this.env.lightDir, L.color, L.intensity, this.scene.environment);
        this.markSlots(sg.raise > 0.3);
        // walking past a gun (empty-handed): it lights up, Ctrl mans it
        this.nearGun = sg.raise < 0.1 && !this.weapons.drawn ? this.guns.near(this.walker.pos.x, this.walker.pos.y) : -1;
        this.guns.highlight(this.nearGun, t);
        this.gunHint.hidden = this.nearGun < 0;
      } else {
        this.cam.update(dt, this.input, focus, body.heading, (x, z) => this.terrain.heightAt(x, z));
        this.nearGun = -1;
        this.guns.highlight(-1, t);
        this.gunHint.hidden = true;
        this.weapons.overlay.visible = false;
        this.weapons.hideHud();
        this.hotbar.show(false);
      }
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
    this.env.follow(here);

    if (this.inspect) { this.renderInspect(); return this.input.endFrame(); }
    const cp = this.cam.camera.position;
    const submerged = this.waves.heightAt(cp.x, cp.z, t) - cp.y;
    this.particles.update(t, cp, submerged > -1.5, this.env.sunRadiance, this.env.lightDir);
    this.weatherFx.update(t, cp, this.weather, this.wind.dir.x * this.wind.speed, this.wind.dir.z * this.wind.speed, this.env.skyIrradiance);
    this.pipeline.render(this.cam.camera, t, this.view, this.caustics.target.texture, submerged);

    // ---- sound ----
    this.shoreT -= dt;
    if (this.shoreT <= 0) { this.shoreT = 0.5; this.shore = this.shoreProximity(here); }
    const av = body.angVel;
    const aboard = !this.ashore;
    this.audio.update(dt, {
      windSpeed: this.wind.speed, rain: wp.rain, speed: aboard ? body.speed : 0, motion: aboard ? Math.hypot(av.x, av.z) : 0,
      luffing: aboard && body.luffing, sailsUp: body.sailsUp, submerged, night: this.env.night, shore: this.shore, flock: this.fauna ? this.flamingos?.murmur ?? 0 : 0,
      waves: wp.waves, aboard: aboard ? 1 : 0,
    });

    this.music.update(dt, this.musicMood(dt), this.audio.started, this.audio.muted);
    {
      // the island: its clock runs on game hours (a jump back doesn't turn it back)
      const hours = this.clock.day * 24 + this.clock.hours;
      const feet = this.ashore ? new THREE.Vector3(this.land.pos.x, this.land.footY, this.land.pos.y) : null;
      this.skull.update(stepDt, feet, this.cam.camera.position, Math.max(0, hours - this.lastHours));
      this.lastHours = hours;
    }
    this.chest.update(dt);
    this.status.update(dt, this.ashore ? 0 : body.heel, this.onDeck ? this.walker.pace : this.ashore ? this.land.pace : 0);
    this.paintIcons(dt);
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

  /** F9: animals on / off; remembered between sessions */
  setFauna(on: boolean, quiet = false): void {
    this.fauna = on;
    for (const o of [this.fish.mesh, this.gulls.mesh, this.dolphins.mesh, this.flamingos?.group]) if (o) o.visible = on;
    try { localStorage.setItem('lagoon.fauna', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
    if (!quiet) this.messages.say(on ? 'Fauna włączona (F9)' : 'Fauna wyłączona (F9)', 2.5);
  }

  private readonly gunHint = (() => {
    const el = document.createElement('div');
    el.id = 'gunhint';
    el.hidden = true;
    el.innerHTML = '<kbd>Ctrl</kbd> — obsadź działo';
    document.body.append(el);
    return el;
  })();

  /** which music fits the moment: weather, time of day, where the ship is, what the crew is doing */
  private musicMood(dt: number): Mood {
    const k = this.kedge?.state;
    if (k === 'rowing' || k === 'hauling' || this.anchor?.state === 'weighing') return 'haul';
    const w = this.weather.p;
    if (w.lightning > 1 || w.wind > 12.5 || w.rain > 0.55) return 'storm';
    if (this.env.night > 0.35 || this.env.golden > 0.35) return 'dusk';
    // far from any land (checked every couple of seconds): the open sea
    this.landT -= dt;
    if (this.landT <= 0 && this.physics) {
      this.landT = 2;
      const o = this.physics.origin;
      this.landNear = false;
      for (const r of [150, 350, 700]) for (let a = 0; a < 16 && !this.landNear; a++)
        if (landAt(o.x + Math.cos(a * 0.3927) * r, o.z + Math.sin(a * 0.3927) * r) > 0.3) this.landNear = true;
    }
    return this.landNear ? 'calm' : 'voyage';
  }

  /** where a sound comes from, relative to the camera: pan −1…1 and distance */
  private heardFrom(x: number, z: number): { pan: number; d: number } {
    const cam = this.cam.camera, r = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const dx = x - cam.position.x, dz = z - cam.position.z, d = Math.hypot(dx, dz) || 1;
    return { pan: (dx * r.x + dz * r.z) / d, d };
  }

  /** every gun of one side, in order from the bow, a few degrees up, with the hull's heel and speed */
  private broadside(side: 'port' | 'starboard'): void {
    const root = this.boat.root, body = this.physics;
    const shots = this.guns.list.filter((g) => g.side === side).map((g) => () => {
      root.updateMatrixWorld();
      const e = (5 * Math.PI) / 180;
      const dir = new THREE.Vector3(g.dir.x * Math.cos(e), Math.sin(e), g.dir.z * Math.cos(e)).applyQuaternion(root.quaternion);
      return { muzzle: g.muzzle.clone().applyMatrix4(root.matrixWorld), dir, vel: body.velocity.clone() };
    });
    this.artillery.broadside(shots);
  }

  /** switch between the chase camera and walking the deck */
  setOnDeck(on: boolean): void {
    this.onDeck = on;
    const cam = this.cam.camera;
    // the mast and rails come within a hand's reach of the eye: a closer near plane on deck
    cam.near = on ? 0.08 : 0.3;
    cam.updateProjectionMatrix();
    this.physics.wasd = !on;
    this.physics.helm = true;
    this.input.wantLock = on;
    if (on) this.walker.spawn(this.boat.info.hullStern);
    else { this.input.unlock(); this.gunSight.exit(); this.weapons.stow(); this.spyglass.close(); this.spyglass.raise = 0; this.spyglass.update(0, this.input, false); }
  }

  /**
   * Rum: every swig adds to it, and it wears off a swig in some 22 s. Its hold grows exponentially — a swig or
   * two is a warm glow, the fourth and fifth start the world swimming, six is roaring drunk — and past a
   * whole bottle it becomes a trip: colours split into rainbows and drift, the picture swirls and breathes,
   * and the head sways hard. While it lasts the view drifts, nods and rolls in slow, uneven swells, his feet
   * wander off the line he means to walk, the picture doubles and warms (the post pass), now and then a hiccup.
   */
  private updateDrunk(dt: number, t: number): void {
    this.drunk = Math.max(0, this.drunk - dt / 22);
    const s = this.drunk;
    // (e^{0.5 s} − 1) / (e^3 − 1): 1 swig 0.03, 2 0.09, 3 0.18, 4 0.33, 5 0.58, 6 1
    const w = Math.min(1, (Math.exp(0.5 * s) - 1) / (Math.exp(3) - 1));
    const trip = THREE.MathUtils.smoothstep(s, 5.5, 7.2);
    const big = w * (1 + 1.8 * trip);
    const sway = {
      yaw: big * (0.05 * Math.sin(t * 0.53) + 0.02 * Math.sin(t * 1.37 + 2)),
      pitch: big * (0.035 * Math.sin(t * 0.71 + 1) + 0.015 * Math.sin(t * 1.9)),
      roll: big * (0.1 * Math.sin(t * 0.43) + 0.035 * Math.sin(t * 1.13 + 0.5)) + trip * 0.12 * Math.sin(t * 0.27),
    };
    const d = w;
    // throwing up: the head nods with the heaves and bends right down for the rest
    if (this.vomitAt <= this.time && this.fpv) { this.vomitAt = Infinity; this.lastVomit = this.time; this.vomit.start(); }
    if (!this.fpv) this.vomitAt = Infinity;
    const head = this.vomit.head(t);
    sway.pitch += head.pitch;
    sway.yaw += head.shake;
    sway.roll += head.shake * 0.5;
    const cam = this.cam.camera, ahead = cam.getWorldDirection(new THREE.Vector3());
    const flat = new THREE.Vector3(ahead.x, 0, ahead.z).normalize();
    const was = this.vomit.active;
    this.vomit.update(dt, cam.position.clone().addScaledVector(flat, 0.12).add(new THREE.Vector3(0, -0.1, 0)), ahead);
    // (it sobers him, a little)
    if (was && !this.vomit.active) this.drunk = Math.max(0, this.drunk - 1.5);
    this.walker.sway = sway;
    this.land.sway = sway;
    // the feet go their own way: the heading wanders while he walks
    const drift = big * 0.35 * (Math.sin(t * 0.31) + 0.6 * Math.sin(t * 0.83 + 1.7)) * dt;
    if (this.onDeck) this.walker.yaw += drift * Math.min(1, this.walker.pace * 3 + 0.2);
    else if (this.ashore) this.land.yaw += drift * Math.min(1, this.land.pace * 3 + 0.2);
    this.pipeline.post.drunk = w;
    this.pipeline.post.trip = trip;
    // …and in the music
    const actx = this.audio.context;
    if (actx) { this.music.attach(actx); this.music.setTrip(w, trip); }
    this.hicT -= dt;
    if (this.hicT <= 0) {
      this.hicT = 6 + Math.random() * 14;
      if (d > 0.45 && Math.random() < d) this.audio.hiccup();
    }
  }

  /** cut by a guard: his life runs out of the tube; at nothing, he is dead */
  private hurt(k: number): void {
    if (this.dead) return;
    this.inventory.setHealth(this.inventory.health - k);
    this.audio.hurt();
    this.hurtEl.classList.remove('on');
    void this.hurtEl.offsetWidth;
    this.hurtEl.classList.add('on');
    if (this.inventory.health <= 0.001) this.die();
  }

  /** dead: the word in crimson over a grey veil; any key starts the game again from the beginning */
  private die(): void {
    this.dead = true;
    this.weapons.stow();
    this.input.suspended = true;
    this.input.unlock();
    const el = document.createElement('div');
    el.id = 'death';
    el.innerHTML = '<h1>Umarłeś</h1><p>naciśnij dowolny klawisz, by zrestartować grę</p>';
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('on'));
    // (a moment's grace, so a key held in the fight doesn't restart at once)
    setTimeout(() => {
      const again = () => { this.inventory.reset(); resetWorldState(); location.reload(); };
      addEventListener('keydown', again, { once: true });
      el.addEventListener('pointerdown', again, { once: true });
    }, 1200);
  }

  /** ?location=skull: the ship at anchor off the Skull Island, the sailor ashore before the cave's mouth */
  /** ?location=tortuga: aboard, a kilometre off Tortuga's harbour, bow toward it, lying still */
  private startOffTortuga(): void {
    const body = this.physics;
    const x = TORTUGA_QUAY.x + 1000, z = (TORTUGA_QUAY.z0 + TORTUGA_QUAY.z1) / 2;
    // heading west (bow toward the quay): yaw −π/2; reset takes the bearing, π − yaw
    body.reset(new THREE.Vector3(x, 0, z), Math.PI + Math.PI / 2, 0);
    body.applyVisuals(this.boat, 0);
    this.boat.root.updateMatrixWorld(true);
  }

  /** ?location=tortuga-quay: the ship made fast alongside the big wharf, the sailor on its boards beside her */
  private startAtTortuga(): void {
    const body = this.physics, info = this.boat.info;
    const b = this.tortuga.berthFor({ bow: info.hullBow, stern: info.hullStern, beam: info.beam });
    body.reset(new THREE.Vector3(b.x, 0, b.z), Math.PI - b.heading, 0);
    body.setSails(false);
    body.sailsUp = 0;
    body.applyVisuals(this.boat, 0);
    this.boat.root.updateMatrixWorld(true);
    this.anchor.dropNow();
    this.tortuga.goAshoreNow({ origin: body.origin, heading: body.heading, speed: 0, bow: info.hullBow, stern: info.hullStern, beam: info.beam });
  }

  private startAtSkull(): void {
    const body = this.physics;
    // off the island's side that faces home, ~65 m out from its beach, bow toward it
    const a = Math.atan2(-SKULL_ISLAND.z, -SKULL_ISLAND.x);
    const x = SKULL_ISLAND.x + Math.cos(a) * 215, z = SKULL_ISLAND.z + Math.sin(a) * 215;
    body.reset(new THREE.Vector3(x, 0, z), Math.PI - Math.atan2(SKULL_ISLAND.x - x, SKULL_ISLAND.z - z), 0);
    body.setSails(false);
    body.sailsUp = 0;
    body.applyVisuals(this.boat, 0);
    this.boat.root.updateMatrixWorld(true);
    this.anchor.dropNow();
    if (this.landing.arriveNow(body.origin)) {
      const a = this.skull.approach;
      this.land.place(a.at.x, a.at.z, a.yaw);
    }
  }

  /**
   * Icons outside the chest: the slots bar's (drawn again when the slots change) and the purse's turning coin
   * (drawn once). A model not loaded yet is tried again a little later.
   */
  private paintIcons(dt: number): void {
    this.iconT -= dt;
    if (this.iconT > 0 || (!this.hotbarDirty && this.coinDone)) return;
    this.iconT = 0.3;
    if (!this.coinDone) {
      const strip = this.icons.strip('items/coin', 64, 36);
      if (strip) { this.status.setCoin(strip, 36); this.coinDone = true; }
    }
    if (this.hotbarDirty) {
      let all = true;
      this.hotbar.icons.forEach((c, i) => {
        const s = this.inventory.slot(i);
        if (!s) { c.getContext('2d')!.clearRect(0, 0, c.width, c.height); return; }
        if (!this.icons.draw(s.id, c, 0.55)) all = false;
      });
      this.hotbarDirty = !all;
    }
  }

  /**
   * The slots bar in first person: shown, the slot of what is in hand (or of the raised spyglass) lit; what
   * has left the slots (moved to the bag) is put away.
   */
  private markSlots(scoped: boolean): void {
    const w = this.weapons.weapon;
    if (w !== 'none' && !this.inventory.slots.some((s) => s && ITEMS[s.id].use === w)) this.weapons.holster();
    if (!this.inventory.has('spyglass')) this.spyglass.close();
    const on = scoped ? 'spyglass' : w;
    this.hotbar.setActive(this.inventory.slots.findIndex((s) => s && ITEMS[s.id].use === on));
    this.hotbar.show(true);
  }

  /** rowed ashore: first person on the island; the ship is left to the crew (no helm from the beach) */
  private goAshore(stand: THREE.Vector2, yaw: number): void {
    this.onDeck = false;
    this.gunSight.exit();
    this.spyglass.close();
    this.spyglass.raise = 0;
    const cam = this.cam.camera;
    cam.near = 0.08;
    cam.updateProjectionMatrix();
    this.physics.wasd = false;
    this.physics.helm = false;
    this.input.wantLock = true;
    this.land.place(stand.x, stand.y, yaw);
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
    const cam = this.cam.camera, sg = this.spyglass, mag = this.fpv ? sg.magnification : 1;
    const fov = (2 * Math.atan(Math.tan((55 * Math.PI) / 360) / mag) * 180) / Math.PI;
    if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const halfAngle = Math.atan(Math.tan((fov * Math.PI) / 360) * cam.aspect);
    this.terrain.update(cam.position, undefined, mag > 1.01 ? { dir, halfAngle, zoom: mag } : undefined);
    this.water.uniforms.uLodScale.value = 1 / mag;
    this.pipeline.post.scope = this.fpv ? sg.raise : 0;
    this.pipeline.post.scopeR = LENS_R;
    if (!this.fpv || sg.raise < 0.02) return;

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
          this.scopeLabel = `${f.name} · ${km}`;
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
