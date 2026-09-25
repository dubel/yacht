/*
 * A fade to black and back, over something the player shouldn't watch happen (the ship moved off a shoal,
 * the sailor rowed ashore): `action` runs in the dark, then the picture comes back.
 */

let el: HTMLElement | null = null;

export function fadeThrough(action: () => void, dark = 420, hold = 150): void {
  if (!el) {
    el = document.createElement('div');
    el.id = 'fade';
    document.body.append(el);
  }
  const e = el;
  e.classList.add('on');
  setTimeout(() => {
    action();
    setTimeout(() => e.classList.remove('on'), hold);
  }, dark);
}
