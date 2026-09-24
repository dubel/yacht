/*
 * What the player has seen and where they have sailed, for the chart. The ocean is a grid of CELL-metre
 * cells, a cell counts as discovered once the boat passes within SIGHT of it; bits are kept in sparse
 * 32×32-cell chunks. The track is a list of polyline segments (a jump — reset, teleport — starts a new
 * one). Everything is saved to localStorage per world seed, so the chart survives a restart.
 */

export const CELL = 100;
const CHUNK = 32;
/** how far the crew can make out coastlines from the deck (m) */
const SIGHT = 1500;
const TRACK_STEP = 30;
const MAX_TRACK = 40000;

const chunkKey = (ci: number, cj: number) => (ci + 32768) * 65536 + (cj + 32768);

export class Discovery {
  /** keyed by chunkKey(ci, cj) */
  private readonly chunks = new Map<number, Uint8Array>();
  /** track: polylines of [x, z, x, z, …] */
  readonly track: number[][] = [];
  /** bumps whenever something new is discovered (the chart redraws) */
  version = 0;
  private lastX = Infinity;
  private lastZ = Infinity;
  private dirty = false;
  private saveT = 0;
  private readonly key: string;

  constructor(seed: number) {
    this.key = `lagoon.chart.${seed}`;
    this.load();
    addEventListener('beforeunload', () => this.save());
  }

  isSeen(x: number, z: number): boolean {
    return this.cell(Math.floor(x / CELL), Math.floor(z / CELL));
  }

  cell(i: number, j: number): boolean {
    const ci = Math.floor(i / CHUNK), cj = Math.floor(j / CHUNK);
    const c = this.chunks.get(chunkKey(ci, cj));
    if (!c) return false;
    const b = (j - cj * CHUNK) * CHUNK + (i - ci * CHUNK);
    return (c[b >> 3] & (1 << (b & 7))) !== 0;
  }

  /** alpha = 255 for every discovered cell of the mw×mh window starting at cell (i0, j0) (RGBA data) */
  fillMask(i0: number, j0: number, mw: number, mh: number, data: Uint8ClampedArray): void {
    for (const [k, c] of this.chunks) {
      const ci = Math.floor(k / 65536) - 32768, cj = (k % 65536) - 32768;
      const bi = ci * CHUNK - i0, bj = cj * CHUNK - j0;
      if (bi >= mw || bj >= mh || bi + CHUNK <= 0 || bj + CHUNK <= 0) continue;
      for (let y = Math.max(0, -bj); y < Math.min(CHUNK, mh - bj); y++)
        for (let x = Math.max(0, -bi); x < Math.min(CHUNK, mw - bi); x++) {
          const b = y * CHUNK + x;
          if (c[b >> 3] & (1 << (b & 7))) data[((bj + y) * mw + bi + x) * 4 + 3] = 255;
        }
    }
  }

  /** anything discovered in the box? (cheap: whole chunks are skipped) */
  anyIn(x0: number, z0: number, x1: number, z1: number): boolean {
    const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL), j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL);
    for (let cj = Math.floor(j0 / CHUNK); cj <= Math.floor(j1 / CHUNK); cj++)
      for (let ci = Math.floor(i0 / CHUNK); ci <= Math.floor(i1 / CHUNK); ci++) {
        if (!this.chunks.has(chunkKey(ci, cj))) continue;
        for (let j = Math.max(j0, cj * CHUNK); j <= Math.min(j1, cj * CHUNK + CHUNK - 1); j++)
          for (let i = Math.max(i0, ci * CHUNK); i <= Math.min(i1, ci * CHUNK + CHUNK - 1); i++) if (this.cell(i, j)) return true;
      }
    return false;
  }

  private mark(i: number, j: number): boolean {
    const ci = Math.floor(i / CHUNK), cj = Math.floor(j / CHUNK), k = chunkKey(ci, cj);
    let c = this.chunks.get(k);
    if (!c) { c = new Uint8Array((CHUNK * CHUNK) / 8); this.chunks.set(k, c); }
    const b = (j - cj * CHUNK) * CHUNK + (i - ci * CHUNK);
    if (c[b >> 3] & (1 << (b & 7))) return false;
    c[b >> 3] |= 1 << (b & 7);
    return true;
  }

  /** once per frame with the boat position */
  update(dt: number, x: number, z: number): void {
    const moved = Math.hypot(x - this.lastX, z - this.lastZ);
    if (moved > 40) {
      // track: a long jump (reset to start) begins a new line instead of drawing across the map
      const seg = this.track[this.track.length - 1];
      if (!seg || moved > 400) this.track.push([Math.round(x), Math.round(z)]);
      else if (Math.hypot(x - seg[seg.length - 2], z - seg[seg.length - 1]) > TRACK_STEP) seg.push(Math.round(x), Math.round(z));
      let n = 0;
      for (const s of this.track) n += s.length / 2;
      if (n > MAX_TRACK) this.track.shift();
      this.lastX = x;
      this.lastZ = z;
      const r = Math.ceil(SIGHT / CELL), ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
      let any = false;
      for (let j = cj - r; j <= cj + r; j++)
        for (let i = ci - r; i <= ci + r; i++)
          if (Math.hypot((i + 0.5) * CELL - x, (j + 0.5) * CELL - z) < SIGHT && this.mark(i, j)) any = true;
      if (any) this.version++;
      this.dirty = true;
    }
    this.saveT += dt;
    if (this.dirty && this.saveT > 5) this.save();
  }

  /** mark a round area as seen from afar (an island made out through the spyglass) */
  revealAt(x: number, z: number, radius: number): void {
    const r = Math.ceil(radius / CELL), ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let any = false;
    for (let j = cj - r; j <= cj + r; j++)
      for (let i = ci - r; i <= ci + r; i++)
        if (Math.hypot((i + 0.5) * CELL - x, (j + 0.5) * CELL - z) < radius && this.mark(i, j)) any = true;
    if (any) { this.version++; this.dirty = true; }
  }

  /** wipe the sailed track (the discovered waters stay) */
  clearTrack(): void {
    this.track.length = 0;
    this.lastX = this.lastZ = Infinity; // the next update starts a fresh line where the boat is
    this.version++;
    this.dirty = true;
    this.save();
  }

  /** forget the discovered waters (the track stays); the boat's surroundings come back on the next update */
  clearDiscovered(): void {
    this.chunks.clear();
    this.lastX = this.lastZ = Infinity;
    this.version++;
    this.dirty = true;
    this.save();
  }

  /** forget everything for this world (debug) */
  clear(): void {
    this.chunks.clear();
    this.track.length = 0;
    this.lastX = this.lastZ = Infinity;
    this.version++;
    this.dirty = true;
    this.save();
  }

  private save(): void {
    this.saveT = 0;
    if (!this.dirty) return;
    this.dirty = false;
    const chunks: Record<string, string> = {};
    for (const [k, c] of this.chunks) chunks[`${Math.floor(k / 65536) - 32768},${(k % 65536) - 32768}`] = btoa(String.fromCharCode(...c));
    try { localStorage.setItem(this.key, JSON.stringify({ v: 1, chunks, track: this.track })); } catch { /* storage full / unavailable */ }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return;
      const d = JSON.parse(raw) as { v: number; chunks: Record<string, string>; track: number[][] };
      for (const [k, b64] of Object.entries(d.chunks ?? {})) {
        const [ci, cj] = k.split(',').map(Number);
        this.chunks.set(chunkKey(ci, cj), Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
      }
      for (const s of d.track ?? []) if (Array.isArray(s) && s.length >= 2) this.track.push(s);
    } catch { /* corrupt or unavailable: start a fresh chart */ }
  }
}
