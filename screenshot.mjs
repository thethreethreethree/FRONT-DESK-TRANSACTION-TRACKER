// screenshot.mjs — drive the app with headless Chrome and capture each view.
// Uses puppeteer-core (borrowed from a sibling project) + installed Chrome.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire('c:/Users/johns/OneDrive/Documents/GitHub/Experience Organizer/');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = './temporary screenshots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickText(page, text) {
  const h = await page.evaluateHandle((t) => {
    const els = [...document.querySelectorAll('button')];
    return els.find((e) => e.textContent.replace(/\s+/g, ' ').trim().includes(t));
  }, text);
  const el = h.asElement();
  if (el) { await el.click(); return true; }
  return false;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));

// fresh start
await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle2' });
await sleep(400);

// ---- setup screen ----
await page.waitForSelector('.lockcard', { timeout: 5000 });
await page.evaluate(() => {
  const inputs = document.querySelectorAll('.lockcard input[type=password]');
  const set = (i, v) => { const e = inputs[i]; if (!e) return; e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  set(0, '1234'); set(1, '1234');
});
await sleep(150);
await page.screenshot({ path: `${OUT}/00-setup.png` });
await clickText(page, 'Create front desk');
await page.waitForSelector('.sidebar', { timeout: 6000 });
await sleep(600);

const views = [
  ['dashboard', '01-dashboard'],
  ['deposit', '02-deposit'],
  ['refund', '03-refund'],
  ['outstanding', '04-outstanding'],
  ['ledger', '05-ledger'],
  ['shifts', '06-shifts'],
  ['settings', '07-settings'],
];
for (const [view, name] of views) {
  await page.click(`[data-view="${view}"]`);
  await sleep(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
}

// COH sanity read from dashboard
await page.click('[data-view="dashboard"]');
await sleep(300);
const coh = await page.evaluate(() => {
  const a = document.querySelector('.coh-hero .amount');
  return a ? a.textContent.trim() : '(not found)';
});
console.log('Dashboard COH =', coh);

await browser.close();
console.log('done');
