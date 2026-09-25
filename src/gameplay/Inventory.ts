/*
 * What the sailor owns: nine slots (the keys 1–9 use what lies in them), a bag of everything else he has
 * gathered, his ducats and his health. The slots are places, not shortcuts: a thing is either in a slot or
 * in the bag, and moving it moves it (dropped on something, the two change places). Things of one kind that
 * pile up (a stack) are counted, not repeated. It is kept between sessions (localStorage).
 *
 * The catalogue below says what each thing is: its name and a word on it, what using it does, the model its
 * icon is drawn from (see ItemIcons) and how that model is best turned to be looked at.
 */

export type Use = 'pistol' | 'revolver' | 'rapier' | 'lantern' | 'skull' | 'spyglass';

export interface ItemDef {
  name: string;
  desc: string;
  /** what the keys 1–9 do with it (none: it is only carried) */
  use?: Use;
  /** it piles up in one place, counted */
  stack?: boolean;
  /** its model, for the icon: a weapon's first-person model, or a file under assets/items */
  model: string;
  /** the icon's view of it: turned about x then z (rad) before it spins about the vertical */
  pose?: [number, number];
  /** how close the icon's camera comes (1: the whole of its bounding sphere in view; default 1.3) */
  zoom?: number;
}

export const ITEMS: Record<string, ItemDef> = {
  pistol: { name: 'Pistolet skałkowy', desc: 'Jeden strzał, potem nabijanie: proch, kula, stempel i podsypka na panewkę.', use: 'pistol', model: 'fpv:pistol', pose: [0, 0.35] },
  rapier: { name: 'Rapier hiszpański', desc: 'Długa, wąska głownia i kosz z czaszą, która chroni dłoń.', use: 'rapier', model: 'fpv:rapier', pose: [0, 0.9] },
  lantern: { name: 'Latarnia', desc: 'Żelazna latarnia ze świecą. Ctrl podnosi ją wyżej.', use: 'lantern', model: 'fpv:lantern', zoom: 1.15 },
  revolver: { name: 'Rewolwer', desc: 'Sześć komór i kapiszony — broń z innej epoki, nie wiadomo skąd.', use: 'revolver', model: 'fpv:revolver', pose: [0, 0.35] },
  skull: { name: 'Mroczna latarnia', desc: 'Czaszka na sznurze, świeca w żuchwie i zielony, zimny płomień.', use: 'skull', model: 'fpv:skull', zoom: 1.05 },
  spyglass: { name: 'Luneta', desc: 'Mosiężna luneta. Też prawy przycisk myszy.', use: 'spyglass', model: 'items/telescope', pose: [0, 0.6] },
};

export interface Stack {
  id: string;
  n: number;
}

/** a place a thing can be: slot i (0–8), or bag cell i (−1: the end of the bag) */
export type Place = { at: 'slot'; i: number } | { at: 'bag'; i: number };

export const SLOTS = 9;
const KEY = 'lagoon.inventory';
const VERSION = 1;

export class Inventory {
  readonly slots: (Stack | null)[] = Array(SLOTS).fill(null);
  readonly bag: Stack[] = [];
  /** gold ducats */
  ducats = 100;
  /** 0 … 1 */
  health = 1;
  private readonly listeners: (() => void)[] = [];

  constructor() {
    if (!this.load()) this.reset();
  }

  /** the sailor's things as the voyage begins */
  reset(): void {
    this.slots.fill(null);
    this.bag.length = 0;
    const put = (i: number, id: string) => { this.slots[i] = { id, n: 1 }; };
    put(0, 'pistol'); put(1, 'rapier'); put(2, 'lantern'); put(6, 'revolver'); put(7, 'skull'); put(8, 'spyglass');
    this.ducats = 100;
    this.health = 1;
    this.changed();
  }

  /**
   * For debugging (?inventory=…): `all` — one of everything in the catalogue he hasn't got yet (ten of what
   * piles up) into the bag, so it can be asked for again and again without piling up; `reset` — the starting
   * kit; `rapier:3,lantern` — those added. Unknown names are reported and skipped.
   */
  debug(spec: string): void {
    if (spec === 'reset') { this.reset(); return; }
    if (spec === 'all') {
      for (const [id, def] of Object.entries(ITEMS)) if (!this.has(id)) this.add(id, def.stack ? 10 : 1);
      return;
    }
    for (const part of spec.split(',').filter(Boolean)) {
      const [id, n] = part.split(':');
      if (ITEMS[id]) this.add(id, Math.max(1, Math.round(+n || 1)));
      else console.warn(`?inventory: no such thing "${id}" — there are: ${Object.keys(ITEMS).join(', ')}`);
    }
  }

  /** call `fn` whenever anything changes */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** how many of `id` he has, slots and bag */
  count(id: string): number {
    let n = 0;
    for (const s of [...this.slots, ...this.bag]) if (s?.id === id) n += s.n;
    return n;
  }

  has(id: string): boolean {
    return this.count(id) > 0;
  }

  /** what the key `i` (0–8) holds */
  slot(i: number): Stack | null {
    return this.slots[i] ?? null;
  }

  /** gather `n` of `id`: onto a stack of it if it piles up, else into the bag */
  add(id: string, n = 1): void {
    if (!ITEMS[id]) throw new Error(`inventory: no such thing "${id}"`);
    if (ITEMS[id].stack) {
      const s = [...this.slots, ...this.bag].find((x) => x?.id === id);
      if (s) { s.n += n; this.changed(); return; }
      this.bag.push({ id, n });
    } else for (let k = 0; k < n; k++) this.bag.push({ id, n: 1 });
    this.changed();
  }

  /** give up `n` of `id` (from the bag first); false if he hasn't so many */
  remove(id: string, n = 1): boolean {
    if (this.count(id) < n) return false;
    for (const list of [this.bag, this.slots]) {
      for (let i = list.length - 1; i >= 0 && n > 0; i--) {
        const s = list[i];
        if (s?.id !== id) continue;
        const take = Math.min(n, s.n);
        s.n -= take;
        n -= take;
        if (s.n === 0) { if (list === this.bag) this.bag.splice(i, 1); else this.slots[i] = null; }
      }
    }
    this.changed();
    return true;
  }

  get(p: Place): Stack | null {
    return p.at === 'slot' ? this.slots[p.i] ?? null : this.bag[p.i] ?? null;
  }

  /**
   * Move what is at `from` to `to`. Onto an empty slot: it goes there. Onto something: the two change places
   * (onto the same kind that piles up: they join). Into the bag: it goes to that cell, the rest moving along
   * (−1, or past the end: to the end).
   */
  move(from: Place, to: Place): void {
    const a = this.get(from);
    if (!a || (from.at === to.at && from.i === to.i)) return;
    const b = to.at === 'slot' ? this.slots[to.i] : null;
    if (b && b.id === a.id && ITEMS[a.id].stack) {
      b.n += a.n;
      this.take(from);
    } else if (to.at === 'slot') {
      // (a slot's old thing goes where this one came from)
      if (from.at === 'slot') { this.slots[from.i] = b; this.slots[to.i] = a; }
      else { this.slots[to.i] = a; if (b) this.bag[from.i] = b; else this.bag.splice(from.i, 1); }
    } else {
      this.take(from);
      const i = to.i < 0 ? this.bag.length : Math.min(to.i, this.bag.length);
      this.bag.splice(i, 0, a);
    }
    this.changed();
  }

  /** send what is at `from` the other way: from a slot to the bag, from the bag to the first free slot */
  swapSide(from: Place): void {
    if (from.at === 'slot') { this.move(from, { at: 'bag', i: -1 }); return; }
    const free = this.slots.indexOf(null);
    if (free >= 0) this.move(from, { at: 'slot', i: free });
  }

  setDucats(n: number): void {
    this.ducats = Math.max(0, Math.round(n));
    this.changed();
  }

  setHealth(h: number): void {
    this.health = Math.min(1, Math.max(0, h));
    this.changed();
  }

  private take(p: Place): void {
    if (p.at === 'slot') this.slots[p.i] = null;
    else this.bag.splice(p.i, 1);
  }

  private changed(): void {
    this.save();
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: VERSION, slots: this.slots, bag: this.bag, ducats: this.ducats, health: this.health }));
    } catch { /* storage unavailable */ }
  }

  private load(): boolean {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (!d || d.v !== VERSION) return false;
      const ok = (s: Stack | null) => !s || (ITEMS[s.id] && s.n > 0);
      if (!Array.isArray(d.slots) || !Array.isArray(d.bag) || !d.slots.every(ok) || !d.bag.every(ok)) return false;
      for (let i = 0; i < SLOTS; i++) this.slots[i] = d.slots[i] ?? null;
      this.bag.push(...d.bag);
      this.ducats = +d.ducats || 0;
      this.health = Number.isFinite(+d.health) ? +d.health : 1;
      return true;
    } catch {
      return false;
    }
  }
}
