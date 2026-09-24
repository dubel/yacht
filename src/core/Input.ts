/** Keyboard + pointer state. Keys are KeyboardEvent.code values ("KeyW", "Space", …). */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  dragDX = 0;
  dragDY = 0;
  wheel = 0;
  dragging = false;
  /** mouse-look while the pointer is locked (first-person view), px */
  lookDX = 0;
  lookDY = 0;
  /** right mouse button held (the spyglass) */
  rmb = false;
  /** left button pressed this frame (fires a manned gun) */
  click = false;
  private ctrlAt = -1e9;
  /** lock the pointer on the next click on the canvas (set by the first-person view) */
  wantLock = false;
  private readonly el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    addEventListener('keydown', (e) => {
      // Ctrl fires the guns: keep the browser's Ctrl shortcuts (save, bookmark, select all…) out of the way
      if (e.ctrlKey || e.code === 'ControlLeft' || e.code === 'ControlRight') { e.preventDefault(); this.ctrlAt = performance.now(); }
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
      // pointer locked (first-person look): clicks carry no drag, and capturing would throw InvalidStateError
      if (this.locked || e.button === 2) return;
      if (this.wantLock) {
        // the lock can be refused (e.g. clicked again right after Esc released it): just stay unlocked
        try { Promise.resolve(el.requestPointerLock()).catch(() => {}); } catch { /* unsupported */ }
        return;
      }
      el.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      this.dragging = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.locked) { this.lookDX += e.movementX; this.lookDY += e.movementY; return; }
      if (!last) return;
      this.dragDX += e.clientX - last.x;
      this.dragDY += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
    });
    const end = () => { last = null; this.dragging = false; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // right button: tracked on its own (it also arrives while the pointer is locked); no context menu
    el.addEventListener('mousedown', (e) => { if (e.button === 2) this.rmb = true; if (e.button === 0) this.click = true; });
    // Ctrl+W / Ctrl+T can't be blocked; right after a Ctrl, closing the page asks first
    addEventListener('beforeunload', (e) => { if (performance.now() - this.ctrlAt < 2000) e.preventDefault(); });
    addEventListener('mouseup', (e) => { if (e.button === 2) this.rmb = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('blur', () => { this.rmb = false; });
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
  }

  get locked(): boolean { return document.pointerLockElement === this.el; }
  unlock(): void { if (this.locked) document.exitPointerLock(); }

  isDown(code: string): boolean { return this.down.has(code); }
  axis(neg: string, pos: string): number { return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0); }
  /** true once per physical key press */
  wasPressed(code: string): boolean { return this.pressed.has(code); }

  endFrame(): void {
    this.pressed.clear();
    this.dragDX = this.dragDY = this.wheel = this.lookDX = this.lookDY = 0;
    this.click = false;
  }
}
