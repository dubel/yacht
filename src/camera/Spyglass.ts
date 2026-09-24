import type { Input } from '../core/Input';
import { noise1 } from '../core/noise';

/*
 * The spyglass: raised to the eye with the right mouse button (held) or L (toggle), the wheel sets the
 * magnification. While it comes up the view narrows from the eye's field to the lens's and the round
 * lens mask closes in from the edges; unsteady hands add a slow wander. The brass tube's rim is an SVG
 * over the canvas — an engraved compass ring that turns with the view (bearing under the index mark) and
 * the name of whatever is in the lens below — so the frame costs nothing on the GPU; the optics
 * (round field, a little barrel distortion and colour fringing at the edge) are in the post pass.
 */

export const LENS_R = 0.44; // lens radius, fraction of the shorter screen side
const RAISE_TIME = 0.32;

export class Spyglass {
  /** 0 lowered … 1 at the eye (eased) */
  raise = 0;
  /** chosen magnification (wheel) */
  zoom = 5;
  private z = 5;
  private toggled = false;
  private t = 0;
  private wasUp = false;
  onOpen: ((open: boolean) => void) | null = null;

  private readonly el = document.createElement('div');
  private readonly ring: SVGGElement;
  private readonly bearingEl: HTMLDivElement;
  private readonly labelEl: HTMLDivElement;

  constructor() {
    this.el.id = 'scope';
    this.el.hidden = true;
    const ticks: string[] = [];
    for (let d = 0; d < 360; d += 5) {
      const long = d % 30 === 0, a = (d * Math.PI) / 180;
      const r0 = long ? 452 : 458, r1 = 470;
      ticks.push(`<line x1="${500 + Math.sin(a) * r0}" y1="${500 - Math.cos(a) * r0}" x2="${500 + Math.sin(a) * r1}" y2="${500 - Math.cos(a) * r1}" stroke-width="${long ? 3 : 1.6}"/>`);
      if (d % 90 === 0) ticks.push(`<text x="${500 + Math.sin(a) * 485}" y="${500 - Math.cos(a) * 485}" transform="rotate(${d} ${500 + Math.sin(a) * 485} ${500 - Math.cos(a) * 485})">${'NESW'[d / 90]}</text>`);
      else if (d % 30 === 0) ticks.push(`<text class="n" x="${500 + Math.sin(a) * 486}" y="${500 - Math.cos(a) * 486}" transform="rotate(${d} ${500 + Math.sin(a) * 486} ${500 - Math.cos(a) * 486})">${d}</text>`);
    }
    this.el.innerHTML = `
      <svg viewBox="0 0 1000 1000" aria-hidden="true">
        <defs>
          <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#f1d995"/><stop offset=".35" stop-color="#b98e45"/>
            <stop offset=".6" stop-color="#e4c47c"/><stop offset="1" stop-color="#6b4c1f"/>
          </linearGradient>
          <radialGradient id="rim" cx=".5" cy=".5" r=".5">
            <stop offset=".86" stop-color="#000" stop-opacity="0"/><stop offset=".88" stop-color="#000" stop-opacity=".55"/>
            <stop offset=".9" stop-color="#000" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle cx="500" cy="500" r="${440 + 30}" fill="none" stroke="url(#brass)" stroke-width="60"/>
        <circle cx="500" cy="500" r="442" fill="none" stroke="#2c1d0a" stroke-width="4"/>
        <circle cx="500" cy="500" r="498" fill="none" stroke="#3a2710" stroke-width="3"/>
        <circle cx="500" cy="500" r="500" fill="url(#rim)"/>
        <g class="ring">${ticks.join('')}</g>
        <path d="M500 64 L490 46 L510 46 Z" fill="#2c1d0a"/>
      </svg>
      <div class="bearing"></div>
      <div class="label"></div>`;
    document.body.append(this.el);
    this.ring = this.el.querySelector('.ring')!;
    this.bearingEl = this.el.querySelector('.bearing')!;
    this.labelEl = this.el.querySelector('.label')!;
  }

  get open(): boolean {
    return this.raise > 0.5;
  }

  /** current magnification (1 while lowered, eased up as it rises) */
  get magnification(): number {
    return 1 + (this.z - 1) * this.raise;
  }

  toggle(): void {
    this.toggled = !this.toggled;
  }

  close(): void {
    this.toggled = false;
  }

  update(dt: number, input: Input, allowed: boolean): void {
    this.t += dt;
    const want = allowed && (input.rmb || this.toggled);
    if (!allowed) this.toggled = false;
    const r = this.raise + (want ? dt : -dt) / RAISE_TIME;
    this.raise = Math.max(0, Math.min(1, r));
    if (want && this.raise > 0.3) this.zoom = Math.max(3, Math.min(10, this.zoom * Math.pow(1.12, -input.wheel)));
    this.z += (this.zoom - this.z) * (1 - Math.exp(-dt * 6));
    if (want !== this.wasUp) { this.wasUp = want; this.onOpen?.(want); }
    this.el.hidden = this.raise < 0.02;
    this.el.style.setProperty('--raise', String(this.raise));
    document.body.classList.toggle('scoped', this.raise > 0.3);
  }

  /** unsteady hands: a slow wander of the aim (rad), larger at high magnification but not proportionally */
  tremor(): { yaw: number; pitch: number } {
    const k = this.raise * 0.0016 * Math.sqrt(this.z / 5);
    return { yaw: k * (noise1(this.t * 0.9, 3) + 0.4 * noise1(this.t * 3.1, 8)), pitch: k * (noise1(this.t * 0.8, 5) + 0.4 * noise1(this.t * 2.7, 11)) };
  }

  /** the brass ring shows the bearing of the view; the plate below names what is in the lens */
  show(bearingDeg: number, label: string): void {
    this.ring.setAttribute('transform', `rotate(${-bearingDeg} 500 500)`);
    this.bearingEl.textContent = `${Math.round(((bearingDeg % 360) + 360) % 360).toString().padStart(3, '0')}° · ×${this.z.toFixed(1).replace('.', ',')}`;
    this.labelEl.textContent = label;
    this.labelEl.style.opacity = label ? '' : '0';
  }
}
