import type { Game } from '../core/Game';
import { Config } from '../core/Config';

/** F1 panel: timings, quality, water/physics internals. F2–F8 switch water debug views. */
export class DebugUI {
  private readonly el = document.getElementById('debug')!;
  private visible = Config.debug;
  private tick = 0;

  constructor(private readonly game: Game) {
    this.el.hidden = !this.visible;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
  }

  update(_dt: number): void {
    if (!this.visible || this.tick++ % 10) return;
    const g = this.game, p = g.physics, info = g.renderer.info;
    const t = p.telemetry();
    this.el.textContent = [
      `${g.fps.toFixed(0)} fps   ${g.pipeline.width}×${g.pipeline.height}   q ${g.quality.toFixed(2)}`,
      `draw ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k`,
      `FFT ${Config.fft.N}² @ ${Config.fft.L} m   ripples ${Config.ripples.N}² @ ${Config.ripples.size} m`,
      `caustics ${Config.caustics.size}² (grid ${Config.caustics.grid})   plants ${g.vegetation.count}`,
      `terrain ${g.terrain.stats.meshes}/${g.terrain.stats.tiles} tiles  ${(g.terrain.stats.vertices / 1000).toFixed(0)}k verts  queue ${g.terrain.backlog}   pos ${p.origin.x.toFixed(0)}, ${p.origin.z.toFixed(0)}`,
      `view  ${g.view}   [F2 final F3 normals F4 caustics F5 refl F6 depth F7 ripples F8 fft]`,
      ``,
      `wind  ${g.wind.speed.toFixed(1)} m/s from ${((g.wind.from * 180) / Math.PI).toFixed(0)}°`,
      `boat  ${t.kn} kn  brg ${t.bearing}°  heel ${t.heel}°  pitch ${t.pitch}°`,
      `AWA ${t.awa}°  AWS ${t.aws}  TWA ${t.twa}°  leeway ${t.leeway}°`,
      `sheet ${t.sheet}°  boom ${t.boom}°  rudder ${t.rudder}°  aoa ${((p.sailAoa * 180) / Math.PI).toFixed(0)}°`,
      `mass ${(p.mass / 1000).toFixed(1)} t  y ${t.y}  ${t.grounded ? 'GROUNDED' : ''}`,
      `cam ${g.cam.camera.position.toArray().map((v) => v.toFixed(0)).join(', ')}`,
    ].join('\n');
  }
}
