// screenshot.mjs — VERIFY in the user's real condition, not a clean one.
// Reproduces three scenarios in a real browser and reads the on-screen COH:
//   1. UPGRADE: a browser already holding a demo instance in IndexedDB (the exact
//      state that kept showing ₱7,200) → new build must converge to ₱58,800.
//   2. PERSIST: after sign-in, a reload must keep the user signed in.
//   3. FRESH:   an empty browser must auto-provision the real records → ₱58,800.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire('c:/Users/johns/OneDrive/Documents/GitHub/Experience Organizer/');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = './temporary screenshots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NID = { waitUntil: 'networkidle2' };

async function clickText(page, text) {
  const h = await page.evaluateHandle((t) => [...document.querySelectorAll('button')]
    .find((e) => e.textContent.replace(/\s+/g, ' ').trim().includes(t)), text);
  const el = h.asElement();
  if (el) { await el.click(); return true; }
  return false;
}
async function clearAll(page) {
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((res) => { const r = indexedDB.deleteDatabase('fdtt'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  });
}
// Write a pre-existing DEMO instance straight into IndexedDB — this is the user's
// failing condition (set up, small demo ledger, COH ₱7,200, no official data).
async function injectDemoInstance(page) {
  await page.evaluate(async () => {
    const z = '0'.repeat(64);
    const state = {
      version: 1,
      config: { brand: 'Frendz Hostel El Nido', currency: 'PHP', beginningBalance: 0, setupComplete: true, managerPin: 'demo$demo', staffPin: null, requireStaffPin: false, createdAt: '2026-02-01T00:00:00.000Z', github: { owner: '', repo: '', branch: 'main', path: 'data/ledger-backup.json', enabled: false } },
      itemTypes: [
        { id: 'item_towel', name: 'Towel', defaultAmount: 200, sortOrder: 0, active: true, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'item_pad', name: 'Padlock', defaultAmount: 100, sortOrder: 1, active: true, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'item_hd', name: 'Hair Dryer', defaultAmount: 500, sortOrder: 2, active: true, createdAt: '2026-02-01T00:00:00.000Z' },
      ],
      staff: [], shifts: [],
      ledger: [{ seq: 1, id: 'demo1', ts: '2026-02-03T09:00:00', kind: 'deposit', itemTypeId: 'item_towel', itemName: 'Towel', qty: 36, unitAmount: 200, amount: 7200, direction: 1, guest: 'Demo Guest', room: '101', pax: null, shiftId: null, shiftLabel: 'AM', businessDate: '2026-02-03', staff: 'demo', staffRole: 'system', note: 'demo seed', reversesId: null, prevHash: z, hash: 'demohash' }],
      audit: [],
    };
    await new Promise((res, rej) => {
      const r = indexedDB.open('fdtt', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => { const db = r.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(state, 'state'); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
      r.onerror = () => rej(r.error);
    });
  });
}
async function signInStaff(page) {
  // Wait for the LOGIN card (has a non-password name input) — not the splash.
  await page.waitForSelector('.lockcard input:not([type=password])', { timeout: 25000 }).catch(() => {});
  if (await page.$('.lockcard input:not([type=password])')) {
    await page.evaluate(() => { const n = document.querySelector('.lockcard input:not([type=password])'); n.value = 'john'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    await clickText(page, 'Sign in');
    await page.waitForSelector('.sidebar', { timeout: 12000 }).catch(() => {});
  }
}
const readCOH = (page) => page.evaluate(() => { const a = document.querySelector('.coh-hero .amount'); return a ? a.textContent.replace(/\s+/g, ' ').trim() : '(none)'; });
const onDashboard = (page) => page.evaluate(() => !!document.querySelector('.coh-hero'));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));

await page.goto(BASE, NID);

// ── TEST 1: reproduce the user's condition — existing DEMO instance ───────────
await clearAll(page);
await injectDemoInstance(page);
await page.reload(NID);            // new build loads, sees the demo state
await signInStaff(page);          // ensureProvisioned upgrades during mount, then login
await sleep(800);
const coh1 = await readCOH(page);
console.log('TEST 1  upgrade-from-demo  → COH', coh1);
await page.screenshot({ path: `${OUT}/upgrade-from-demo.png` });

// ── TEST 2: session persists across a refresh ────────────────────────────────
await page.reload(NID);
await sleep(1500);
const stillIn = await onDashboard(page);
const coh2 = await readCOH(page);
console.log('TEST 2  reload-stays-signed-in →', stillIn, '| COH', coh2);

// ── TEST 3: a truly fresh browser auto-provisions the real records ────────────
await clearAll(page);
await page.reload(NID);
await signInStaff(page);
await sleep(800);
const coh3 = await readCOH(page);
console.log('TEST 3  fresh-device-provision → COH', coh3);
await page.screenshot({ path: `${OUT}/fresh-provision.png` });

const pass = coh1 === '₱58,800.00' && stillIn && coh2 === '₱58,800.00' && coh3 === '₱58,800.00';
console.log(pass ? '\nALL PASS ✓ — converges to ₱58,800 in the real failing condition' : '\nFAIL ✗ — see values above');
await browser.close();
process.exit(pass ? 0 : 1);
