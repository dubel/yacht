/** Keyboard + pointer state. Keys are KeyboardEvent.code values ("KeyW", "Space", …). */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  dragDX = 0;
  dragDY = 0;
  wheel = 0;
  dragging = false;

  constructor(el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code.startsWith('F') && e.code.length <= 3) e.preventDefault();
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());

    let last: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      this.dragging = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      this.dragDX += e.clientX - last.x;
      this.dragDY += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
    });
    const end = () => { last = null; this.dragging = false; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
  }

  isDown(code: string): boolean { return this.down.has(code); }
  axis(neg: string, pos: string): number { return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0); }
  /** true once per physical key press */
  wasPressed(code: string): boolean { return this.pressed.has(code); }

  endFrame(): void {
    this.pressed.clear();
    this.dragDX = this.dragDY = this.wheel = 0;
  }
}
