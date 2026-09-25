import { ITEMS, SLOTS, type Inventory, type Place } from '../gameplay/Inventory';
import type { ItemIcons } from './ItemIcons';

/*
 * The captain's chest (I): a torn parchment sheet over the game, like the chart. Along the top the nine
 * slots (the keys 1–9 use what lies in them), below everything else he has gathered, in a list that
 * scrolls; his ducats in the corner. Each thing is shown by its own model, turning (ItemIcons).
 *
 * Things are moved by dragging (pointer events, so it works the same with a mouse or a pen): a picture of
 * the thing follows the pointer, the place under it lights up, and letting go there moves it (onto
 * something: the two change places). A double click sends a thing the other way — from a slot to the bag,
 * from the bag to the first free slot. Hovering shows what it is.
 */

const ICON = 96;
/** px the pointer must travel before a press becomes a drag (so a double click stays a click) */
const DRAG_START = 5;

export class InventoryUI {
  open = false;
  onOpen: ((open: boolean) => void) | null = null;
  /** a thing was picked up / put down (sounds) */
  onPick: (() => void) | null = null;
  onDrop: (() => void) | null = null;
  private readonly el = document.createElement('div');
  private readonly sheet = document.createElement('div');
  private readonly slotsEl = document.createElement('div');
  private readonly bagEl = document.createElement('div');
  private readonly gold = document.createElement('span');
  private readonly tip = document.createElement('div');
  private readonly ghost = document.createElement('canvas');
  /** every icon on the sheet and whose it is */
  private cells: { canvas: HTMLCanvasElement; id: string; el: HTMLElement }[] = [];
  private angle = 0;
  private drag: { from: Place; id: string; x: number; y: number; on: boolean } | null = null;
  private dirty = true;

  constructor(private readonly inv: Inventory, private readonly icons: ItemIcons) {
    this.el.id = 'inventory';
    this.el.hidden = true;
    this.sheet.className = 'sheet';
    const title = document.createElement('h2');
    title.textContent = 'Skrzynia Kapitańska';
    const purse = document.createElement('div');
    purse.className = 'gold';
    purse.append(this.gold);
    const h1 = document.createElement('h3');
    h1.textContent = 'Pod ręką — klawisze 1–9';
    this.slotsEl.className = 'slots';
    const h2 = document.createElement('h3');
    h2.textContent = 'Zebrane';
    this.bagEl.className = 'bag';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'przeciągnij — przenieś · dwuklik — do slotu / do skrzyni · I / Esc — zamknij';
    this.sheet.append(title, purse, h1, this.slotsEl, h2, this.bagEl, hint);
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.ghost.className = 'ghost';
    this.ghost.width = this.ghost.height = ICON;
    this.ghost.hidden = true;
    this.el.append(this.sheet, this.tip, this.ghost);
    document.body.append(this.el);
    this.tear();
    // (the parchment's torn edge: redone when the window changes shape)
    addEventListener('resize', () => this.tear());
    inv.onChange(() => { this.dirty = true; });
    // clicking the dark round the sheet closes it
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.toggle(); });
    addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', (e) => this.onUp(e));
  }

  toggle(): void {
    this.open = !this.open;
    this.el.hidden = !this.open;
    if (!this.open) this.cancelDrag();
    this.dirty = true;
    this.onOpen?.(this.open);
  }

  close(): void {
    if (this.open) this.toggle();
  }

  /** once per frame: while open, the icons turn */
  update(dt: number): void {
    if (!this.open) return;
    if (this.dirty) this.build();
    this.angle += dt * 0.9;
    this.gold.textContent = `${this.inv.ducats} dukatów`;
    const view = this.bagEl.getBoundingClientRect();
    for (const c of this.cells) {
      // (only what can be seen: the bag scrolls)
      if (c.el.parentElement === this.bagEl) {
        const r = c.el.getBoundingClientRect();
        if (r.bottom < view.top || r.top > view.bottom) continue;
      }
      this.icons.draw(c.id, c.canvas, this.angle);
    }
    if (this.drag?.on) this.icons.draw(this.drag.id, this.ghost, this.angle * 2);
  }

  /** lay out the slots and the bag afresh */
  private build(): void {
    this.dirty = false;
    this.cells = [];
    // (the cell under the pointer is about to be replaced: it will never say the pointer left it)
    this.tip.hidden = true;
    this.slotsEl.replaceChildren();
    this.bagEl.replaceChildren();
    for (let i = 0; i < SLOTS; i++) this.slotsEl.append(this.cell({ at: 'slot', i }, `${i + 1}`));
    this.inv.bag.forEach((_, i) => this.bagEl.append(this.cell({ at: 'bag', i })));
    if (!this.inv.bag.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Skrzynia pusta — przeciągnij tu coś ze slotów.';
      this.bagEl.append(empty);
    }
  }

  private cell(place: Place, key?: string): HTMLElement {
    const s = this.inv.get(place);
    const el = document.createElement('div');
    el.className = 'cell' + (s ? '' : ' free');
    el.dataset.place = `${place.at}:${place.i}`;
    if (key) { const k = document.createElement('kbd'); k.textContent = key; el.append(k); }
    if (s) {
      const def = ITEMS[s.id];
      const c = document.createElement('canvas');
      c.width = c.height = ICON;
      el.append(c);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = def.name;
      el.append(name);
      if (s.n > 1) { const n = document.createElement('b'); n.textContent = `×${s.n}`; el.append(n); }
      this.cells.push({ canvas: c, id: s.id, el });
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.drag = { from: place, id: s.id, x: e.clientX, y: e.clientY, on: false };
      });
      el.addEventListener('dblclick', () => { this.inv.swapSide(place); this.onDrop?.(); });
      el.addEventListener('pointerenter', () => {
        if (this.drag?.on) return;
        this.tip.innerHTML = `<b>${def.name}</b>${def.desc}`;
        this.tip.hidden = false;
        const r = el.getBoundingClientRect();
        this.tip.style.left = `${r.left + r.width / 2}px`;
        this.tip.style.top = `${r.bottom + 6}px`;
      });
      el.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    }
    return el;
  }

  /** the place under the pointer: a cell, or the bag's empty room (its end) */
  private placeAt(x: number, y: number): Place | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const cell = hit?.closest<HTMLElement>('[data-place]');
    if (cell) {
      const [at, i] = cell.dataset.place!.split(':');
      return { at: at as 'slot' | 'bag', i: +i };
    }
    if (hit && this.bagEl.contains(hit)) return { at: 'bag', i: -1 };
    return null;
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.on && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_START) {
      d.on = true;
      this.ghost.hidden = false;
      this.tip.hidden = true;
      this.el.classList.add('dragging');
      this.onPick?.();
    }
    if (!d.on) return;
    this.ghost.style.left = `${e.clientX}px`;
    this.ghost.style.top = `${e.clientY}px`;
    const to = this.placeAt(e.clientX, e.clientY);
    for (const c of this.el.querySelectorAll('.cell.over, .bag.over')) c.classList.remove('over');
    if (to?.at === 'bag' && to.i < 0) this.bagEl.classList.add('over');
    else if (to) this.el.querySelector(`[data-place="${to.at}:${to.i}"]`)?.classList.add('over');
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (d.on) {
      const to = this.placeAt(e.clientX, e.clientY);
      if (to) { this.inv.move(d.from, to); this.onDrop?.(); }
    }
    this.cancelDrag();
  }

  private cancelDrag(): void {
    this.drag = null;
    this.ghost.hidden = true;
    this.el.classList.remove('dragging');
    for (const c of this.el.querySelectorAll('.over')) c.classList.remove('over');
  }

  /** a torn edge for the sheet: a polygon wandering a few px in and out along its sides */
  private tear(): void {
    const pts: string[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const side = (n: number, f: (k: number, j: number) => string) => { for (let k = 0; k < n; k++) pts.push(f(k / n, (rnd() - 0.3) * 1.1)); };
    side(40, (k, j) => `${k * 100}% ${Math.max(0, j)}%`);
    side(24, (k, j) => `${100 - Math.max(0, j) * 0.8}% ${k * 100}%`);
    side(40, (k, j) => `${100 - k * 100}% ${100 - Math.max(0, j)}%`);
    side(24, (k, j) => `${Math.max(0, j) * 0.8}% ${100 - k * 100}%`);
    this.sheet.style.clipPath = `polygon(${pts.join(',')})`;
  }
}
