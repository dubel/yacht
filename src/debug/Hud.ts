import type { Game } from '../core/Game';

/** Sailing instruments: speed, heading, wind rose relative to the boat, trim, heel. */
export class Hud {
  private readonly el = document.getElementById('hud')!;
  private readonly help = document.getElementById('help')!;
  private tick = 0;
  /** the controls panel (F8), remembered between sessions */
  private helpOn = (() => { try { return localStorage.getItem('lagoon.help') !== 'off'; } catch { return true; } })();

  constructor() {
    this.el.hidden = false;
    this.help.hidden = !this.helpOn;
    this.help.innerHTML = [
      '<b>Sterowanie</b> <span class="tog">(<kbd>F8</kbd> — pokaż / ukryj)</span>',
      '<kbd>A</kbd>/<kbd>D</kbd> ster &nbsp; <kbd>W</kbd>/<kbd>S</kbd> wybierz / luzuj szot',
      '<kbd>T</kbd> auto-trym &nbsp; <kbd>Spacja</kbd>/<kbd>X</kbd> zwiń / postaw żagle',
      'mysz: obrót kamery, kółko: zoom &nbsp; <kbd>V</kbd> pod wodę &nbsp; <kbd>R</kbd> reset',
      '<kbd>F</kbd> na pokład (FPP): <kbd>WASD</kbd> chodzenie, <kbd>Shift</kbd> bieg, <kbd>Spacja</kbd> skok, mysz: rozglądanie, <kbd>←</kbd>/<kbd>→</kbd> ster',
      '&nbsp;&nbsp;&nbsp;&nbsp;luneta: prawy przycisk myszy (przytrzymaj) lub <kbd>L</kbd>, kółko: przybliżenie &nbsp; <kbd>X</kbd> żagle',
      'działa: <kbd>Ctrl</kbd> lewy / prawy — salwa z lewej / prawej burty; na pokładzie <kbd>Ctrl</kbd> przy dziale — obsadź',
      'na pokładzie: <kbd>1</kbd> pistolet, <kbd>2</kbd> rapier, <kbd>3</kbd> latarnia, <kbd>0</kbd> luneta — <kbd>Ctrl</kbd> / lewy przycisk: strzał / cięcie / unieś latarnię',
      'na mieliźnie: <kbd>K</kbd> — wywieźć kotwicę i ściągnąć statek (kedżowanie)',
      '<kbd>N</kbd> pogoda &nbsp; <kbd>[</kbd>/<kbd>]</kbd> czas ∓1 h &nbsp; <kbd>P</kbd> stop czasu &nbsp; <kbd>M</kbd> dźwięk',
      '<kbd>Tab</kbd> mapa &nbsp; (odkrywasz ją, płynąc) &nbsp; <kbd>−</kbd>/<kbd>+</kbd> tempo ×1–×6',
      '<kbd>F1</kbd> debug &nbsp; <kbd>F2</kbd>–<kbd>F6</kbd> widoki wody &nbsp; <kbd>F7</kbd> muzyka wł./wył. &nbsp; <kbd>F9</kbd> fauna wł./wył.',
      '<span class="credit">muzyka: Kevin MacLeod (incompetech.com), CC BY 3.0</span>',
      '<span id="sndhint">🔊 kliknij lub naciśnij klawisz, aby włączyć dźwięk</span>',
    ].join('<br>');
  }

  toggleHelp(): void {
    this.helpOn = !this.helpOn;
    this.help.hidden = !this.helpOn;
    try { localStorage.setItem('lagoon.help', this.helpOn ? 'on' : 'off'); } catch { /* storage unavailable */ }
  }

  update(g: Game): void {
    if (this.tick++ % 6) return;
    const p = g.physics;
    const deg = (r: number) => (r * 180) / Math.PI;
    // wind rose: boat points up, arrow shows where the true wind comes FROM
    const a = p.twa;
    const R = 34, cx = 40, cy = 40;
    const wx = cx + Math.sin(-a) * R * -1, wy = cy - Math.cos(a) * R;
    const aa = p.awa;
    const ax = cx - Math.sin(aa) * R * 0.8, ay = cy - Math.cos(aa) * R * 0.8;
    const boom = p.boomAngle;
    const bx = cx - Math.sin(boom) * 16 * -1, by = cy + 4 + Math.cos(boom) * 16;
    const svg = `<svg class="compass" width="80" height="80" viewBox="0 0 80 80">
      <circle cx="40" cy="40" r="36" fill="none" stroke="rgba(255,255,255,.25)"/>
      <path d="M40 22 L46 38 L44 58 L36 58 L34 38 Z" fill="rgba(255,255,255,.75)"/>
      <line x1="40" y1="44" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#ffd27a" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="${wx.toFixed(1)}" y1="${wy.toFixed(1)}" x2="40" y2="40" stroke="#8fd3ff" stroke-width="2" marker-end="url(#h)"/>
      <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="3" fill="#8fd3ff" opacity=".6"/>
      <defs><marker id="h" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#8fd3ff"/></marker></defs>
    </svg>`;
    const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`;
    this.el.innerHTML =
      svg +
      row('czas', `${g.clock.label}${g.clock.paused ? ' ⏸' : ''} · ${g.weather.name}${g.weather.auto ? '' : ' 🔒'}`) +
      row('prędkość', `${(p.speed * 1.943844).toFixed(1)} kn${p.travel > 1 ? ` <b class="travel">×${String(p.travel).replace('.', ',')}</b>` : ''}`) +
      row('kurs', `${deg(p.bearing).toFixed(0).padStart(3, '0')}°`) +
      row('wiatr', `${(g.wind.speed * 1.943844).toFixed(0)} kn · ${Math.abs(deg(p.twa)).toFixed(0)}°`) +
      row('kurs wzgl. wiatru', p.pointOfSail) +
      row('szot', `${deg(p.sheet).toFixed(0)}°${p.autoTrim ? ' (auto)' : ''}${p.luffing ? ' · łopocze' : ''}`) +
      row('przechył', `${Math.abs(deg(p.heel)).toFixed(0)}°`) +
      (p.sailsUp < 0.5 ? row('żagle', 'zwinięte') : '') +
      (p.grounded ? row('⚠', 'mielizna!') : '');
    const sh = document.getElementById('sndhint');
    if (sh) sh.textContent = g.audio.started ? (g.audio.muted ? '🔇 dźwięk wyciszony (M)' : '🔊 dźwięk włączony (M wycisza)') : '🔊 kliknij lub naciśnij klawisz, aby włączyć dźwięk';
  }
}
