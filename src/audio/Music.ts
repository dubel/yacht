/*
 * Music that follows the voyage. A handful of recorded pieces (Kevin MacLeod, CC BY 3.0 — see
 * public/assets/music/CREDITS.md) grouped by mood: calm sailing by day, dusk and night, the open sea far
 * from land, storm, and the capstan while kedging off a shoal. The game says which mood the moment is in;
 * the player hears a piece of it, then the sea alone for a while, then another — music as a companion, not
 * a wall. A change of mood that lasts a few seconds fades the piece out and brings in one that fits (storm
 * and the capstan come in at once). Pieces stream (HTML audio), so nothing is downloaded before it plays.
 * F7 turns it off and on (remembered); M silences it with everything else.
 */

export type Mood = 'calm' | 'dusk' | 'voyage' | 'storm' | 'haul';

const TRACKS: Record<Mood, string[]> = {
  calm: ['calm-1', 'calm-2', 'calm-3'],
  dusk: ['dusk-1', 'dusk-2'],
  voyage: ['voyage-1', 'voyage-2'],
  storm: ['storm-2', 'storm-1'],
  haul: ['haul-1'],
};
const LEVEL: Record<Mood, number> = { calm: 0.3, dusk: 0.28, voyage: 0.32, storm: 0.34, haul: 0.36 };
/** seconds of just the sea between pieces */
const GAP: Record<Mood, [number, number]> = { calm: [8, 20], dusk: [10, 24], voyage: [8, 20], storm: [3, 6], haul: [0, 0] };

export const MUSIC_NAMES: Record<Mood, string> = { calm: 'spokój', dusk: 'zmierzch', voyage: 'wyprawa', storm: 'sztorm', haul: 'kabestan' };

interface Playing { el: HTMLAudioElement; mood: Mood; vol: number }

export class Music {
  enabled = (() => { try { return localStorage.getItem('lagoon.music') !== 'off'; } catch { return true; } })();
  private readonly queue = new Map<Mood, string[]>();
  private playing: Playing | null = null;
  private fading: Playing[] = [];
  private mood: Mood | null = null;
  private pending: Mood | null = null;
  private pendingT = 0;
  /** silence left before the next piece */
  private wait = 3;

  constructor(private readonly base = 'assets/music/') {}

  /** F7 */
  toggle(): boolean {
    this.enabled = !this.enabled;
    try { localStorage.setItem('lagoon.music', this.enabled ? 'on' : 'off'); } catch { /* storage unavailable */ }
    if (!this.enabled) this.stop();
    else this.wait = 1;
    return this.enabled;
  }

  get now(): string {
    return this.playing ? `${MUSIC_NAMES[this.playing.mood]}: ${this.playing.el.src.split('/').pop()}` : this.mood ? `(cisza, ${MUSIC_NAMES[this.mood]})` : '—';
  }

  /** once per frame; `ready`: sound is running (after the first gesture); `muted`: M */
  update(dt: number, want: Mood, ready: boolean, muted: boolean): void {
    // fades
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.vol = Math.max(0, f.vol - dt / 3);
      f.el.volume = muted ? 0 : f.vol * LEVEL[f.mood];
      if (f.vol <= 0) { f.el.pause(); f.el.src = ''; this.fading.splice(i, 1); }
    }
    if (!ready || !this.enabled) return;

    // the mood: a change must hold a few seconds (a gust is not a storm), storm and capstan come at once
    if (want !== this.mood) {
      if (want !== this.pending) { this.pending = want; this.pendingT = 0; }
      this.pendingT += dt;
      if (this.mood === null || want === 'storm' || want === 'haul' || this.mood === 'haul' || this.pendingT > 4) {
        this.mood = want;
        this.pending = null;
        const urgent = want === 'storm' || want === 'haul';
        if (this.playing && this.playing.mood !== want) { this.fadeOut(); this.wait = urgent ? 0.5 : 2; }
        else if (urgent) this.wait = Math.min(this.wait, 0.5); // (in the middle of a quiet spell: no waiting)
      }
    } else this.pending = null;
    const mood = this.mood!;

    const p = this.playing;
    if (p) {
      p.vol = Math.min(1, p.vol + dt / 2.5);
      p.el.volume = muted ? 0 : p.vol * LEVEL[p.mood];
      if (p.el.ended) {
        this.playing = null;
        const [a, b] = GAP[mood];
        this.wait = a + Math.random() * (b - a);
      }
      return;
    }
    this.wait -= dt;
    if (this.wait > 0) return;
    this.start(mood);
  }

  private next(mood: Mood): string {
    let q = this.queue.get(mood);
    if (!q || !q.length) {
      q = [...TRACKS[mood]];
      for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
      this.queue.set(mood, q);
    }
    return q.shift()!;
  }

  private start(mood: Mood): void {
    const el = new Audio(`${this.base}${this.next(mood)}.mp3`);
    el.preload = 'auto';
    el.volume = 0;
    el.loop = mood === 'haul';
    el.play().catch(() => { /* not allowed yet: try again later */ this.playing = null; this.wait = 2; });
    this.playing = { el, mood, vol: 0 };
  }

  private fadeOut(): void {
    if (!this.playing) return;
    this.fading.push(this.playing);
    this.playing = null;
  }

  private stop(): void {
    this.fadeOut();
    this.mood = null;
  }
}
