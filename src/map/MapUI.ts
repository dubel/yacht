import type { Discovery } from './Discovery';
import { ChartRenderer } from './ChartRenderer';

/*
 * The chart on screen: a round torn-parchment minimap in the corner (north up, boat in the middle, 1.2 km
 * around), and the full chart (Tab) that can be dragged and zoomed. Both are drawn by ChartRenderer only
 * when something changed — the boat moved, new waters were discovered, tiles finished inking.
 */

const MINI_RADIUS_M = 1200;

export class MapUI {
  private readonly chart: ChartRenderer;
  private readonly mini = document.createElement('canvas');
  private readonly miniWrap = document.createElement('div');
  private readonly overlay = document.createElement('div');
  private readonly big = document.createElement('canvas');
  open = false;
  private view = { cx: 0, cz: 0, mpp: 8 };
  private miniT = 0;
  private miniDone = false;
  private bigDirty = true;
  private lastVersion = -1;
  private lastBoat = { x: Infinity, z: Infinity };
  private boat = { x: 0, z: 0, heading: 0 };

  constructor(private readonly discovery: Discovery, private readonly seed: number) {
    this.chart = new ChartRenderer(discovery);
    this.miniWrap.id = 'minimap';
    this.miniWrap.title = 'Mapa (Tab)';
    this.miniWrap.append(this.mini);
    this.miniWrap.addEventListener('click', () => { this.toggle(); if (document.pointerLockElement) document.exitPointerLock(); });
    this.overlay.id = 'chart';
    this.overlay.hidden = true;
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'przeciągnij — przesuń · kółko — przybliż · C — wyśrodkuj · Tab / Esc — zamknij';
    // wiping the chart: each button asks once ("sure?") and acts on a second click within 3 s
    const tools = document.createElement('div');
    tools.className = 'tools';
    const button = (label: string, confirm: string, act: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      let armed = 0;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (armed) {
          clearTimeout(armed);
          armed = 0;
          b.textContent = label;
          b.classList.remove('armed');
          act();
          this.bigDirty = true;
          this.miniDone = false;
          return;
        }
        b.textContent = confirm;
        b.classList.add('armed');
        armed = window.setTimeout(() => { armed = 0; b.textContent = label; b.classList.remove('armed'); }, 3000);
      });
      tools.append(b);
    };
    button('Wyczyść trasę', 'Na pewno? Kliknij ponownie', () => this.discovery.clearTrack());
    button('Zapomnij odkrycia', 'Na pewno? Kliknij ponownie', () => this.discovery.clearDiscovered());
    this.overlay.append(this.big, hint, tools);
    document.body.append(this.miniWrap, this.overlay);

    // pan / zoom on the big chart
    let drag: { x: number; y: number } | null = null;
    this.big.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      try { this.big.setPointerCapture(e.pointerId); } catch { /* pointer still locked by the deck view */ }
    });
    this.big.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dpr = this.dpr;
      this.view.cx -= (e.clientX - drag.x) * dpr * this.view.mpp;
      this.view.cz -= (e.clientY - drag.y) * dpr * this.view.mpp;
      drag = { x: e.clientX, y: e.clientY };
      this.bigDirty = true;
    });
    const end = () => { drag = null; };
    this.big.addEventListener('pointerup', end);
    this.big.addEventListener('pointercancel', end);
    this.big.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.big.getBoundingClientRect(), dpr = this.dpr;
      // zoom about the cursor
      const mx = (e.clientX - r.left) * dpr - this.big.width / 2, my = (e.clientY - r.top) * dpr - this.big.height / 2;
      const wx = this.view.cx + mx * this.view.mpp, wz = this.view.cz + my * this.view.mpp;
      this.view.mpp = Math.min(90, Math.max(1.5, this.view.mpp * Math.pow(1.15, Math.sign(e.deltaY))));
      this.view.cx = wx - mx * this.view.mpp;
      this.view.cz = wz - my * this.view.mpp;
      this.bigDirty = true;
    }, { passive: false });
    this.overlay.addEventListener('pointerdown', (e) => { if (e.target === this.overlay) this.toggle(); });
  }

  private get dpr(): number {
    return Math.min(devicePixelRatio || 1, 2);
  }

  toggle(): void {
    this.open = !this.open;
    this.overlay.hidden = !this.open;
    this.miniWrap.hidden = this.open;
    if (this.open) { this.center(); this.view.mpp = 10; }
  }

  close(): void {
    if (this.open) this.toggle();
  }

  center(): void {
    this.view.cx = this.boat.x;
    this.view.cz = this.boat.z;
    this.bigDirty = true;
  }

  update(dt: number, boat: { x: number; z: number; heading: number }): void {
    this.boat = boat;
    const moved = Math.hypot(boat.x - this.lastBoat.x, boat.z - this.lastBoat.z) > 4;
    const discovered = this.discovery.version !== this.lastVersion;
    if (moved || discovered) { this.lastBoat = { x: boat.x, z: boat.z }; this.lastVersion = this.discovery.version; this.miniDone = false; this.bigDirty = true; }

    if (this.open) {
      const dpr = this.dpr;
      const w = Math.round(this.big.clientWidth * dpr), h = Math.round(this.big.clientHeight * dpr);
      if (this.big.width !== w || this.big.height !== h) { this.big.width = w; this.big.height = h; this.bigDirty = true; }
      if (this.bigDirty && w > 0) {
        const ctx = this.big.getContext('2d')!;
        const done = this.chart.render(ctx, { ...this.view, mpp: this.view.mpp, w, h }, {
          boat, labels: true, scaleBar: true, shape: 'rect', seed: this.seed, title: 'Mapa Mórz Odkrytych',
          rose: { x: w * 0.14, y: h * 0.8, r: Math.min(w, h) * 0.07 },
        }, 6);
        this.bigDirty = !done;
      }
      return;
    }

    // minimap: a few times a second, or every frame while tiles are still inking
    this.miniT -= dt;
    if (this.miniDone && this.miniT > 0) return;
    this.miniT = 0.25;
    const dpr = this.dpr;
    const size = Math.round(this.miniWrap.clientWidth * dpr);
    if (!size) return;
    if (this.mini.width !== size) { this.mini.width = this.mini.height = size; }
    const ctx = this.mini.getContext('2d')!;
    this.miniDone = this.chart.render(ctx, { cx: boat.x, cz: boat.z, mpp: (2 * MINI_RADIUS_M) / size, w: size, h: size },
      { boat, shape: 'circle', seed: this.seed + 1 }, 2);
  }
}
