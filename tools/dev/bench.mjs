// Frame cost of the running game: CPU time of Game.frame and GPU time of the frame (timer queries), medians
// and 95th percentiles over a few seconds, in a few scenes.
// usage: node tools/dev/bench.mjs [base url, default http://localhost:5173/]
import puppeteer from 'puppeteer-core';
const base = process.argv[2] ?? 'http://localhost:5173/';
const scenes = [
  ['chase', '?time=11:00&pause&weather=fair&noadapt&q=1', ''],
  ['deck', '?time=11:00&pause&weather=fair&noadapt&q=1', 'KeyF'],
  ['deck+lantern (night)', '?time=22:30&pause&weather=fair&noadapt&q=1', 'KeyF,Digit3'],
];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
for (const [name, q, keys] of scenes) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto(base + q, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.physics, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  for (const k of keys.split(',').filter(Boolean)) { await page.keyboard.down(k); await new Promise((r) => setTimeout(r, 60)); await page.keyboard.up(k); await new Promise((r) => setTimeout(r, 1500)); }
  const r = await page.evaluate(async () => {
    const g = window.__game, gl = g.renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const cpu = [], gpu = [], pending = [];
    const orig = g.frame.bind(g);
    g.frame = (now) => {
      let q = null;
      if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      const t0 = performance.now();
      orig(now);
      cpu.push(performance.now() - t0);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (gl.getQueryParameter(p, gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(p); pending.splice(i, 1); }
      }
    };
    const n0 = performance.now(); let frames = 0;
    await new Promise((res) => { const tick = () => { frames++; if (performance.now() - n0 < 6000) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
    g.frame = orig;
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? `med ${s[Math.floor(s.length / 2)].toFixed(2)} p95 ${s[Math.floor(s.length * 0.95)].toFixed(2)}` : 'n/a'; };
    return { cpu: stat(cpu.slice(30)), gpu: stat(gpu.slice(30)), fps: (frames / 6).toFixed(0), q: g.quality, size: `${g.pipeline.width}x${g.pipeline.height}` };
  });
  console.log(`${name.padEnd(22)} cpu ${r.cpu} ms | gpu ${r.gpu} ms | ${r.fps} fps | ${r.size}`);
  await page.close();
}
await browser.close();
