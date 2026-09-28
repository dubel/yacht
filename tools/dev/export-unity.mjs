// Unity spike: export the sky (float equirect, 2048×1024 RGBA), FFT spectrum seed, boat model and lighting/wave state from the
// running game (dev server on :5173) into unity-spike/Import/. Terrain: tools/dev/export-terrain.ts.
// usage: node tools/dev/export-unity.mjs ["?weather=clear&time=10:30&pause&t=5"]
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const query = process.argv[2] ?? '?weather=clear&time=10:30&pause&t=5';
const out = process.env.UNITY_IMPORT ?? 'unity-spike/Import';
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, protocolTimeout: 600000,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error') console.log(`[error] ${t}`); });
await page.goto('http://localhost:5173/' + query, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.physics, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));
const res = await page.evaluate(async () => (await import('/tools/dev/unityExport.ts')).run(window.__game));
writeFileSync(`${out}/sky.bin`, Buffer.from(res.sky, 'base64'));
writeFileSync(`${out}/h0.bin`, Buffer.from(res.h0, 'base64'));
writeFileSync(`${out}/boat.raw.glb`, Buffer.from(res.boat, 'base64'));
// Unity's glTFast reads neither WebP nor (reliably) quantised attributes: PNG textures, float attributes
const gt = (...a) => execFileSync('npx', ['gltf-transform', ...a], { stdio: 'ignore' });
gt('png', `${out}/boat.raw.glb`, `${out}/boat.png.glb`, '--formats', '*');
gt('dequantize', `${out}/boat.png.glb`, `${out}/boat.glb`);
writeFileSync(`${out}/state.json`, JSON.stringify(res.state, null, 1));
console.log(JSON.stringify(res.state.env), '\nboat', JSON.stringify(res.state.boat));
await browser.close();
