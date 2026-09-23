// Headless screenshot + console capture for visual checks.
// usage: [KEYS=KeyA:2000,...] [EVAL=expr] node tools/shot.mjs [query] [name] [waitMs] [WxH]
//   e.g. node tools/shot.mjs "?cam=boat&t=5" boat 6000 1280x720
// Expects the dev server on http://localhost:5173 (npm run dev).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [query = '', name = 'shot', waitMs = '6000', size = '1280x720'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const base = process.env.SHOT_URL ?? 'http://localhost:5173/';
const exe = ['/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

fs.mkdirSync('.shots', { recursive: true });
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
await page.goto(base + query, { waitUntil: 'load' });
// KEYS="KeyA:3000,Space:100" holds each key for N ms in sequence after the page is up
const keys = (process.env.KEYS ?? '').split(',').filter(Boolean);
// EVAL="expr" runs in the page once the game is up (e.g. to force a debug material)
if (process.env.EVAL) {
  await page.waitForFunction(() => window.__game && window.__game.physics, { timeout: 60000 });
  await page.evaluate(process.env.EVAL);
}
const t0 = Date.now();
if (keys.length) await new Promise((r) => setTimeout(r, 4000));
for (const k of keys) {
  const [code, ms] = k.split(':');
  await page.keyboard.down(code);
  await new Promise((r) => setTimeout(r, Number(ms)));
  await page.keyboard.up(code);
}
await new Promise((r) => setTimeout(r, Math.max(0, Number(waitMs) - (Date.now() - t0))));
const info = await page.evaluate(() => (window.__game ? window.__game.debugSnapshot?.() : null));
if (info) console.log('[snapshot]', JSON.stringify(info));
await page.screenshot({ path: `.shots/${name}.png` });
console.log(`saved .shots/${name}.png`);
await browser.close();
