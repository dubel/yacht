import { fbm, smoothstep, vnoise } from '../core/noise';
import { boxIsOpenOcean, featuresNear, terrainHeight } from '../world/WorldGen';
import { CELL, type Discovery } from './Discovery';
import { placeName } from './names';

/*
 * An old sea chart drawn with Canvas 2D: aged paper, sepia ink coastlines with a second "echo" line off
 * the shore, watercolour shallows, stippled reefs, hill shading and contours on land, rhumb lines from a
 * compass rose, a dashed track, hand-lettered names. Only what the crew has seen is drawn — the rest of
 * the sheet stays blank paper, fading in at the edge of the known world.
 *
 * The world is inked into small cached tiles at four scales (2, 8, 32, 128 m per pixel), a few per frame
 * within a time budget, so opening the chart or sailing into new waters never stalls a frame.
 */

const TILE_PX = 64;
const LEVELS = [128, 512, 2048, 8192]; // tile size (m) → 2, 8, 32, 128 m/px
const PAD = 4;
const MAX_TILES = 600;

export interface ChartView {
  /** world centre of the view */
  cx: number;
  cz: number;
  /** metres per device pixel */
  mpp: number;
  /** device pixels */
  w: number;
  h: number;
}

export interface ChartOverlay {
  boat?: { x: number; z: number; heading: number };
  /** compass rose at this device-pixel position, with rhumb lines across the sheet */
  rose?: { x: number; y: number; r: number };
  labels?: boolean;
  scaleBar?: boolean;
  /** hand-lettered title in a cartouche at the top */
  title?: string;
  /** outline of the sheet: torn rectangle or torn circle */
  shape: 'rect' | 'circle';
  seed: number;
}

export const INK = 'rgb(62, 38, 20)';
const FONT = "'IM Fell English', 'Iowan Old Style', Georgia, 'Times New Roman', serif";

// ---------------------------------------------------------------- aged paper (generated once)

function makePaper(size = 512): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // tileable: blend the noise with copies shifted by one period, so the value at u = 1 equals u = 0
      const u = x / size, v = y / size;
      const n = (fx: number, fy: number, s: number) =>
        (fbm(fx * s, fy * s, 4) * (1 - u) * (1 - v) + fbm((fx - 1) * s, fy * s, 4) * u * (1 - v)
          + fbm(fx * s, (fy - 1) * s, 4) * (1 - u) * v + fbm((fx - 1) * s, (fy - 1) * s, 4) * u * v);
      const blot = n(u, v, 3);                      // broad mottling
      const stain = smoothstep(0.62, 0.8, n(u, v, 6)); // tea stains
      const fibre = vnoise((x % 128) * 0.9, y * 0.12) * 0.5 + vnoise(x * 0.13, (y % 128) * 0.8) * 0.5;
      const grain = Math.random();
      const k = 0.93 + 0.1 * (blot - 0.5) - 0.07 * stain + 0.03 * (fibre - 0.5) + 0.035 * (grain - 0.5);
      const i = (y * size + x) * 4;
      d[i] = 236 * k + 6 * stain;
      d[i + 1] = 214 * k - 8 * stain;
      d[i + 2] = 168 * k - 22 * stain;
      d[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------- inked world tiles

function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** ink one tile: level l, tile index (i, j); null when it is all open ocean */
function inkTile(l: number, i: number, j: number): HTMLCanvasElement | null {
  const size = LEVELS[l], mpp = size / TILE_PX;
  const x0 = i * size, z0 = j * size;
  if (boxIsOpenOcean(x0, z0, x0 + size, z0 + size)) return null;
  const W = TILE_PX + 2 * PAD;
  const H = new Float32Array(W * W);
  let land = false, shallow = false;
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const h = terrainHeight(x0 + (x - PAD + 0.5) * mpp, z0 + (y - PAD + 0.5) * mpp);
      H[y * W + x] = h;
      if (h > 0.2) land = true; else if (h > -10) shallow = true;
    }
  if (!land && !shallow) return null;
  const c = document.createElement('canvas');
  c.width = c.height = TILE_PX;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(TILE_PX, TILE_PX);
  const d = img.data;
  const isLand = (x: number, y: number) => H[y * W + x] > 0.2;
  // distance (px, ≤ PAD) from a water pixel to the nearest land pixel
  const landDist = (x: number, y: number) => {
    let best = 99;
    for (let dy = -PAD; dy <= PAD; dy++)
      for (let dx = -PAD; dx <= PAD; dx++) if (isLand(x + dx, y + dy)) best = Math.min(best, Math.hypot(dx, dy));
    return best;
  };
  for (let py = 0; py < TILE_PX; py++)
    for (let px = 0; px < TILE_PX; px++) {
      const x = px + PAD, y = py + PAD, h = H[y * W + x];
      let r = 0, g = 0, b = 0, a = 0;
      const gx = x0 + (px + 0.5) * mpp, gz = z0 + (py + 0.5) * mpp;
      if (h > 0.2) {
        // coast: land touching water → solid ink
        if (!isLand(x - 1, y) || !isLand(x + 1, y) || !isLand(x, y - 1) || !isLand(x, y + 1)) { r = 62; g = 38; b = 20; a = 245; }
        else {
          // ochre wash, hill-shaded from the north-west, greener and darker up the slopes
          const sx = (H[y * W + x + 1] - H[y * W + x - 1]) / (2 * mpp), sz = (H[(y + 1) * W + x] - H[(y - 1) * W + x]) / (2 * mpp);
          const shade = Math.max(0.55, Math.min(1.25, 1 + (-sx - sz) * 0.9));
          const up = smoothstep(2, 30, h);
          r = (205 - 55 * up) * shade; g = (168 - 30 * up) * shade; b = (104 - 30 * up) * shade; a = 200;
          // contour every 10 m
          const band = Math.floor(h / 10);
          if (h > 10 && (Math.floor(H[y * W + x + 1] / 10) !== band || Math.floor(H[(y + 1) * W + x] / 10) !== band)) { r = 96; g = 64; b = 36; a = 170; }
          // a few ink hatches on the shaded slopes
          if (shade < 0.8 && hash(Math.floor(gx / (mpp * 3)), Math.floor(gz / mpp)) < 0.25) { r *= 0.7; g *= 0.7; b *= 0.7; }
        }
      } else {
        const ld = landDist(x, y);
        if (h > -10) {
          // watercolour shallows, stronger toward the surface
          const s = 0.1 + 0.32 * smoothstep(-10, -1, h);
          r = 92; g = 146; b = 138; a = 255 * s;
          // stippled reef (awash coral away from the beaches)
          if (h > -1.4 && ld > 3 && hash(Math.floor(gx / mpp), Math.floor(gz / mpp)) < 0.3) { r = 62; g = 38; b = 20; a = 190; }
        }
        // "echo" coastlines off the shore, the old way of drawing a coast
        if (Math.abs(ld - 2.2) < 0.55) { r = 62; g = 38; b = 20; a = Math.max(a, 120); }
        else if (Math.abs(ld - 4) < 0.5) { r = 62; g = 38; b = 20; a = Math.max(a, 55); }
      }
      const k = (py * TILE_PX + px) * 4;
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = a;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------- torn edges

/** outline of a torn sheet: rectangle (inset by up to ~12 px) or circle */
function tornPath(ctx: CanvasRenderingContext2D, w: number, h: number, shape: 'rect' | 'circle', seed: number, scale: number): void {
  const tear = (t: number) => {
    // ragged fibres + a few deeper bites
    const n = vnoise(t * 0.09 + seed, seed * 1.7) * 0.6 + vnoise(t * 0.5 + seed * 3, 2.1) * 0.4;
    const bite = smoothstep(0.78, 0.95, vnoise(t * 0.021 + seed * 5, 7.3));
    return (2 + 7 * n + 10 * bite) * scale;
  };
  ctx.beginPath();
  if (shape === 'circle') {
    const R = Math.min(w, h) / 2, N = Math.ceil(R * 1.2);
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * Math.PI * 2, r = R - tear(k * 3);
      const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  } else {
    const step = 4 * scale;
    const pts: [number, number][] = [];
    let t = 0;
    for (let x = 0; x < w; x += step) pts.push([x, tear(t++)]);
    for (let y = 0; y < h; y += step) pts.push([w - tear(t++), y]);
    for (let x = w; x > 0; x -= step) pts.push([x, h - tear(t++)]);
    for (let y = h; y > 0; y -= step) pts.push([tear(t++), y]);
    pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  }
  ctx.closePath();
}

// ---------------------------------------------------------------- the chart

export class ChartRenderer {
  private readonly paper = makePaper();
  private readonly tiles = new Map<string, HTMLCanvasElement | null>();
  private readonly ink = document.createElement('canvas');
  private readonly mask = document.createElement('canvas');
  private readonly maskSmall = document.createElement('canvas');
  /** tiles inked since the last call (callers redraw when this changes) */
  inked = 0;

  constructor(private readonly discovery: Discovery) {}

  private tile(l: number, i: number, j: number, budget: { t: number }): HTMLCanvasElement | null | undefined {
    const key = `${l}:${i},${j}`;
    if (this.tiles.has(key)) {
      const t = this.tiles.get(key)!;
      this.tiles.delete(key); // refresh LRU order
      this.tiles.set(key, t);
      return t;
    }
    if (performance.now() > budget.t) return undefined;
    const t = inkTile(l, i, j);
    this.tiles.set(key, t);
    this.inked++;
    if (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!);
    return t;
  }

  /**
   * Draw the chart into ctx (w×h device px). Work on new tiles is limited to `budgetMs`; returns true when
   * everything in view was ready (otherwise call again next frame).
   */
  render(ctx: CanvasRenderingContext2D, v: ChartView, o: ChartOverlay, budgetMs = 3): boolean {
    const { w, h, mpp } = v;
    const budget = { t: performance.now() + budgetMs };
    const X = (x: number) => (x - v.cx) / mpp + w / 2, Y = (z: number) => (z - v.cz) / mpp + h / 2;
    const x0 = v.cx - (w / 2) * mpp, z0 = v.cz - (h / 2) * mpp, x1 = x0 + w * mpp, z1 = z0 + h * mpp;
    const px = Math.max(1, Math.min(w, h) / 400); // ink/lettering scale for this sheet

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    const pattern = ctx.createPattern(this.paper, 'repeat')!;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);

    // ---- inked world, masked by what has been discovered ----
    if (this.ink.width !== w || this.ink.height !== h) { this.ink.width = w; this.ink.height = h; }
    const ik = this.ink.getContext('2d')!;
    ik.clearRect(0, 0, w, h);
    ik.imageSmoothingEnabled = true;
    // known waters get a faint watercolour wash (the mask below keeps it to what has been seen), so the
    // edge of the explored world shows even over open sea
    ik.fillStyle = 'rgba(96, 132, 124, 0.26)';
    ik.fillRect(0, 0, w, h);
    let complete = true;
    let l = 0;
    while (l < LEVELS.length - 1 && LEVELS[l] / TILE_PX < mpp * 0.75) l++;
    const size = LEVELS[l];
    for (let j = Math.floor(z0 / size); j <= Math.floor(z1 / size); j++)
      for (let i = Math.floor(x0 / size); i <= Math.floor(x1 / size); i++) {
        if (!this.discovery.anyIn(i * size, j * size, (i + 1) * size, (j + 1) * size)) continue;
        let t = this.tile(l, i, j, budget);
        let sx = 0, sy = 0, sw = TILE_PX;
        if (t === undefined) {
          complete = false;
          // not inked yet: stretch the coarser tile that contains it meanwhile
          for (let k = l + 1; k < LEVELS.length; k++) {
            const r = LEVELS[k] / size, pi = Math.floor(i / r), pj = Math.floor(j / r);
            const key = `${k}:${pi},${pj}`;
            if (this.tiles.has(key)) { t = this.tiles.get(key)!; sw = TILE_PX / r; sx = (i - pi * r) * sw; sy = (j - pj * r) * sw; break; }
          }
        }
        if (t) ik.drawImage(t, sx, sy, sw, sw, X(i * size), Y(j * size), size / mpp + 0.5, size / mpp + 0.5);
      }
    // fog of war: discovered cells drawn one pixel each, softened at that size, scaled up (bilinear) over
    // the ink, which keeps only what they cover
    const ci0 = Math.floor(x0 / CELL) - 2, cj0 = Math.floor(z0 / CELL) - 2, ci1 = Math.ceil(x1 / CELL) + 2, cj1 = Math.ceil(z1 / CELL) + 2;
    const mw = ci1 - ci0, mh = cj1 - cj0;
    for (const c of [this.maskSmall, this.mask]) if (c.width !== mw || c.height !== mh) { c.width = mw; c.height = mh; }
    const mctx = this.maskSmall.getContext('2d')!;
    const mimg = mctx.createImageData(mw, mh);
    this.discovery.fillMask(ci0, cj0, mw, mh, mimg.data);
    mctx.putImageData(mimg, 0, 0);
    const mk = this.mask.getContext('2d')!;
    mk.clearRect(0, 0, mw, mh);
    mk.filter = 'blur(0.8px)';
    mk.drawImage(this.maskSmall, 0, 0);
    mk.filter = 'none';
    ik.globalCompositeOperation = 'destination-in';
    ik.drawImage(this.mask, X(ci0 * CELL), Y(cj0 * CELL), (mw * CELL) / mpp, (mh * CELL) / mpp);
    ik.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.ink, 0, 0);

    // ---- rhumb lines + compass rose ----
    if (o.rose) this.drawRose(ctx, o.rose.x, o.rose.y, o.rose.r, w, h, px);

    // ---- track: dashed red-brown line ----
    ctx.strokeStyle = 'rgba(140, 36, 24, 0.85)';
    ctx.lineWidth = 1.6 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const s of this.discovery.track) {
      ctx.beginPath();
      for (let k = 0; k < s.length; k += 2) (k === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, X(s[k]), Y(s[k + 1]));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ---- names of the places seen ----
    if (o.labels) {
      // keep names off the compass rose and the title cartouche
      const reserved: [number, number, number, number][] = [];
      if (o.rose) { const r = o.rose.r * 1.35; reserved.push([o.rose.x - r, o.rose.y - r * 1.2, o.rose.x + r, o.rose.y + r]); }
      if (o.title) reserved.push([w * 0.25, 0, w * 0.75, 80 * px]);
      this.drawLabels(ctx, v, X, Y, px, reserved);
    }

    // ---- the boat ----
    if (o.boat) {
      const bx = X(o.boat.x), by = Y(o.boat.z);
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(-o.boat.heading + Math.PI);
      const s = 6 * px;
      ctx.beginPath();
      ctx.moveTo(0, -1.6 * s); ctx.quadraticCurveTo(0.9 * s, -0.2 * s, 0.55 * s, 1.1 * s);
      ctx.lineTo(-0.55 * s, 1.1 * s); ctx.quadraticCurveTo(-0.9 * s, -0.2 * s, 0, -1.6 * s);
      ctx.fillStyle = 'rgb(150, 30, 20)';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2 * px;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    if (o.scaleBar) this.drawScale(ctx, w, h, mpp, px);
    if (o.title) this.drawTitle(ctx, o.title, w, px);

    // ---- sheet: paper grain over the ink, then the (cached) aged, burnt, torn sheet ----
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    const sheet = this.sheet(w, h, o.shape, o.seed, px);
    ctx.drawImage(sheet.shade, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(sheet.cut, 0, 0);
    ctx.restore();
    return complete;
  }

  private sheetCache = new Map<string, { shade: HTMLCanvasElement; cut: HTMLCanvasElement }>();

  /** darkened margins + burnt torn edge (multiplied over the chart) and the torn outline as an alpha mask */
  private sheet(w: number, h: number, shape: 'rect' | 'circle', seed: number, px: number) {
    const key = `${w}x${h}:${shape}:${seed}`;
    const hit = this.sheetCache.get(key);
    if (hit) return hit;
    const shade = document.createElement('canvas'), cut = document.createElement('canvas');
    shade.width = cut.width = w;
    shade.height = cut.height = h;
    const s = shade.getContext('2d')!;
    // handled, sun-bleached centre; darker toward the edges
    const vg = shape === 'circle'
      ? s.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.min(w, h) * 0.5)
      : s.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.5);
    vg.addColorStop(0, 'rgb(255,255,255)');
    vg.addColorStop(1, 'rgb(196,150,96)');
    s.fillStyle = vg;
    s.fillRect(0, 0, w, h);
    tornPath(s, w, h, shape, seed, px);
    s.save();
    s.clip();
    s.filter = `blur(${5 * px}px)`;
    s.strokeStyle = 'rgb(150, 92, 48)';
    s.lineWidth = 16 * px;
    s.stroke();
    s.filter = 'none';
    s.strokeStyle = 'rgb(120, 80, 50)';
    s.lineWidth = 1.2 * px;
    s.stroke();
    s.restore();
    const c = cut.getContext('2d')!;
    tornPath(c, w, h, shape, seed, px);
    c.fillStyle = '#000';
    c.fill();
    const out = { shade, cut };
    if (this.sheetCache.size > 6) this.sheetCache.clear();
    this.sheetCache.set(key, out);
    return out;
  }

  private drawRose(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, w: number, h: number, px: number): void {
    ctx.save();
    // rhumb lines: 16 directions across the whole sheet
    ctx.strokeStyle = 'rgba(62, 38, 20, 0.16)';
    ctx.lineWidth = 0.8 * px;
    const L = Math.hypot(w, h);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L);
      ctx.stroke();
    }
    ctx.translate(x, y);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1 * px;
    for (const rr of [r, r * 0.86]) { ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke(); }
    // points: 8 long (cardinal + ordinal) and 8 short, half inked half paper
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 - Math.PI / 2;
      const len = k % 4 === 0 ? r * 1.15 : k % 2 === 0 ? r * 0.8 : r * 0.55, wid = k % 4 === 0 ? r * 0.16 : r * 0.1;
      const tip = [Math.cos(a) * len, Math.sin(a) * len];
      const l = [Math.cos(a - Math.PI / 2) * wid, Math.sin(a - Math.PI / 2) * wid];
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(tip[0], tip[1]); ctx.lineTo(l[0] * side, l[1] * side); ctx.closePath();
        ctx.fillStyle = side > 0 ? (k === 0 ? 'rgb(150, 30, 20)' : INK) : 'rgb(236, 216, 172)';
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.fillStyle = INK;
    ctx.font = `${Math.round(r * 0.42)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('N', 0, -r * 1.18);
    ctx.restore();
  }

  private drawTitle(ctx: CanvasRenderingContext2D, title: string, w: number, px: number): void {
    ctx.save();
    const size = Math.round(24 * px);
    ctx.font = `italic ${size}px ${FONT}`;
    const tw = ctx.measureText(title).width, y = 44 * px, pad = 26 * px;
    // a simple scroll-like cartouche: paper plate, double ink frame, flourishes either side
    ctx.fillStyle = 'rgba(240, 222, 180, 0.85)';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2 * px;
    ctx.beginPath();
    ctx.roundRect(w / 2 - tw / 2 - pad, y - size * 0.95, tw + 2 * pad, size * 1.9, 6 * px);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 0.6 * px;
    ctx.beginPath();
    ctx.roundRect(w / 2 - tw / 2 - pad + 4 * px, y - size * 0.95 + 4 * px, tw + 2 * pad - 8 * px, size * 1.9 - 8 * px, 4 * px);
    ctx.stroke();
    for (const side of [-1, 1]) {
      const x = w / 2 + side * (tw / 2 + pad);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + side * 18 * px, y - 14 * px, x + side * 30 * px, y + 10 * px, x + side * 44 * px, y - 2 * px);
      ctx.stroke();
    }
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, w / 2, y + 1 * px);
    ctx.restore();
  }

  private drawScale(ctx: CanvasRenderingContext2D, w: number, h: number, mpp: number, px: number): void {
    // a nice round length about a sixth of the sheet: 1 NM = 1852 m, as on real charts
    const target = (w / 6) * mpp;
    const options = [0.25, 0.5, 1, 2, 5, 10, 20];
    const nm = options.reduce((best, o) => (Math.abs(o * 1852 - target) < Math.abs(best * 1852 - target) ? o : best), 1);
    const len = (nm * 1852) / mpp, x = w - len - 40 * px, y = h - 34 * px;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = INK;
    ctx.lineWidth = 1 * px;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.rect(x + (k * len) / 4, y, len / 4, 5 * px);
      if (k % 2 === 0) ctx.fill(); else ctx.stroke();
    }
    ctx.font = `italic ${Math.round(12 * px)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${nm} ${nm === 1 ? 'mila morska' : nm < 1 ? 'mili morskiej' : 'mil morskich'}`, x + len / 2, y - 3 * px);
    ctx.restore();
  }

  private drawLabels(ctx: CanvasRenderingContext2D, v: ChartView, X: (x: number) => number, Y: (z: number) => number, px: number, reserved: [number, number, number, number][]): void {
    const R = Math.hypot(v.w, v.h) * 0.5 * v.mpp;
    ctx.save();
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const taken: [number, number, number, number][] = [...reserved];
    for (const f of featuresNear(v.cx, v.cz, R).sort((a, b) => b.radius - a.radius)) {
      // big places always, small ones only when zoomed in
      const onScreen = (f.radius * 2) / v.mpp;
      if (f.kind === 'rock' || f.kind === 'cay' ? onScreen < 5 : onScreen < 2.5) continue;
      if (!this.discovery.isSeen(f.x, f.z)) continue;
      const name = placeName(f.kind, f.x, f.z);
      const size = Math.round((f.kind === 'home' || f.kind === 'atoll' ? 15 : 12) * px);
      ctx.font = `italic ${size}px ${FONT}`;
      const tw = ctx.measureText(name).width;
      // under the island / below the ring of a lagoon, out of the way of the boat and the track inside
      const x = X(f.x), y = Y(f.z) + f.radius / v.mpp + size * (f.kind === 'home' || f.kind === 'atoll' ? 0.9 : 1);
      const box: [number, number, number, number] = [x - tw / 2, y - size / 2, x + tw / 2, y + size / 2];
      const m = 22 * px; // clear of the torn edge
      if (box[0] < m || box[1] < m || box[2] > v.w - m || box[3] > v.h - m) continue;
      if (taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      taken.push(box);
      ctx.fillText(name, x, y);
    }
    ctx.restore();
  }
}
