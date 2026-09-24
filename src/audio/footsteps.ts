/*
 * Boots on a wooden deck, synthesised (no samples): each footfall is a hard heel knock (band-passed noise,
 * ~20 ms) over the dull boom of the hollow deck beneath (noise ringing two low resonances), then the
 * softer roll onto the toe ~70 ms later; now and then a plank creaks (noise through a narrow resonance
 * that slides in pitch). Running is louder with a sole scuff; a jump down from the raised deck lands
 * heavier. Pitch, level and timing vary a little per step and left/right feet sit slightly apart in the
 * stereo image, so it never sounds like a looped sample.
 */

export interface StepOptions {
  /** 0 walking … 1 running */
  pace: number;
  /** 1 = ordinary step; > 1 heavier (landing after a drop) */
  weight: number;
  /** −1 … 1 stereo position (left / right foot) */
  pan: number;
  /** 0 … 1 how much the hull is working (more creaks in a seaway) */
  motion: number;
  /** random source (tests pass a seeded one) */
  rnd?: () => number;
}

/** schedule one footfall at `when` (context time) into `dest`; `noise` is any looping white-noise buffer */
export function playFootstep(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, when: number, o: StepOptions): void {
  const rnd = o.rnd ?? Math.random;
  const vary = (k: number) => 1 + (rnd() * 2 - 1) * k;
  const level = 0.7 * (0.55 + 0.45 * o.pace) * Math.min(o.weight, 2.2) * vary(0.15);
  const tune = vary(0.08);

  // leather on oak is dull: nothing much above a few kHz (the noise bands would otherwise hiss)
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 3200 + 1800 * o.pace;
  tone.Q.value = 0.5;
  const out = ctx.createStereoPanner();
  out.pan.value = o.pan;
  tone.connect(out).connect(dest);

  const burst = (t0: number, dur: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.start(t0, rnd() * (noise.duration - dur - 0.05), dur + 0.05);
    return s;
  };
  const env = (node: AudioNode, t0: number, peak: number, attack: number, decay: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.setTargetAtTime(0, t0 + attack, decay / 4);
    node.connect(g);
    return g;
  };
  const filter = (type: BiquadFilterType, f: number, q: number) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };

  // one contact: the knock of the sole and the boom of the planks it sets ringing
  const contact = (t0: number, amp: number, bright: number) => {
    const knock = filter('bandpass', (1300 + 700 * bright) * tune, 1.1);
    burst(t0, 0.03).connect(knock);
    env(knock, t0, amp * 1.4, 0.002, 0.022).connect(tone);
    // hollow deck: two resonances, lower and longer for a heavier landing
    for (const [f, q, a, d] of [[150, 7, 1.6, 0.09], [410, 9, 0.9, 0.06]] as const) {
      const r = filter('bandpass', (f / Math.sqrt(o.weight)) * tune, q);
      burst(t0, 0.02).connect(r);
      env(r, t0, amp * a * (0.7 + 0.3 * o.weight), 0.003, d * (0.8 + 0.4 * o.weight)).connect(tone);
    }
  };
  contact(when, level, 0);                                              // heel
  contact(when + (0.065 - 0.025 * o.pace) * vary(0.2), level * 0.45, 1); // toe

  // running: the sole scuffs the planks
  if (o.pace > 0.3) {
    const scuff = filter('highpass', 2500, 0.7);
    burst(when + 0.01, 0.09).connect(scuff);
    env(scuff, when + 0.01, level * 0.18 * o.pace, 0.01, 0.07).connect(tone);
  }

  // a plank creaks: more often under a heavy foot or in a seaway
  if (rnd() < 0.12 + 0.2 * o.pace + 0.25 * o.motion + 0.3 * (o.weight - 1)) {
    const t0 = when + 0.04 + rnd() * 0.08, dur = 0.14 + rnd() * 0.18;
    const f0 = 380 + rnd() * 500;
    const res = filter('bandpass', f0, 26 + rnd() * 20);
    res.frequency.setValueAtTime(f0, t0);
    res.frequency.linearRampToValueAtTime(f0 * (0.8 + rnd() * 0.45), t0 + dur);
    // the wood sticks and slips: a rough, stuttering excitation
    const chop = ctx.createGain();
    for (let k = 0; k * 0.012 < dur; k++) chop.gain.setValueAtTime(rnd() < 0.6 ? 1 : 0.15, t0 + k * 0.012);
    burst(t0, dur).connect(chop).connect(res);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level * 2.2, t0 + 0.03);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    res.connect(g).connect(tone);
  }
}
