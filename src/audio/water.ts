/*
 * Water breaking, synthesised. A real splash has no ringing tone in it — that is what makes a synthetic one
 * sound like struck metal. It is noise with a rough, uneven body, and its signature is the bubbles: every
 * pocket of air dragged under rings for a few tens of milliseconds at a pitch that *rises* as it shrinks
 * (Minnaert resonance), which is the "blip-blop" of water. So: a dull thump as the body hits, a broadband
 * wash with a jittery envelope, a scatter of short rising bubble chirps, and droplets pattering back.
 */

export interface SplashOptions {
  /** 1 (a breath) … 4 (a dolphin re-entering after a leap) */
  size: number;
  /** −1 … 1 */
  pan: number;
  /** 0 … 1: loudness and brightness with distance */
  near: number;
  rnd?: () => number;
}

export function playSplash(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, o: SplashOptions): void {
  const rnd = o.rnd ?? Math.random;
  const k = Math.min(1, o.size / 4);
  const out = ctx.createStereoPanner();
  out.pan.value = o.pan;
  // far splashes lose their top first
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = 2500 + 9000 * o.near;
  air.connect(out).connect(dest);
  const level = o.near * (0.35 + 0.65 * k);

  const noiseAt = (t0: number, dur: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.start(t0, rnd() * (noise.duration - dur - 0.05), dur + 0.05);
    return s;
  };
  const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };

  // 1. the body hits the water: a short, dull thump
  {
    const lp = filt('lowpass', 350);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.5 * level * k, when + 0.008);
    g.gain.setTargetAtTime(0, when + 0.01, 0.025);
    noiseAt(when, 0.12).connect(lp).connect(g).connect(air);
  }

  // 2. the wash: broadband, softened at both ends, with a rough, sloshing envelope
  {
    const dur = 0.28 + 0.25 * k;
    const hp = filt('highpass', 350), lp = filt('lowpass', 4200);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    const steps = Math.ceil(dur / 0.018);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // rises in ~30 ms, then decays; every step jittered so it churns instead of hissing
      const env = Math.min(1, (t * dur) / 0.03) * Math.pow(1 - t, 1.6);
      g.gain.linearRampToValueAtTime(0.32 * level * env * (0.45 + 0.55 * rnd()), when + t * dur);
    }
    noiseAt(when, dur).connect(hp).connect(lp).connect(g).connect(air);
  }

  // 3. bubbles: short chirps whose pitch rises as they collapse
  const bubbles = Math.round(3 + 9 * k * (0.6 + 0.4 * rnd()));
  for (let b = 0; b < bubbles; b++) {
    const t0 = when + 0.02 + Math.pow(rnd(), 1.5) * (0.25 + 0.2 * k);
    const f0 = 350 + Math.pow(rnd(), 1.3) * 1100, dur = 0.02 + rnd() * 0.045;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * (1.4 + 0.8 * rnd()), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.07 * level * (0.4 + 0.6 * rnd()), t0 + 0.003);
    g.gain.setTargetAtTime(0, t0 + 0.004, dur / 3);
    osc.connect(g).connect(air);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // 4. droplets falling back: sparse, quiet, bright ticks
  const drops = Math.round(4 + 14 * k);
  for (let d = 0; d < drops; d++) {
    const t0 = when + 0.12 + rnd() * (0.35 + 0.4 * k);
    const bp = filt('bandpass', 2500 + rnd() * 4000, 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 * level * (0.3 + 0.7 * rnd()), t0);
    g.gain.setTargetAtTime(0, t0 + 0.002, 0.006);
    noiseAt(t0, 0.03).connect(bp).connect(g).connect(air);
  }
}
