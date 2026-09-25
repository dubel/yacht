// Screenshot of a dev page (tools/dev/<PAGE>.html) with the dev server on :5173.
// usage: PAGE=fpv|model node tools/dev/page.mjs "<query>" <shot name> ["<js to evaluate and print>"]
import puppeteer from 'puppeteer-core';
const [query = '', shot = 'dev', evalJs] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { const t = m.text(); if (!t.includes('404') && !t.includes('[vite]')) console.log('[' + m.type() + ']', t); });
await page.goto('http://localhost:5173/tools/dev/' + (process.env.PAGE ?? 'model') + '.html' + query, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, { timeout: 30000 });
if (evalJs) console.log(await page.evaluate(evalJs));
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `.shots/${shot}.png` });
await browser.close();
