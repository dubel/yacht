/*
 * Small arms, synthesised. A flintlock is "click — pssh — BANG": the cock falls and the flint scrapes the
 * frizzen (a bright click and a rasp), the priming flashes in the pan (a short hiss), and ~0.1 s later the
 * charge goes off — a sharp crack over a short, boomy report, much lighter than a cannon. A ball striking
 * wood is a dull knock with a hollow ring from the planks; skipping off, it adds the falling whine of a
 * ricochet. A blade cutting the air: a swept band of noise. Reloaded: the cock drawn back, two metallic clicks.
 */

interface Opts { pan: number; near: number; rnd?: () => number }

const noiseAt = (ctx: BaseAudioContext, noise: AudioBuffer, t0: number, dur: number, rnd: () => number) => {
  const s = ctx.createBufferSource();
  s.buffer = noise;
  s.start(t0, rnd() * (noise.duration - dur - 0.05), dur + 0.05);
  return s;
};
const filter = (ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = 0.7) => {
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f; b.Q.value = q;
  return b;
};
const env = (ctx: BaseAudioContext, t0: number, peak: number, attack: number, decay: number) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.setTargetAtTime(0, t0 + attack, decay / 4);
  return g;
};
const out = (ctx: BaseAudioContext, dest: AudioNode, o: Opts, bright: number) => {
  const p = ctx.createStereoPanner();
  p.pan.value = o.pan;
  const lp = filter(ctx, 'lowpass', bright * (0.25 + 0.75 * o.near));
  lp.connect(p).connect(dest);
  return lp;
};

/** cock falls, flint on frizzen, priming flashes in the pan */
export function playFlint(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, o: Opts): void {
  const rnd = o.rnd ?? Math.random, a = out(ctx, dest, o, 14000);
  noiseAt(ctx, noise, when, 0.02, rnd).connect(filter(ctx, 'bandpass', 3800, 3)).connect(env(ctx, when, 0.35 * o.near, 0.001, 0.012)).connect(a);
  noiseAt(ctx, noise, when + 0.006, 0.03, rnd).connect(filter(ctx, 'highpass', 4000)).connect(env(ctx, when + 0.006, 0.12 * o.near, 0.002, 0.02)).connect(a);
  const t = when + 0.02;
  noiseAt(ctx, noise, t, 0.12, rnd).connect(filter(ctx, 'bandpass', 2200, 0.8)).connect(env(ctx, t, 0.18 * o.near, 0.012, 0.07)).connect(a);
}

/** the charge going off */
export function playPistol(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, o: Opts): void {
  const rnd = o.rnd ?? Math.random, a = out(ctx, dest, o, 15000), L = o.near;
  noiseAt(ctx, noise, when, 0.05, rnd).connect(filter(ctx, 'highpass', 1400)).connect(env(ctx, when, 0.42 * L, 0.0008, 0.025)).connect(a);
  noiseAt(ctx, noise, when, 0.3, rnd).connect(filter(ctx, 'lowpass', 1100)).connect(env(ctx, when, 0.5 * L, 0.002, 0.13)).connect(a);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(120, when);
  osc.frequency.exponentialRampToValueAtTime(55, when + 0.18);
  osc.connect(env(ctx, when, 0.28 * L, 0.002, 0.16)).connect(a);
  osc.start(when); osc.stop(when + 0.5);
  // off the water and the sails: a short roll
  const tail = noiseAt(ctx, noise, when, 1.3, rnd);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(0.07 * L, when + 0.06); g.gain.setTargetAtTime(0, when + 0.1, 0.28);
  tail.connect(filter(ctx, 'lowpass', 450)).connect(g).connect(a);
}

/** a ball striking wood; `skip`: it ricochets off, whining */
export function playWoodHit(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, skip: boolean, o: Opts): void {
  const rnd = o.rnd ?? Math.random, a = out(ctx, dest, o, 9000), L = o.near;
  noiseAt(ctx, noise, when, 0.05, rnd).connect(filter(ctx, 'bandpass', 900 + rnd() * 400, 1.6)).connect(env(ctx, when, 0.5 * L, 0.001, 0.035)).connect(a);
  // the planks ring, hollow
  for (const [f, q, pk, d] of [[210, 9, 0.6, 0.14], [470, 11, 0.3, 0.09]] as const) {
    noiseAt(ctx, noise, when, 0.03, rnd).connect(filter(ctx, 'bandpass', f * (0.9 + 0.2 * rnd()), q)).connect(env(ctx, when, pk * L, 0.002, d)).connect(a);
  }
  // splinters
  noiseAt(ctx, noise, when + 0.004, 0.06, rnd).connect(filter(ctx, 'highpass', 3000)).connect(env(ctx, when + 0.004, 0.08 * L, 0.002, 0.04)).connect(a);
  if (!skip) return;
  const t = when + 0.01, f0 = 2600 + rnd() * 900;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + 0.42);
  const vib = ctx.createOscillator(), vg = ctx.createGain();
  vib.frequency.value = 38; vg.gain.value = 60;
  vib.connect(vg).connect(osc.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.07 * L, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.45);
  osc.connect(g).connect(a);
  osc.start(t); osc.stop(t + 0.5); vib.start(t); vib.stop(t + 0.5);
}

/** a blade through the air */
export function playSwoosh(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, o: Opts): void {
  const rnd = o.rnd ?? Math.random, a = out(ctx, dest, o, 12000), dur = 0.26;
  const bp = filter(ctx, 'bandpass', 500, 2.2);
  bp.frequency.setValueAtTime(500, when);
  bp.frequency.exponentialRampToValueAtTime(2600, when + dur * 0.45);
  bp.frequency.exponentialRampToValueAtTime(800, when + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(0.28 * o.near, when + dur * 0.45);
  g.gain.linearRampToValueAtTime(0, when + dur);
  noiseAt(ctx, noise, when, dur, rnd).connect(bp).connect(g).connect(a);
}

/** loaded again: the cock drawn back to full, two clicks */
export function playCock(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, o: Opts): void {
  const rnd = o.rnd ?? Math.random, a = out(ctx, dest, o, 14000);
  for (const dt of [0, 0.09]) noiseAt(ctx, noise, when + dt, 0.02, rnd).connect(filter(ctx, 'bandpass', 4200, 4)).connect(env(ctx, when + dt, 0.16 * o.near, 0.001, 0.01)).connect(a);
}
