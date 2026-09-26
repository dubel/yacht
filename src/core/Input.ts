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
  /** left button held */
  lmb = false;
  private ctrlAt = -1e9;
  /** a finger last touched the screen (the mouse presses a tap makes up are not clicks) */
  private touchAt = -1e9;
  /**
   * The pointer lock asked for and not given (Safari on the iPad has none): the mouse then turns the view by
   * dragging instead. Where the lock works (a PC) this stays false and the mouse does exactly what it always
   * did; it is cleared whenever a lock is granted.
   */
  private noLock = false;
  private lockAsked = -1;
  /** lock the pointer on the next click on the canvas (set by the first-person view) */
  wantLock = false;
  /** a panel is open (the inventory): the game hears no keys but these */
  suspended = false;
  private static readonly THROUGH = new Set(['KeyI', 'Escape', 'Tab', 'F1', 'F7', 'F8', 'F9', 'F10', 'KeyM']);
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
    /** the finger that turns the view (one at a time: a second finger doesn't make it jump) */
    let finger = -1;
    el.addEventListener('pointerdown', (e) => {
      // pointer locked (first-person look): clicks carry no drag, and capturing would throw InvalidStateError
      if (this.locked || e.button === 2) return;
      const touch = e.pointerType === 'touch';
      if (touch) {
        this.touchAt = performance.now();
        if (finger >= 0) return;
        finger = e.pointerId;
      }
      if (this.wantLock && !touch) {
        // the lock can be refused (e.g. clicked again right after Esc released it), or not be there at all
        // (Safari on the iPad): see noLock. (No capture: the lock may come a moment later, and capturing
        // would get in its way.)
        this.lockAsked = performance.now();
        const refused = () => { this.lockAsked = -1; if (!this.locked) this.noLock = true; };
        try { Promise.resolve(el.requestPointerLock()).catch(refused); } catch { refused(); }
        // (no answer at all — some browsers neither lock nor say no)
        setTimeout(() => { if (this.lockAsked >= 0 && !this.locked) refused(); }, 500);
        if (!this.noLock) return;
      } else el.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      this.dragging = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.locked) { this.lookDX += e.movementX; this.lookDY += e.movementY; return; }
      if (!last || (e.pointerType === 'touch' && e.pointerId !== finger)) return;
      this.dragDX += e.clientX - last.x;
      this.dragDY += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
    });
    const end = (e: PointerEvent) => {
      if (e.pointerType === 'touch') { this.touchAt = performance.now(); if (e.pointerId !== finger) return; finger = -1; }
      last = null;
      this.dragging = false;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // right button: tracked on its own (it also arrives while the pointer is locked); no context menu.
    // (A tap also sends a make-believe mouse press after it: that is no shot.)
    el.addEventListener('mousedown', (e) => {
      if (performance.now() - this.touchAt < 1000) return;
      if (e.button === 2) this.rmb = true;
      if (e.button === 0) { this.click = true; this.lmb = true; }
    });
    // Ctrl+W / Ctrl+T can't be blocked; right after a Ctrl, closing the page asks first
    addEventListener('beforeunload', (e) => { if (performance.now() - this.ctrlAt < 2000) e.preventDefault(); });
    addEventListener('mouseup', (e) => { if (e.button === 2) this.rmb = false; if (e.button === 0) this.lmb = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('blur', () => { this.rmb = this.lmb = false; });
    document.addEventListener('pointerlockchange', () => { if (this.locked) { this.noLock = false; this.lockAsked = -1; } });
    document.addEventListener('pointerlockerror', () => { this.lockAsked = -1; this.noLock = true; });
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
  }

  get locked(): boolean { return document.pointerLockElement === this.el; }
  unlock(): void { if (this.locked) document.exitPointerLock(); }

  private hears(code: string): boolean { return !this.suspended || Input.THROUGH.has(code); }
  isDown(code: string): boolean { return this.hears(code) && this.down.has(code); }
  axis(neg: string, pos: string): number { return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0); }
  /** true once per physical key press */
  wasPressed(code: string): boolean { return this.hears(code) && this.pressed.has(code); }

  endFrame(): void {
    this.pressed.clear();
    this.dragDX = this.dragDY = this.wheel = this.lookDX = this.lookDY = 0;
    this.click = false;
  }
}
