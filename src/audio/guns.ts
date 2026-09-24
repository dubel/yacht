import { playSplash } from './water';

/*
 * Cannon, synthesised. A gun going off is a sharp crack (the muzzle blast: bright noise, a few ms), the
 * body of the report (lower noise, a few hundred ms), a deep thump you feel more than hear (a falling sine
 * around 50 Hz), and a long rolling tail — the sound coming back off the water and the islands — that
 * swells a little and dies over a couple of seconds. The ball landing: on an island a dull, earthy thud with
 * clods pattering down; in the sea a deep "whump" under a big splash.
 */

export interface GunSoundOptions {
  pan: number;
  /** 0 … 1 loudness / brightness with distance */
  near: number;
  rnd?: () => number;
}

function noiseAt(ctx: BaseAudioContext, noise: AudioBuffer, t0: number, dur: number, rnd: () => number): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = noise;
  s.start(t0, rnd() * (noise.duration - dur - 0.05), dur + 0.05);
  return s;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

function envelope(ctx: BaseAudioContext, t0: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.setTargetAtTime(0, t0 + attack, decay / 4);
  return g;
}

export function playCannon(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, o: GunSoundOptions): void {
  const rnd = o.rnd ?? Math.random;
  const out = ctx.createStereoPanner();
  out.pan.value = o.pan;
  const air = filter(ctx, 'lowpass', 1800 + 10000 * o.near);
  air.connect(out).connect(dest);
  const L = o.near * (0.85 + 0.3 * rnd());

  // crack: the blast leaving the muzzle
  noiseAt(ctx, noise, when, 0.1, rnd).connect(filter(ctx, 'highpass', 900)).connect(envelope(ctx, when, 0.32 * L, 0.001, 0.05)).connect(air);
  // report: the body of the bang
  noiseAt(ctx, noise, when, 0.8, rnd).connect(filter(ctx, 'lowpass', 520)).connect(envelope(ctx, when, 0.55 * L, 0.004, 0.45)).connect(air);
  // thump: a deep falling tone
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(62 * (0.9 + 0.2 * rnd()), when);
  osc.frequency.exponentialRampToValueAtTime(32, when + 0.35);
  osc.connect(envelope(ctx, when, 0.45 * L, 0.004, 0.4)).connect(air);
  osc.start(when);
  osc.stop(when + 0.9);
  // the roll: echoes off the water and the land, swelling then fading
  const tail = noiseAt(ctx, noise, when, 2.9, rnd);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0, when);
  tg.gain.linearRampToValueAtTime(0.16 * L, when + 0.12);
  tg.gain.linearRampToValueAtTime(0.2 * L, when + 0.45);
  tg.gain.setTargetAtTime(0, when + 0.5, 0.55);
  tail.connect(filter(ctx, 'lowpass', 280)).connect(tg).connect(air);
}

export function playImpact(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, kind: 'land' | 'water', o: GunSoundOptions): void {
  const rnd = o.rnd ?? Math.random;
  if (kind === 'water') {
    // the ball punching in: a deep whump, then a big splash
    const air = filter(ctx, 'lowpass', 1500 + 6000 * o.near);
    const out = ctx.createStereoPanner();
    out.pan.value = o.pan;
    air.connect(out).connect(dest);
    noiseAt(ctx, noise, when, 0.3, rnd).connect(filter(ctx, 'lowpass', 220)).connect(envelope(ctx, when, 0.5 * o.near, 0.006, 0.18)).connect(air);
    playSplash(ctx, dest, noise, when + 0.015, { size: 4, pan: o.pan, near: o.near, rnd });
    return;
  }
  const out = ctx.createStereoPanner();
  out.pan.value = o.pan;
  const air = filter(ctx, 'lowpass', 900 + 4000 * o.near);
  air.connect(out).connect(dest);
  // earth taking the blow: a dull thud
  noiseAt(ctx, noise, when, 0.4, rnd).connect(filter(ctx, 'lowpass', 240)).connect(envelope(ctx, when, 0.75 * o.near, 0.004, 0.22)).connect(air);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(75, when);
  osc.frequency.exponentialRampToValueAtTime(40, when + 0.2);
  osc.connect(envelope(ctx, when, 0.35 * o.near, 0.003, 0.2)).connect(air);
  osc.start(when);
  osc.stop(when + 0.5);
  // clods and sand raining back down
  for (let k = 0; k < 10; k++) {
    const t0 = when + 0.08 + rnd() * 0.6;
    noiseAt(ctx, noise, t0, 0.04, rnd).connect(filter(ctx, 'bandpass', 700 + rnd() * 1800, 1.5))
      .connect(envelope(ctx, t0, 0.06 * o.near * (0.3 + 0.7 * rnd()), 0.002, 0.03)).connect(air);
  }
}
