// Flicker detector: samples the presented frame every rAF and reports frame-to-frame luminance jumps.
// usage: node tools/flicker.mjs "?query" seconds [forceResizeEverySec]
import puppeteer from 'puppeteer-core';
const [query = '', secs = '30', forceResize = '0'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/' + query, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.physics, { timeout: 60000 });
const report = await page.evaluate(async (secs, forceResize) => {
  const g = window.__game, gl = g.renderer.getContext();
  const log = [], px = new Uint8Array(4);
  let prev = null, frame = 0, lastEnv = 0;
  const env = g.env, origRefresh = env.refreshEnvironment.bind(env);
  env.refreshEnvironment = () => { lastEnv = frame; origRefresh(); };
  let lastResize = -1;
  const origResize = g.resize.bind(g);
  g.resize = () => { lastResize = frame; origResize(); };
  const orig = g.frame.bind(g);
  g.frame = (now) => {
    orig(now);
    frame++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    let sum = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      gl.readPixels(Math.floor((i + 0.5) * w / 8), Math.floor((j + 0.5) * h / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      sum += (px[0] * 0.2126 + px[1] * 0.7152 + px[2] * 0.0722) / 255;
    }
    const lum = sum / 64;
    if (prev !== null && Math.abs(lum - prev) > 0.025)
      log.push(`f${frame} t=${g.time.toFixed(1)} ${g.clock.label} lum ${prev.toFixed(3)}→${lum.toFixed(3)}${frame - lastEnv <= 1 ? ' [env refresh]' : ''}${frame - lastResize <= 1 ? ' [resize q=' + g.quality.toFixed(2) + ']' : ''}${g.weather.flash > 0.01 ? ' [lightning]' : ''}`);
    prev = lum;
  };
  const t0 = performance.now();
  let lastForce = t0;
  while (performance.now() - t0 < secs * 1000) {
    await new Promise((r) => setTimeout(r, 100));
    if (forceResize > 0 && performance.now() - lastForce > forceResize * 1000) { lastForce = performance.now(); g.pendingQuality = g.quality > 0.8 ? 0.7 : 1.0; }
  }
  return { frames: frame, jumps: log.length, log: log.slice(0, 25) };
}, Number(secs), Number(forceResize));
console.log(JSON.stringify(report, null, 1));
await browser.close();
