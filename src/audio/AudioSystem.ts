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
  'splash-big', 'splash-1', 'splash-2', 'splash-3'] as const;
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
