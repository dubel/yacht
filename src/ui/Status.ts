import type { Inventory } from '../gameplay/Inventory';

/*
 * Top right of the screen: his purse and his life.
 *
 * The purse: a gold coin turning slowly (a strip of frames drawn once, then only shown one after another)
 * and the count of ducats in dark gold; when it changes the figure runs to the new one.
 *
 * His life: a horizontal glass tube with crimson liquid in it, as full as he is well. The liquid is alive —
 * its front ripples, a lighter wave runs through it, now and then a bubble — and it sloshes: it leans as the
 * ship heels and rocks with his step. When he is hurt the level drains to the new one, a pale trace left
 * behind it for a moment.
 */

const TUBE_W = 190, TUBE_H = 20;

export class Status {
  private readonly el = document.createElement('div');
  private readonly coin = document.createElement('canvas');
  private readonly count = document.createElement('span');
  private readonly tube = document.createElement('canvas');
  private strip: HTMLCanvasElement | null = null;
  private frames = 1;
  private shown = 0;
  private level = 1;
  private trace = 1;
  private t = 0;
  /** the liquid's lean (rad) and how it sways about it */
  private lean = 0;
  private leanV = 0;
  private stir = 0;
  private readonly bubbles: { x: number; y: number; r: number; v: number }[] = [];

  constructor(private readonly inv: Inventory) {
    this.el.id = 'status';
    const purse = document.createElement('div');
    purse.className = 'purse';
    this.coin.width = this.coin.height = 64;
    purse.append(this.coin, this.count);
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.tube.width = Math.round(TUBE_W * dpr);
    this.tube.height = Math.round(TUBE_H * dpr);
    this.tube.className = 'life';
    this.tube.title = 'Zdrowie';
    this.el.append(purse, this.tube);
    document.body.append(this.el);
    this.shown = inv.ducats;
    this.level = this.trace = inv.health;
    this.count.textContent = String(inv.ducats);
  }

  /** the coin's turn, drawn (see ItemIcons.strip) */
  setCoin(strip: HTMLCanvasElement, frames: number): void {
    this.strip = strip;
    this.frames = frames;
  }

  show(on: boolean): void {
    this.el.hidden = !on;
  }

  /** once per frame: `heel` the ship's (rad, 0 ashore), `bob` 0 … 1 how much he is walking */
  update(dt: number, heel: number, bob: number): void {
    this.t += dt;
    // ---- the purse: the coin turns, the figure runs to the count ----
    if (this.strip) {
      const k = Math.floor(((this.t * 0.45) % 1) * this.frames);
      const ctx = this.coin.getContext('2d')!, s = this.coin.width;
      ctx.clearRect(0, 0, s, s);
      ctx.drawImage(this.strip, k * this.strip.height, 0, this.strip.height, this.strip.height, 0, 0, s, s);
    }
    const want = this.inv.ducats;
    if (this.shown !== want) {
      const step = Math.max(1, Math.ceil(Math.abs(want - this.shown) * dt * 6));
      this.shown += Math.sign(want - this.shown) * Math.min(step, Math.abs(want - this.shown));
      this.count.textContent = String(this.shown);
      this.count.classList.add('run');
    } else this.count.classList.remove('run');

    // ---- the tube ----
    const h = this.inv.health;
    this.level += (h - this.level) * Math.min(1, dt * 3);
    // (the trace of what was lost follows slowly; a gain fills at once)
    this.trace = h > this.trace ? this.level : this.trace + (this.level - this.trace) * Math.min(1, dt * 0.9);
    // the liquid leans with the ship (a damped spring), and a step or a roll stirs it
    this.leanV += ((heel * 0.9 - this.lean) * 30 - this.leanV * 5) * dt;
    this.lean += this.leanV * dt;
    this.stir += (Math.min(1, bob + Math.abs(this.leanV) * 0.6) - this.stir) * Math.min(1, dt * 2);
    this.drawTube(dt);
  }

  private drawTube(dt: number): void {
    const c = this.tube, ctx = c.getContext('2d')!, W = c.width, H = c.height, s = W / TUBE_W;
    const t = this.t;
    ctx.clearRect(0, 0, W, H);
    const pad = 3 * s, r = H / 2;
    const round = (x: number, y: number, w: number, hh: number, rr: number) => {
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + hh, rr);
      ctx.arcTo(x + w, y + hh, x, y + hh, rr);
      ctx.arcTo(x, y + hh, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    };
    // the glass: dark inside, a brass-dark rim
    round(0, 0, W, H, r);
    ctx.fillStyle = 'rgba(18, 6, 6, 0.62)';
    ctx.fill();
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = 'rgba(214, 180, 120, 0.55)';
    ctx.stroke();
    ctx.save();
    round(pad, pad, W - 2 * pad, H - 2 * pad, r - pad);
    ctx.clip();
    const x0 = pad, x1 = W - pad, iy0 = pad, iy1 = H - pad, len = x1 - x0;
    // the front of the liquid at height y: the level, leaning, rippling
    const amp = (0.8 + 2.2 * this.stir) * s;
    const front = (lv: number, y: number) => x0 + lv * len + Math.tan(this.lean) * (y - H / 2) * 1.6
      + Math.sin(y / H * 5.5 + t * 5.2) * amp + Math.sin(y / H * 11 - t * 7.7) * amp * 0.4;
    const body = (lv: number) => {
      ctx.beginPath();
      ctx.moveTo(x0 - 2, iy0);
      for (let y = iy0; y <= iy1 + 0.5; y += 1.5 * s) ctx.lineTo(front(lv, y), y);
      ctx.lineTo(x0 - 2, iy1);
      ctx.closePath();
    };
    // what was just lost: a pale, fading trace behind the level
    if (this.trace > this.level + 0.003) {
      body(this.trace);
      ctx.fillStyle = 'rgba(240, 150, 150, 0.35)';
      ctx.fill();
    }
    if (this.level > 0.002) {
      body(this.level);
      const g = ctx.createLinearGradient(0, iy0, 0, iy1);
      g.addColorStop(0, '#d8243a');
      g.addColorStop(0.45, '#a8101f');
      g.addColorStop(1, '#5c0610');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.save();
      ctx.clip();
      // a lighter wave running through it
      const wx = x0 + ((t * 0.22) % 1.4 - 0.2) * len;
      const wg = ctx.createLinearGradient(wx - 30 * s, 0, wx + 30 * s, 0);
      wg.addColorStop(0, 'rgba(255, 90, 100, 0)');
      wg.addColorStop(0.5, 'rgba(255, 110, 120, 0.28)');
      wg.addColorStop(1, 'rgba(255, 90, 100, 0)');
      ctx.fillStyle = wg;
      ctx.fillRect(x0, iy0, len, iy1 - iy0);
      // the surface swell along the top: a band of light that rises and falls
      ctx.beginPath();
      ctx.moveTo(x0, iy0);
      for (let x = x0; x <= x1; x += 3 * s) ctx.lineTo(x, iy0 + (2.2 + Math.sin(x / len * 9 - t * 3.1) * (0.8 + 1.4 * this.stir)) * s);
      ctx.lineTo(x1, iy0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 150, 150, 0.22)';
      ctx.fill();
      // bubbles: now and then one, drifting up and along
      if (Math.random() < dt * (0.8 + 2 * this.stir) && this.bubbles.length < 8)
        this.bubbles.push({ x: x0 + Math.random() * this.level * len, y: iy1 - 1 * s, r: (0.8 + Math.random() * 1.2) * s, v: 4 + Math.random() * 6 });
      ctx.fillStyle = 'rgba(255, 190, 190, 0.5)';
      for (let i = this.bubbles.length - 1; i >= 0; i--) {
        const b = this.bubbles[i];
        b.y -= b.v * s * dt;
        b.x += Math.sin(t * 3 + i) * 0.3 * s;
        if (b.y < iy0 + b.r || b.x > front(this.level, b.y)) { this.bubbles.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
    // the glass's shine: a highlight along the top, a faint one below
    const sh = ctx.createLinearGradient(0, 0, 0, H);
    sh.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
    sh.addColorStop(0.35, 'rgba(255, 255, 255, 0.05)');
    sh.addColorStop(0.8, 'rgba(255, 255, 255, 0)');
    sh.addColorStop(1, 'rgba(255, 255, 255, 0.12)');
    round(pad * 0.6, pad * 0.5, W - pad * 1.2, H - pad, r - pad * 0.5);
    ctx.fillStyle = sh;
    ctx.fill();
  }
}
