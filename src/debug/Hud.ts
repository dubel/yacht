import type { Game } from '../core/Game';
import { fmt } from '../gameplay/Mission';

/** Sailing instruments: speed, heading, wind rose relative to the boat, trim, heel. */
export class Hud {
  private readonly el = document.getElementById('hud')!;
  private readonly help = document.getElementById('help')!;
  private readonly missionEl = document.getElementById('mission')!;
  private readonly toast = document.getElementById('toast')!;
  private tick = 0;
  private helpOn = true;

  constructor() {
    this.el.hidden = false;
    this.help.hidden = false;
    this.missionEl.hidden = false;
    this.help.innerHTML = [
      '<b>Sterowanie</b>',
      '<kbd>A</kbd>/<kbd>D</kbd> ster &nbsp; <kbd>W</kbd>/<kbd>S</kbd> wybierz / luzuj szot',
      '<kbd>T</kbd> auto-trym &nbsp; <kbd>Spacja</kbd> zwiń / postaw żagle',
      'mysz: obrót kamery, kółko: zoom &nbsp; <kbd>V</kbd> pod wodę &nbsp; <kbd>R</kbd> reset',
      '<kbd>N</kbd> pogoda &nbsp; <kbd>[</kbd>/<kbd>]</kbd> czas ∓1 h &nbsp; <kbd>P</kbd> stop czasu &nbsp; <kbd>M</kbd> dźwięk',
      '<kbd>Tab</kbd> mapa &nbsp; (odkrywasz ją, płynąc)',
      '<kbd>F1</kbd> debug &nbsp; <kbd>F2</kbd>–<kbd>F8</kbd> widoki wody &nbsp; <kbd>H</kbd> ukryj',
      '<span id="sndhint">🔊 kliknij lub naciśnij klawisz, aby włączyć dźwięk</span>',
    ].join('<br>');
    setTimeout(() => this.help.classList.add('fade'), 12000);
  }

  toggleHelp(): void {
    this.helpOn = !this.helpOn;
    this.help.hidden = !this.helpOn;
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
      row('prędkość', `${(p.speed * 1.943844).toFixed(1)} kn`) +
      row('kurs', `${deg(p.bearing).toFixed(0).padStart(3, '0')}°`) +
      row('wiatr', `${(g.wind.speed * 1.943844).toFixed(0)} kn · ${Math.abs(deg(p.twa)).toFixed(0)}°`) +
      row('kurs wzgl. wiatru', p.pointOfSail) +
      row('szot', `${deg(p.sheet).toFixed(0)}°${p.autoTrim ? ' (auto)' : ''}${p.luffing ? ' · łopocze' : ''}`) +
      row('przechył', `${Math.abs(deg(p.heel)).toFixed(0)}°`) +
      (p.sailsUp < 0.5 ? row('żagle', 'zwinięte') : '') +
      (p.grounded ? row('⚠', 'mielizna!') : '');
    this.updateMission(g);
    const sh = document.getElementById('sndhint');
    if (sh) sh.textContent = g.audio.started ? (g.audio.muted ? '🔇 dźwięk wyciszony (M)' : '🔊 dźwięk włączony (M wycisza)') : '🔊 kliknij lub naciśnij klawisz, aby włączyć dźwięk';
  }

  private updateMission(g: Game): void {
    const m = g.mission, p = g.physics;
    const o = p.origin;
    const tgt = m.target(o);
    let next = '';
    if (tgt) {
      // arrow relative to the bow: 0 = straight ahead
      const want = Math.atan2(tgt.x - o.x, tgt.z - o.z);
      let rel = want - p.heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      next = `<div class="next"><svg class="arrow" viewBox="0 0 18 18" style="transform:rotate(${(-rel * 180) / Math.PI}deg)"><path d="M9 1 L15 15 L9 11 L3 15 Z" fill="#ffd27a"/></svg>${tgt.name} · ${tgt.dist.toFixed(0)} m</div>`;
    }
    const list = m.marks.map((k) => `<div class="${k.done ? 'done' : ''}">${k.done ? '✓' : '○'} ${k.name}</div>`).join('');
    const back = m.remaining === 0 ? `<div class="${m.finished ? 'done' : ''}">${m.finished ? '✓' : '○'} Powrót na start</div>` : '';
    this.missionEl.innerHTML = `<div class="t"><span>${fmt(m.elapsed)}</span><span style="opacity:.6">${m.best !== null ? 'rekord ' + fmt(m.best) : ''}</span></div>${list}${back}${next}`;
    if (m.message) this.toast.textContent = m.message;
    this.toast.classList.toggle('on', !!m.message);
  }
}
