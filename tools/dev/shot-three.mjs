// Unity spike: the same shot from the web game, UI hidden → .shots/NAME-three.png
// usage: node tools/dev/shot-three.mjs NAME ["?weather=clear&time=10:30&pause&t=5&cam=…"] [wait ms]
import puppeteer from 'puppeteer-core';
const [name, query = '?weather=clear&time=10:30&pause&t=5', waitMs = '4000'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/' + query, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.physics && window.__game.terrain.backlog === 0, { timeout: 90000 });
await new Promise((r) => setTimeout(r, Number(waitMs)));
// same rig as the Unity spike: the set sails down, the furled bundles shown
await page.evaluate(() => { const b = window.__game.boat; b.sails.group.visible = false; for (const m of b.sail) m.visible = true; });
await page.addStyleTag({ content: 'body > *:not(canvas) { display: none !important; }' });
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `.shots/${name}-three.png` });
console.log(JSON.stringify(await page.evaluate(() => { const g = window.__game; return { boat: g.boat.root.position.toArray().map((v) => +v.toFixed(2)), cam: g.cam.camera.position.toArray().map((v) => +v.toFixed(2)) }; })));
await browser.close();
