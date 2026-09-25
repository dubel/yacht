// Drive the game in a headless browser (dev server on :5173) and take screenshots along the way.
// usage: node tools/dev/drive.mjs "<query>" "<async js body: key(code, ms), wait(ms), ev(fn, ...args), page>" [shot]
import puppeteer from 'puppeteer-core';
const [query, body, shot] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (m.type() !== 'warning' && !t.includes('[vite]') && !t.includes('THREE') && !t.includes('GL Driver')) console.log(`[${m.type()}] ${t}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
await page.goto('http://localhost:5173/' + query, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.physics, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2000));
const key = async (code, ms = 60) => { await page.keyboard.down(code); await new Promise((r) => setTimeout(r, ms)); await page.keyboard.up(code); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
await (new Function('key', 'wait', 'ev', 'page', `return (async () => { ${body} })()`))(key, wait, ev, page);
if (shot) await page.screenshot({ path: `.shots/${shot}.png` });
await browser.close();
