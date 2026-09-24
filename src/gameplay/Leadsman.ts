import { terrainHeight } from '../world/WorldGen';

/*
 * The leadsman in the chains, heaving the lead: twice a second he sounds the water ahead of the bow — out to
 * a few boat-lengths, farther the faster she goes (fast travel included), a little to either side of the
 * course too — and calls out when it shoals: the depth in fathoms (1 sążeń = 1.83 m) and roughly how far
 * ahead, with a stroke of the bell; with the keel about to touch, a sharper call and a double stroke. He
 * repeats himself only when things get worse, or every few seconds while they stay bad.
 */

const DRAFT = 2.25;
const FATHOM = 1.83;
/** start calling when the water ahead is shallower than this (m): 3/4 m under the keel. (The lagoons'
 *  floor lies at 3.7–5.3 m and the start area at ≥ 3.2 m — those must stay quiet; coral heads, the reef and
 *  the islands' shelves must not.) */
const WARN = DRAFT + 0.75;
const DANGER = DRAFT + 0.25;

export interface LeadsmanCall {
  text: string;
  level: 1 | 2;
}

const words = ['', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć'];

function fathoms(depth: number): string {
  const f = Math.max(0.5, Math.round((depth / FATHOM) * 2) / 2);
  const whole = Math.floor(f), half = f - whole > 0;
  if (whole === 0) return 'pół sążnia';
  const w = words[whole] ?? String(whole);
  const unit = half ? 'sążnia' : whole === 1 ? 'sążeń' : whole < 5 ? 'sążnie' : 'sążni';
  return `${w}${half ? ' i pół' : ''} ${unit}`;
}

export class Leadsman {
  private t = 0;
  private level = 0;
  private repeat = 0;
  private readonly el = document.createElement('div');
  private showT = 0;
  onCall: ((c: LeadsmanCall) => void) | null = null;

  constructor() {
    this.el.id = 'lead';
    this.el.hidden = true;
    document.body.append(this.el);
  }

  /**
   * `x, z, heading` of the bow; `speed` over the ground (m/s); `quiet`: aground or being kedged — nothing to
   * call.
   */
  update(dt: number, x: number, z: number, heading: number, speed: number, quiet: boolean): void {
    this.showT -= dt;
    this.el.hidden = this.showT <= 0;
    this.repeat -= dt;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.5;
    if (quiet || speed < 0.6) { this.level = 0; return; }

    // sound ahead: along the course and ±12°, out to ~6 s of sailing (at least 40 m)
    const reach = Math.max(40, Math.min(160, speed * 6));
    // the shallowest water within reach, and how far off it first gets dangerous
    let shallowest = Infinity;
    const first = [Infinity, Infinity]; // nearest distance below WARN, below DANGER
    for (const off of [0, -0.21, 0.21])
      for (let d = 8; d <= reach; d += 8) {
        const depth = -terrainHeight(x + Math.sin(heading + off) * d, z + Math.cos(heading + off) * d);
        shallowest = Math.min(shallowest, depth);
        if (depth < WARN) first[0] = Math.min(first[0], d);
        if (depth < DANGER) first[1] = Math.min(first[1], d);
      }
    const level = shallowest < DANGER ? 2 : shallowest < WARN ? 1 : 0;
    if (level === 0) { this.level = 0; return; }
    if (level <= this.level && this.repeat > 0) return;
    this.level = level;
    this.repeat = level === 2 ? 4 : 7;
    const at = first[level - 1];
    const far = at < 15 ? 'tuż przed dziobem' : `~${Math.round(at / 10) * 10} m przed dziobem`;
    const text = level === 1
      ? `Sonda: ${fathoms(shallowest)}, płytko ${far}`
      : shallowest < 0.4
        ? `Mielizna na wierzchu ${far} — ster na burtę!`
        : `Sonda: ${fathoms(shallowest)}! Mielizna ${far} — ster na burtę!`;
    this.el.textContent = text;
    this.el.classList.toggle('danger', level === 2);
    this.showT = 4;
    this.onCall?.({ text, level });
  }
}
