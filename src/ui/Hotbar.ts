import { ITEMS, SLOTS, type Inventory } from '../gameplay/Inventory';

/*
 * The slots along the bottom of the screen in first person: the keys 1–9 and what lies in each (its icon,
 * once the icons are drawn, and its name), the one in use lit.
 */
export class Hotbar {
  private readonly el = document.createElement('div');
  private readonly cells: HTMLElement[] = [];
  /** per slot, where its icon goes (ItemIcons draws into these) */
  readonly icons: HTMLCanvasElement[] = [];
  private active = -1;

  constructor(private readonly inv: Inventory) {
    this.el.id = 'slots';
    this.el.hidden = true;
    for (let i = 0; i < SLOTS; i++) {
      const c = document.createElement('span');
      const icon = document.createElement('canvas');
      icon.width = icon.height = 64;
      c.innerHTML = `<kbd>${i + 1}</kbd>`;
      c.append(icon, document.createElement('b'));
      this.cells.push(c);
      this.icons.push(icon);
      this.el.append(c);
    }
    document.body.append(this.el);
    inv.onChange(() => this.render());
    this.render();
  }

  private render(): void {
    for (let i = 0; i < SLOTS; i++) {
      const s = this.inv.slot(i), c = this.cells[i];
      c.classList.toggle('empty', !s);
      (c.lastElementChild as HTMLElement).textContent = s ? ITEMS[s.id].name + (s.n > 1 ? ` ×${s.n}` : '') : '';
      c.title = s ? ITEMS[s.id].name : '';
    }
  }

  /** the slot in use (−1: none) */
  setActive(i: number): void {
    if (i === this.active) return;
    this.active = i;
    this.cells.forEach((c, k) => c.classList.toggle('on', k === i));
  }

  show(on: boolean): void {
    this.el.hidden = !on;
  }
}
