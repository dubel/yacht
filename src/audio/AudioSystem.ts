/*
 * Sound (MILESTONES M16). Recorded layers (Wikimedia Commons, see public/assets/audio/CREDITS.md) plus
 * synthesised ones (WebAudio noise → filters): wind, rigging whistle, water rushing past the hull, sail
 * flogging. Everything is driven by the same state as the visuals: wind, weather, boat, time of day.
 * Browsers only allow audio after a user gesture, so the context starts on the first click / key press.
 */

import { playFootstep, playGroundStep } from './footsteps';
import { playSplash } from './water';
import { playCannon, playImpact } from './guns';
import { playCock, playFlint, playPistol, playSwoosh, playWoodHit } from './smallarms';

export interface AudioState {
  windSpeed: number;
  rain: number;
  /** boat speed through water, m/s */
  speed: number;
  /** |roll rate| + |pitch rate|, rad/s */
  motion: number;
  luffing: boolean;
  sailsUp: number;
  /** m below the surface (> 0 = lens under water) */
  submerged: number;
  night: number;
  /** 0 open water … 1 right at a beach */
  shore: number;
  waves: number;
  /** 1 aboard … 0 ashore: the hull's creaks, the rigging's whistle and the water along her side fall away */
  aboard?: number;
}

export interface ThunderEvent {
  distance: number;
  /** −1 left … 1 right */
  pan: number;
}

const LOOPS = ['ocean', 'lapping', 'rain-light', 'rain-heavy', 'crickets', 'creak-loop'] as const;
const SHOTS = ['thunder-1', 'thunder-2', 'thunder-3', 'thunder-4', 'thunder-5', 'gull-1', 'gull-2', 'gull-3', 'creak-1',
  'splash-big', 'splash-1', 'splash-2', 'splash-3',
  'gulp-1', 'gulp-2', 'swig',
  'skel-roar-1', 'skel-roar-2', 'skel-roar-3', 'skel-rasp-1', 'skel-rasp-2', 'skel-rasp-3', 'skel-rasp-5', 'skel-grunt-1', 'skel-grunt-2', 'skel-grunt-3'] as const;
/** a skeleton's voices (recorded: monster growls and a zombie's moan — see public/assets/audio/CREDITS.md) */
const SKEL: Record<'roar' | 'rasp' | 'grunt', ShotName[]> = {
  roar: ['skel-roar-1', 'skel-roar-2', 'skel-roar-3'],
  rasp: ['skel-rasp-1', 'skel-rasp-2', 'skel-rasp-3', 'skel-rasp-5'],
  grunt: ['skel-grunt-1', 'skel-grunt-2', 'skel-grunt-3'],
};
type LoopName = (typeof LOOPS)[number];
type ShotName = (typeof SHOTS)[number];

interface Loop { gain: GainNode; }

export class AudioSystem {
  muted = false;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** guns go through a compressor: a whole broadside must not clip */
  private gunBus!: DynamicsCompressorNode;
  private muffle!: BiquadFilterNode;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loops = new Map<LoopName, Loop>();
  private noise!: AudioBuffer;
  private wind!: { gain: GainNode; band: BiquadFilterNode };
  private whistle!: { gain: GainNode; band: BiquadFilterNode };
  private rush!: { gain: GainNode; low: BiquadFilterNode };
  private flog!: { gain: GainNode; lfo: OscillatorNode };
  private creakT = 4;
  private foot = 1;
  private motion = 0;

  constructor(private readonly base = 'assets/audio/') {
    const start = () => {
      this.start();
      removeEventListener('pointerdown', start);
      removeEventListener('keydown', start);
    };
    addEventListener('pointerdown', start);
    addEventListener('keydown', start);
  }

  get started(): boolean { return !!this.ctx; }
  /** the audio context, once sound has started (the music routes through it for its effects) */
  get context(): AudioContext | null { return this.ctx; }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.1);
  }

  private start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.connect(this.master).connect(ctx.destination);
    this.gunBus = ctx.createDynamicsCompressor();
    this.gunBus.threshold.value = -16;
    this.gunBus.knee.value = 6;
    this.gunBus.ratio.value = 12;
    this.gunBus.attack.value = 0.001;
    this.gunBus.release.value = 0.25;
    this.gunBus.connect(this.muffle);

    // 3 s of stereo white noise feeds every synthesised layer
    this.noise = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = this.noise.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const noiseSrc = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.start(0, Math.random() * 3);
      return s;
    };
    const chain = (...nodes: AudioNode[]) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); };

    // wind: broad band noise, brighter and louder as it blows harder
    {
      const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 0.6; band.frequency.value = 400;
      const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 2500;
      const gain = ctx.createGain(); gain.gain.value = 0;
      chain(noiseSrc(), band, low, gain, this.muffle);
      this.wind = { gain, band };
    }
    // rigging whistle: narrow resonance that only sings in strong wind
    {
      const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 18; band.frequency.value = 1100;
      const gain = ctx.createGain(); gain.gain.value = 0;
      chain(noiseSrc(), band, gain, this.muffle);
      this.whistle = { gain, band };
    }
    // water rushing past the hull
    {
      const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 700;
      const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 90;
      const gain = ctx.createGain(); gain.gain.value = 0;
      chain(noiseSrc(), high, low, gain, this.muffle);
      this.rush = { gain, low };
    }
    // sail flogging: band-passed noise chopped by a fast LFO
    {
      const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 1.2; band.frequency.value = 320;
      const chop = ctx.createGain(); chop.gain.value = 0;
      const lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 7;
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) { const x = i / 127.5 - 1; curve[i] = Math.pow(Math.max(0, x), 3); }
      shaper.curve = curve;
      lfo.connect(shaper).connect(chop.gain);
      lfo.start();
      const gain = ctx.createGain(); gain.gain.value = 0;
      chain(noiseSrc(), band, chop, gain, this.muffle);
      this.flog = { gain, lfo };
    }

    for (const name of [...LOOPS, ...SHOTS]) this.load(name);
  }

  private async load(name: LoopName | ShotName): Promise<void> {
    const ctx = this.ctx!;
    try {
      const data = await (await fetch(`${this.base}${name}.mp3`)).arrayBuffer();
      const buf = await ctx.decodeAudioData(data);
      this.buffers.set(name, buf);
      if ((LOOPS as readonly string[]).includes(name)) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        // skip the MP3 encoder padding so the crossfaded loop is seamless
        src.loopStart = 0.06;
        src.loopEnd = buf.duration - 0.06;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain).connect(this.muffle);
        src.start(0, Math.random() * (buf.duration - 1));
        this.loops.set(name as LoopName, { gain });
      }
    } catch (e) {
      console.warn('audio: could not load', name, e);
    }
  }

  private play(name: ShotName, volume: number, opts: { pan?: number; delay?: number; rate?: number; lowpass?: number } = {}): void {
    const ctx = this.ctx, buf = this.buffers.get(name);
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    let node: AudioNode = src;
    if (opts.lowpass) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lowpass;
      node.connect(f); node = f;
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = opts.pan ?? 0;
    node.connect(gain).connect(pan).connect(this.muffle);
    src.start(ctx.currentTime + (opts.delay ?? 0));
  }

  /** a footfall on deck (first-person view): pace 0 walk … 1 run, weight > 1 for a landing */
  footstep(pace: number, weight = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.foot = -this.foot; // left, right, left…
    playFootstep(ctx, this.muffle, this.noise, ctx.currentTime + 0.005, { pace, weight, pan: this.foot * 0.12, motion: Math.min(1, this.motion * 8) });
  }

  /** a footfall ashore: in sand, in grass, or wading (a slosh, deeper the more water) */
  groundStep(pace: number, ground: 'sand' | 'grass' | 'water', weight = 1, wade = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.foot = -this.foot;
    if (ground === 'water') {
      const name = (['splash-1', 'splash-2', 'splash-3'] as const)[Math.floor(Math.random() * 3)];
      const deep = Math.min(1, wade / 1.1);
      this.play(name, (0.12 + 0.25 * deep) * (0.7 + 0.5 * pace) * weight, { pan: this.foot * 0.15, rate: 1.9 - 0.7 * deep + Math.random() * 0.2, lowpass: 2500 + 3000 * (1 - deep) });
      return;
    }
    playGroundStep(ctx, this.muffle, this.noise, ctx.currentTime + 0.005, { pace, weight, pan: this.foot * 0.12, ground });
  }

  /** the brass tube slides out (open) or in, and seats with a click */
  spyglass(open: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.01, dur = 0.22;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 2, dur + 0.1);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 6;
    band.frequency.setValueAtTime(open ? 1800 : 4200, t);
    band.frequency.exponentialRampToValueAtTime(open ? 4200 : 1800, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.03);
    g.gain.linearRampToValueAtTime(0.03, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    src.connect(band).connect(g).connect(this.muffle);
    // the click of the draw tube seating
    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    click.start(t + dur, Math.random() * 2, 0.03);
    const cb = ctx.createBiquadFilter();
    cb.type = 'bandpass';
    cb.frequency.value = 3200;
    cb.Q.value = 3;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.22, t + dur);
    cg.gain.setTargetAtTime(0, t + dur + 0.002, 0.006);
    click.connect(cb).connect(cg).connect(this.muffle);
  }

  /** a gull calls from a real bird: pan −1…1 (listener's left…right), distance in m */
  gull(pan: number, distance: number): void {
    if (!this.ctx) return;
    const g = (['gull-1', 'gull-2', 'gull-3'] as const)[Math.floor(Math.random() * 3)];
    const near = Math.min(1, 30 / (distance + 8));
    this.play(g, 0.15 + 0.55 * near, { pan: pan * 0.8, rate: 0.9 + Math.random() * 0.25, lowpass: 2500 + 12000 * near });
  }

  /**
   * Water broken by a leaping dolphin; `size` 1 … 4. Recorded splashes: a body going in for the big ones,
   * small splashes played slower (a bigger body of water) for the rest; the synthesised splash only while
   * the recordings are still loading.
   */
  splash(pan: number, distance: number, size: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const near = Math.min(1, 25 / (distance + 6));
    if (near < 0.05) return;
    const big = size >= 2.5;
    const name = big ? 'splash-big' : (['splash-1', 'splash-2', 'splash-3'] as const)[Math.floor(Math.random() * 3)];
    if (!this.buffers.has(name)) { playSplash(ctx, this.muffle, this.noise, ctx.currentTime + 0.01, { size, pan: pan * 0.8, near }); return; }
    const rate = big ? 0.9 + Math.random() * 0.2 : 0.7 + Math.random() * 0.15;
    this.play(name, near * (big ? 0.9 : 0.35 + 0.2 * size), { pan: pan * 0.8, rate, lowpass: 2500 + 14000 * near });
  }

  /** one of our guns goes off (pan / distance from the listener) */
  cannon(pan: number, distance: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    playCannon(ctx, this.gunBus, this.noise, ctx.currentTime + 0.005, { pan: pan * 0.7, near: Math.min(1, 14 / (distance + 4)) });
  }

  /** a ball lands: heard after sound has travelled `distance` m */
  impact(kind: 'land' | 'water', pan: number, distance: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const near = Math.min(1, 40 / (distance + 15));
    if (near < 0.04) return;
    const delay = Math.min(distance / 343, 6);
    if (kind === 'water' && this.buffers.has('splash-big')) {
      // a cannonball: the recorded plunge, slowed — heavier and deeper than a dolphin
      this.play('splash-big', near, { pan: pan * 0.8, delay, rate: 0.7 + Math.random() * 0.1, lowpass: 1800 + 9000 * near });
      return;
    }
    playImpact(ctx, this.gunBus, this.noise, ctx.currentTime + delay, kind, { pan: pan * 0.8, near });
  }

  // ---- small arms (the sailor's own: close by, in the middle) ----
  /** the flint strikes; the shot itself follows `hang` s later */
  pistol(hang: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.003;
    playFlint(ctx, this.gunBus, this.noise, t, { pan: 0.15, near: 0.9 });
    playPistol(ctx, this.gunBus, this.noise, t + hang, { pan: 0.1, near: 1 });
  }

  cock(): void {
    if (this.ctx) playCock(this.ctx, this.muffle, this.noise, this.ctx.currentTime + 0.003, { pan: 0.2, near: 0.8 });
  }

  swoosh(pan: number): void {
    if (this.ctx) playSwoosh(this.ctx, this.muffle, this.noise, this.ctx.currentTime + 0.003, { pan, near: 1 });
  }

  /** a pistol ball lands: in wood (`skip` = ricochet), in the water, on land */
  bullet(kind: 'wood' | 'ricochet' | 'water' | 'land', pan: number, distance: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const near = Math.min(1, 12 / (distance + 4));
    if (near < 0.03) return;
    const when = ctx.currentTime + Math.min(distance / 343, 3);
    if (kind === 'wood' || kind === 'ricochet') { playWoodHit(ctx, this.muffle, this.noise, when, kind === 'ricochet', { pan: pan * 0.8, near }); return; }
    if (kind === 'water') {
      const name = (['splash-1', 'splash-2', 'splash-3'] as const)[Math.floor(Math.random() * 3)];
      this.play(name, 0.45 * near, { pan: pan * 0.8, delay: when - ctx.currentTime, rate: 1.15 + Math.random() * 0.25, lowpass: 2000 + 12000 * near });
      return;
    }
    playImpact(ctx, this.muffle, this.noise, when, 'land', { pan: pan * 0.8, near: near * 0.5 });
  }

  // ---- seamanship: kedging off a shoal, the leadsman's warnings ----
  /** an oar stroke of the boat taking the kedge out */
  oar(pan: number, distance: number): void {
    const name = (['splash-1', 'splash-2', 'splash-3'] as const)[Math.floor(Math.random() * 3)];
    const near = Math.min(1, 15 / (distance + 5));
    this.play(name, 0.35 * near, { pan: pan * 0.8, rate: 1.3 + Math.random() * 0.3, lowpass: 1500 + 6000 * near });
  }

  /** the inventory: a thing picked up (a light knock) or put down (a firmer one), the parchment unrolled */
  tap(firm: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.003;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 2, 0.08);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = firm ? 520 : 900; bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(firm ? 0.5 : 0.3, t); g.gain.setTargetAtTime(0, t + 0.004, firm ? 0.03 : 0.018);
    src.connect(bp).connect(g).connect(this.muffle);
  }

  paper(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.003, dur = 0.32;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 2, dur + 0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2200;
    // crackle: the sheet's fibres, in bursts
    const chop = ctx.createGain();
    for (let k = 0; k * 0.012 < dur; k++) chop.gain.setValueAtTime(Math.random() < 0.5 ? 1 : 0.2, t + k * 0.012);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.05); g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(chop).connect(hp).connect(g).connect(this.muffle);
  }

  // ---- the Skull Island: bones struck and falling apart, the dead rising, the gold, the sailor hurt ----
  /** a short burst of noise through a band, shaped (the pieces the island's sounds are made of) */
  private knock(t: number, f: number, q: number, level: number, decay: number, pan: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 2, decay * 4 + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + 0.002); g.gain.setTargetAtTime(0, t + 0.003, decay);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    src.connect(bp).connect(g).connect(p).connect(this.muffle);
  }

  /** a ball or a blade into dry bone: a hard, hollow crack */
  boneHit(pan: number, distance: number): void {
    if (!this.ctx) return;
    const near = Math.min(1, 6 / (distance + 2)), t = this.ctx.currentTime + 0.004;
    this.knock(t, 1800 + Math.random() * 600, 3, 0.9 * near, 0.018, pan * 0.7);
    this.knock(t + 0.004, 420, 6, 0.6 * near, 0.05, pan * 0.7);
  }

  /** a skeleton falling apart: a clatter of bones onto stone */
  collapse(pan: number, distance: number): void {
    if (!this.ctx) return;
    const near = Math.min(1, 8 / (distance + 2)), t0 = this.ctx.currentTime + 0.01;
    for (let k = 0; k < 18; k++) {
      const t = t0 + 0.02 + Math.pow(Math.random(), 1.6) * 0.9;
      this.knock(t, 900 + Math.random() * 2600, 4 + Math.random() * 6, (0.25 + Math.random() * 0.4) * near, 0.012 + Math.random() * 0.02, pan * 0.6 + (Math.random() - 0.5) * 0.3);
    }
  }

  /** the dead rising: a dry grinding rattle from the floor */
  rise(pan: number, distance: number): void {
    if (!this.ctx) return;
    const near = Math.min(1, 10 / (distance + 3)), t0 = this.ctx.currentTime + 0.01;
    for (let k = 0; k < 26; k++) this.knock(t0 + (k / 26) * 1.1 + Math.random() * 0.03, 300 + Math.random() * 900, 3, 0.3 * near * (0.5 + k / 26), 0.02, pan * 0.6);
  }

  /** gold: a heap of coins poured and chinking */
  coins(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    for (let k = 0; k < 42; k++) {
      const t = t0 + Math.pow(Math.random(), 1.4) * 1.6;
      // each coin: a couple of bright, slightly inharmonic partials, dying quickly
      const f = 2600 + Math.random() * 2400;
      for (const [m, lv] of [[1, 0.1], [2.76, 0.05], [5.4, 0.025]] as const) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * m;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lv, t + 0.002); g.gain.setTargetAtTime(0, t + 0.003, 0.05 + Math.random() * 0.06);
        const p = ctx.createStereoPanner(); p.pan.value = (Math.random() - 0.5) * 0.8;
        o.connect(g).connect(p).connect(this.muffle);
        o.start(t); o.stop(t + 0.5);
      }
      this.knock(t, 5000, 1.5, 0.05, 0.01, 0);
    }
  }

  /**
   * A skeleton's voice: a roar as it rises, a rasping breath as it runs at him, a grunt with each cut — one
   * of a few recordings, played a little slower and deeper than life and a little different each time,
   * placed and dulled by distance like any sound. `echo`: in the cave, it comes back off the rock.
   */
  growl(kind: 'roar' | 'rasp' | 'grunt', pan: number, distance: number, echo: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const near = Math.min(1, 7 / (distance + 2.5));
    if (near < 0.04) return;
    const list = SKEL[kind], name = list[Math.floor(Math.random() * list.length)];
    const buf = this.buffers.get(name);
    if (!buf) return;
    const t = ctx.currentTime + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (kind === 'grunt' ? 0.92 : 0.8) + Math.random() * 0.14;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1500 + 9000 * near;
    const g = ctx.createGain();
    g.gain.value = (kind === 'grunt' ? 0.85 : 1) * near;
    const pn = ctx.createStereoPanner();
    pn.pan.value = pan * 0.8;
    src.connect(lp).connect(g).connect(pn).connect(this.muffle);
    if (echo) {
      // the cave: a couple of quick echoes off the rock, darker each time
      const d = ctx.createDelay(1), fb = ctx.createGain(), dl = ctx.createBiquadFilter(), wet = ctx.createGain();
      d.delayTime.value = 0.11 + Math.random() * 0.05; fb.gain.value = 0.35; dl.type = 'lowpass'; dl.frequency.value = 1600; wet.gain.value = 0.55;
      pn.connect(d).connect(dl).connect(fb).connect(d);
      dl.connect(wet).connect(this.muffle);
    }
    src.start(t);
  }

  /** the rum: the bottle tipped up (the gurgle of it running into his mouth), a gulp, and — well gone — a hiccup */
  swig(): void {
    this.play('swig', 0.55, { rate: 0.9 + Math.random() * 0.1, lowpass: 5000 });
  }

  gulp(): void {
    const name = Math.random() < 0.6 ? 'gulp-1' : 'gulp-2';
    this.play(name, 0.75, { rate: 0.85 + Math.random() * 0.2 });
  }

  hiccup(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // a clipped, glottal "hic": a burst of voice that jumps up in pitch and stops dead
    const t = ctx.currentTime + 0.01, len = 0.13;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(320, t + len);
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.start(t, Math.random(), len + 0.05);
    const mix = ctx.createGain();
    const ng = ctx.createGain(); ng.gain.value = 0.35;
    o.connect(mix); src.connect(ng).connect(mix);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 0.012); g.gain.setValueAtTime(0.3, t + len - 0.03); g.gain.linearRampToValueAtTime(0, t + len);
    for (const [f, q] of [[700, 5], [1200, 6]] as const) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      mix.connect(bp).connect(g);
    }
    g.connect(this.muffle);
    o.start(t); o.stop(t + len + 0.05);
  }

  /**
   * Throwing up. `heave`: a dry retch — the throat closing on a strangled, falling "hurk" (a buzz through the
   * vowel of it) over a thump from the gut. `gush`: the real thing — a long, rough, gargling bellow while the
   * stuff pours out (a gurgle of low noise, the splash of it). `spit`: a last "ptuh" to clear the mouth.
   */
  retch(kind: 'heave' | 'gush' | 'spit'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(this.muffle);
    const env = (node: AudioNode, at: number, peak: number, attack: number, hold: number, release: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + attack);
      g.gain.setValueAtTime(peak, at + attack + hold); g.gain.linearRampToValueAtTime(0, at + attack + hold + release);
      node.connect(g);
      return g;
    };
    const noise = (at: number, len: number) => { const n = ctx.createBufferSource(); n.buffer = this.noise; n.start(at, Math.random() * 2, len + 0.1); return n; };
    const band = (f: number, q: number) => { const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q; return b; };
    if (kind === 'spit') {
      // the lips parting, and a spray
      this.knock(t, 900, 2, 0.35, 0.012, 0.05);
      env(noise(t + 0.02, 0.12).connect(band(3200, 1.2)), t + 0.02, 0.25, 0.005, 0.03, 0.07).connect(out);
      return;
    }
    const len = kind === 'heave' ? 0.4 : 1.15;
    // the voice: a rough buzz, its pitch falling, chopped by the throat's spasms
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = kind === 'heave' ? 125 : 95;
    o.frequency.setValueAtTime(f0 * 1.2, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + len);
    const chop = ctx.createGain();
    for (let k = 0, tt = t; tt < t + len; k++, tt += 0.028 + Math.random() * 0.025) chop.gain.setValueAtTime(Math.random() < 0.65 ? 1 : 0.2, tt);
    o.connect(chop);
    const throat = noise(t, len);
    const tg = ctx.createGain(); tg.gain.value = 0.5;
    throat.connect(tg).connect(chop);
    // the vowel of it: "uh" closing ("hurk") or wide open ("bleurgh")
    const vowel = ctx.createGain();
    for (const [f, q, g] of (kind === 'heave' ? [[480, 6, 1], [1150, 7, 0.6], [2400, 8, 0.3]] : [[640, 5, 1], [1250, 6, 0.7], [2500, 7, 0.35]]) as [number, number, number][]) {
      const b = band(f, q), gg = ctx.createGain(); gg.gain.value = g;
      if (kind === 'heave') b.frequency.linearRampToValueAtTime(f * 0.75, t + len);
      chop.connect(b).connect(gg).connect(vowel);
    }
    env(vowel, t, kind === 'heave' ? 0.55 : 0.5, 0.03, len * 0.55, len * 0.4).connect(out);
    o.start(t); o.stop(t + len + 0.1);
    // the gut: a low thump at the start of each
    this.knock(t, 120, 1.5, 0.9, 0.08, 0);
    if (kind === 'gush') {
      // the stuff pouring: a low gurgle, and the splash of it
      const g = noise(t + 0.08, len).connect(ctx.createBiquadFilter());
      (g as BiquadFilterNode).type = 'lowpass'; (g as BiquadFilterNode).frequency.value = 850;
      const am = ctx.createGain();
      for (let k = 0, tt = t; tt < t + len; k++, tt += 0.06 + Math.random() * 0.05) am.gain.setValueAtTime(0.4 + Math.random() * 0.6, tt);
      g.connect(am);
      env(am, t + 0.08, 0.7, 0.05, len * 0.6, len * 0.35).connect(out);
      this.play((['splash-1', 'splash-2', 'splash-3'] as const)[Math.floor(Math.random() * 3)], 0.5, { rate: 0.55, lowpass: 1400, delay: 0.25 });
    }
  }

  /** a blob of it landing: a wet slap */
  splat(pan: number, distance: number, big: boolean): void {
    const near = Math.min(1, 3 / (distance + 1));
    this.play((['splash-1', 'splash-2', 'splash-3'] as const)[Math.floor(Math.random() * 3)], (big ? 0.35 : 0.18) * near, { pan: pan * 0.6, rate: 0.6 + Math.random() * 0.2, lowpass: 1100 + 1200 * near });
  }

  /** the sailor cut: a dull blow, and his breath knocked out */
  hurt(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.004;
    this.knock(t, 160, 1.5, 1.2, 0.06, 0);
    this.knock(t + 0.01, 700, 2, 0.4, 0.04, 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t + 0.05, Math.random() * 2, 0.4);
    const lp = ctx.createBiquadFilter(); lp.type = 'bandpass'; lp.frequency.value = 900; lp.Q.value = 1.2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t + 0.05); g.gain.linearRampToValueAtTime(0.18, t + 0.1); g.gain.linearRampToValueAtTime(0, t + 0.4);
    src.connect(lp).connect(g).connect(this.muffle);
  }

  /** the kedge anchor let go */
  anchorDrop(pan: number, distance: number): void {
    const near = Math.min(1, 25 / (distance + 6));
    this.play('splash-big', 0.8 * near, { pan: pan * 0.8, rate: 1.15, lowpass: 2000 + 9000 * near });
  }

  /** the anchor let go: the hemp cable running out through the hawse — a rushing rumble that slows as it lies down */
  cableOut(pan: number, distance: number, seconds = 2.4): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const near = Math.min(1, 20 / (distance + 5));
    const t = ctx.currentTime + 0.01, end = t + seconds + 0.4;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true; src.start(t, Math.random() * 2); src.stop(end);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(460, t); bp.frequency.linearRampToValueAtTime(230, t + seconds);
    // the rope's lay rubbing over the hawse lip: a flutter that slows with the cable
    const am = ctx.createGain(); am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(24, t); lfo.frequency.linearRampToValueAtTime(6, t + seconds);
    const lg = ctx.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain); lfo.start(t); lfo.stop(end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.55 * near, t + 0.08);
    g.gain.setTargetAtTime(0, t + seconds * 0.6, seconds * 0.22);
    const pn = ctx.createStereoPanner(); pn.pan.value = pan * 0.8;
    src.connect(bp).connect(am).connect(g).connect(pn).connect(this.muffle);
  }

  /** one click of the capstan's pawl, and now and then the groan of the cable */
  capstan(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.003;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 2, 0.06);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1300 + Math.random() * 300; bp.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t); g.gain.setTargetAtTime(0, t + 0.002, 0.012);
    src.connect(bp).connect(g).connect(this.muffle);
    if (Math.random() < 0.3) this.play('creak-1', 0.35, { rate: 0.55 + Math.random() * 0.2, pan: (Math.random() - 0.5) * 0.6 });
  }

  /** the hull grinding over sand and coral: `level` 0 … 1, held until set again */
  scrape(level: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.scrapeGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise; src.loop = true; src.start();
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
      const am = ctx.createGain(); am.gain.value = 0.6;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 7; const lg = ctx.createGain(); lg.gain.value = 0.4;
      lfo.connect(lg).connect(am.gain); lfo.start();
      this.scrapeGain = ctx.createGain(); this.scrapeGain.gain.value = 0;
      src.connect(lp).connect(am).connect(this.scrapeGain).connect(this.muffle);
    }
    this.scrapeGain.gain.setTargetAtTime(0.35 * level, ctx.currentTime, 0.2);
  }
  private scrapeGain: GainNode | null = null;

  /** the ship's bell: `strikes` quick strokes (the leadsman calls shoal water) */
  bell(strikes: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let k = 0; k < strikes; k++) {
      const t = ctx.currentTime + 0.01 + k * 0.32;
      // a bronze bell: inharmonic partials, the higher ones dying first
      for (const [ratio, amp, decay] of [[1, 0.1, 1.6], [2.76, 0.06, 0.9], [5.4, 0.035, 0.45], [8.93, 0.02, 0.25]] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = 720 * ratio;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.003); g.gain.setTargetAtTime(0, t + 0.004, decay / 3);
        o.connect(g).connect(this.muffle);
        o.start(t); o.stop(t + decay * 2);
      }
    }
  }

  /** a dolphin's blow: a short, breathy puff */
  blow(pan: number, distance: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const near = Math.min(1, 20 / (distance + 5));
    if (near < 0.06) return;
    const t = ctx.currentTime + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 2, 0.5);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(900, t);
    band.frequency.linearRampToValueAtTime(1500, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22 * near, t + 0.03);
    g.gain.setTargetAtTime(0, t + 0.12, 0.07);
    const p = ctx.createStereoPanner();
    p.pan.value = pan * 0.8;
    src.connect(band).connect(g).connect(p).connect(this.muffle);
  }

  /** a lightning strike: the thunder arrives at the speed of sound, duller from far away */
  thunder(e: ThunderEvent): void {
    if (!this.ctx) return;
    const near = Math.min(1, 900 / e.distance);
    const pick = e.distance < 1200 ? ['thunder-4', 'thunder-5'] : ['thunder-1', 'thunder-2', 'thunder-3'];
    const name = pick[Math.floor(Math.random() * pick.length)] as ShotName;
    this.play(name, 0.25 + 0.75 * near, { pan: e.pan * 0.7, delay: Math.min(e.distance / 343, 14), lowpass: 350 + 7000 * near * near, rate: 0.9 + 0.2 * Math.random() });
  }

  update(dt: number, s: AudioState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.motion = s.motion;
    const aboard = s.aboard ?? 1;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.3) => p.setTargetAtTime(v, t, tc);
    const loop = (n: LoopName, v: number) => { const l = this.loops.get(n); if (l) set(l.gain.gain, v, 0.6); };

    const under = s.submerged > 0.05;
    set(this.muffle.frequency, under ? 420 : 20000, 0.15);
    const air = under ? 0.25 : 1;

    const w = s.windSpeed;
    set(this.wind.gain.gain, air * 0.05 * Math.pow(w / 8, 2.2), 0.25);
    set(this.wind.band.frequency, 260 + w * 38, 0.4);
    set(this.whistle.gain.gain, aboard * air * 0.018 * Math.max(0, (w - 9) / 8) * (0.6 + 0.4 * Math.sin(t * 0.7)), 0.3);
    set(this.whistle.band.frequency, 850 + w * 45 + 120 * Math.sin(t * 0.37), 0.5);
    set(this.rush.gain.gain, 0.09 * Math.pow(Math.min(s.speed, 7) / 4, 1.6), 0.3);
    set(this.rush.low.frequency, 450 + s.speed * 160, 0.3);
    set(this.flog.gain.gain, s.luffing ? air * 0.12 * s.sailsUp * Math.min(1, w / 7) : 0, 0.15);
    set(this.flog.lfo.frequency, 5 + w * 0.35, 0.5);

    loop('ocean', 0.12 + 0.55 * s.shore + 0.12 * Math.max(0, s.waves - 1));
    loop('lapping', (0.35 * (1 - Math.min(1, s.speed / 4)) + 0.1) * (0.3 + 0.7 * aboard));
    loop('rain-light', air * Math.min(1, s.rain * 2) * (1 - s.rain) * 0.9 + air * 0.25 * s.rain);
    loop('rain-heavy', air * Math.max(0, s.rain - 0.3) * 1.1);
    loop('crickets', air * 0.5 * s.night * s.shore * (1 - s.rain));
    loop('creak-loop', aboard * (0.05 + Math.min(0.5, s.motion * 1.6) * (0.5 + 0.2 * s.waves)));

    // occasional one-shots
    this.creakT -= dt;
    if (this.creakT <= 0) {
      this.creakT = 2 + Math.random() * 6;
      if (s.motion > 0.04 && aboard > 0.5) this.play('creak-1', Math.min(0.6, 0.2 + s.motion * 2), { rate: 0.7 + Math.random() * 0.4, pan: Math.random() - 0.5 });
    }
  }
}
