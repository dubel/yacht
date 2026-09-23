// Evaluate an expression in the running game: node tools/probe.mjs "?query" "expr"
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=vulkan','--enable-features=Vulkan'] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 450 });
await page.goto('http://localhost:5173/' + process.argv[2], { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 6000));
console.log(await page.evaluate(process.argv[3]));
await browser.close();
