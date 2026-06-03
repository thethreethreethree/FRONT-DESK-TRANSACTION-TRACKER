// verify-live-data.mjs — confirm the LIVE site is accessible AND presents the
// real, accurate records: not just the COH figure on screen, but the actual
// ledger underneath it (entry counts, beginning balance, real guest names).
import { createRequire } from 'node:module';
const require = createRequire('c:/Users/johns/OneDrive/Documents/GitHub/Experience Organizer/');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'https://thethreethreethree.github.io/FRONT-DESK-TRANSACTION-TRACKER';
const NID = { waitUntil: 'networkidle2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));
await page.goto(BASE, NID);

// reproduce a clean visitor / freshly-cleared device
await page.evaluate(async () => { localStorage.clear(); await new Promise((res) => { const r = indexedDB.deleteDatabase('fdtt'); r.onsuccess = r.onerror = r.onblocked = () => res(); }); });
await page.reload(NID);
await page.waitForSelector('.lockcard input:not([type=password])', { timeout: 25000 }).catch(() => {});
await page.evaluate(() => { const n = document.querySelector('.lockcard input:not([type=password])'); if (n) { n.value = 'audit'; n.dispatchEvent(new Event('input', { bubbles: true })); } const b = [...document.querySelectorAll('button')].find((e) => /sign in/i.test(e.textContent)); if (b) b.click(); });
await page.waitForSelector('.sidebar', { timeout: 15000 }).catch(() => {});
await sleep(1800);

const coh = await page.evaluate(() => { const a = document.querySelector('.coh-hero .amount'); return a ? a.textContent.replace(/\s+/g, ' ').trim() : '(none)'; });
const data = await page.evaluate(async () => {
  const state = await new Promise((res, rej) => { const r = indexedDB.open('fdtt'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('kv', 'readonly'); const g = tx.objectStore('kv').get('state'); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); }; r.onerror = () => rej(r.error); });
  const led = state.ledger || [];
  const sum = (k) => led.filter((e) => e.kind === k).reduce((a, e) => a + (e.amount || 0) * (e.direction || 1), 0);
  return {
    total: led.length,
    deposits: led.filter((e) => e.kind === 'deposit').length,
    refunds: led.filter((e) => e.kind === 'refund').length,
    adjustments: led.filter((e) => e.kind === 'adjustment').length,
    depositSum: sum('deposit'), refundSum: sum('refund'), adjSum: sum('adjustment'),
    beginningBalance: state.config.beginningBalance,
    version: state.config.officialDataVersion,
    sampleGuests: [...new Set(led.filter((e) => e.guest && !/^IMPORT$/i.test(e.guest)).map((e) => e.guest))].slice(0, 6),
  };
});

console.log('LIVE URL          :', BASE);
console.log('COH on screen     :', coh);
console.log('Ledger entries    :', data.total, `(deposits ${data.deposits} / refunds ${data.refunds} / adjustments ${data.adjustments})`);
console.log('Beginning balance :', '₱' + (data.beginningBalance || 0).toLocaleString());
console.log('Deposits total    :', '₱' + Math.round(data.depositSum).toLocaleString());
console.log('Refunds total     :', '₱' + Math.round(data.refundSum).toLocaleString());
console.log('Reconcile adj.    :', '₱' + Math.round(data.adjSum).toLocaleString());
console.log('Check: 47,100 + dep + ref + adj =', '₱' + Math.round(data.beginningBalance + data.depositSum + data.refundSum + data.adjSum).toLocaleString());
console.log('Data version      :', data.version);
console.log('Sample guests     :', data.sampleGuests.join(' | ') || '(none)');
await browser.close();
