// screenshot.mjs — VERIFY in the user's real condition, not a clean one.
// Reproduces three scenarios in a real browser and reads the on-screen COH.
// The hostel's official COH was updated to ₱42,800 (sheet now runs Feb 1 → Jun 2).
//   1. UPGRADE: a browser already on the OLD official data (version coh58800,
//      showing ₱58,800 in IndexedDB) → bumped version must re-provision to ₱42,800.
//   2. PERSIST: after sign-in, a reload must keep the user signed in.
//   3. FRESH:   an empty browser must auto-provision the real records → ₱42,800.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire('c:/Users/johns/OneDrive/Documents/GitHub/Experience Organizer/');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:4173';
const EXPECT = '₱42,800.00';
const EXPECT_OP = '₱43,800.00';                   // baseline 42,800 + one operational +1,000 deposit
const CURRENT_VERSION = '2026-06-03-coh42800-mgr'; // must match OFFICIAL_DATA_VERSION in main.js
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
// Write an instance ALREADY on the OLD official data (version coh58800, COH ₱58,800)
// straight into IndexedDB — the user's actual condition before this update.
async function injectOldOfficialInstance(page) {
  await page.evaluate(async () => {
    const z = '0'.repeat(64);
    const state = {
      version: 1,
      config: { brand: 'Frendz Hostel El Nido', currency: 'PHP', beginningBalance: 47100, setupComplete: true, officialDataVersion: '2026-06-02-coh58800', managerPin: 'demo$demo', staffPin: null, requireStaffPin: false, createdAt: '2026-02-01T00:00:00.000Z', github: { owner: '', repo: '', branch: 'main', path: 'data/ledger-backup.json', enabled: false } },
      itemTypes: [
        { id: 'item_towel', name: 'Towel', defaultAmount: 200, sortOrder: 0, active: true, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'item_pad', name: 'Padlock', defaultAmount: 100, sortOrder: 1, active: true, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'item_hd', name: 'Hair Dryer', defaultAmount: 500, sortOrder: 2, active: true, createdAt: '2026-02-01T00:00:00.000Z' },
      ],
      staff: [], shifts: [],
      // Nets +11,700 → COH = 47,100 + 11,700 = 58,800 (the OLD official figure).
      ledger: [
        { seq: 1, id: 'old1', ts: '2026-02-03T09:00:00', kind: 'deposit', itemTypeId: 'item_towel', itemName: 'Towel', qty: 1, unitAmount: 8215, amount: 8215, direction: 1, guest: 'IMPORT', room: '', pax: null, shiftId: null, shiftLabel: null, businessDate: '2026-02-03', staff: 'import', staffRole: 'system', note: 'old import', reversesId: null, prevHash: z, hash: 'oldhash1' },
        { seq: 2, id: 'oldadj', ts: '2026-06-02T10:00:00', kind: 'adjustment', itemTypeId: null, itemName: 'Adjustment', qty: null, unitAmount: 3485, amount: 3485, direction: 1, guest: '', room: '', pax: null, shiftId: null, shiftLabel: null, businessDate: '2026-06-02', staff: 'system', staffRole: 'system', note: 'Reconciliation to official COH ₱58,800.00', reversesId: null, prevHash: z, hash: 'oldhash2' },
      ],
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
// Instance with a baseline (→ COH ₱42,800) PLUS one OPERATIONAL deposit a clerk
// entered (staffRole 'manager', +₱1,000 → COH ₱43,800). `version` lets us test
// both a current-version close/reopen and a stale-version reload (the guard).
async function injectInstanceWithUserEntry(page, version) {
  await page.evaluate(async (ver) => {
    const z = '0'.repeat(64);
    const E = (o) => Object.assign({ ts: '2026-06-02T10:00:00', itemTypeId: 'item_towel', itemName: 'Towel', qty: null, unitAmount: 0, amount: 0, direction: 1, guest: '', room: '', pax: null, shiftId: null, shiftLabel: null, businessDate: '2026-06-02', note: '', reversesId: null, prevHash: z, hash: 'h' + Math.random() }, o);
    const state = {
      version: 1,
      config: { brand: 'Frendz Hostel El Nido', currency: 'PHP', beginningBalance: 47100, setupComplete: true, officialDataVersion: ver, managerPin: 'demo$demo', staffPin: null, requireStaffPin: false, createdAt: '2026-02-01T00:00:00.000Z', github: { owner: '', repo: '', branch: 'main', path: 'data/ledger-backup.json', enabled: false } },
      itemTypes: [{ id: 'item_towel', name: 'Towel', defaultAmount: 200, sortOrder: 0, active: true, createdAt: '2026-02-01T00:00:00.000Z' }],
      staff: [], shifts: [],
      ledger: [
        E({ seq: 1, id: 'imp', kind: 'deposit', amount: 8215, direction: 1, guest: 'IMPORT', staff: 'import', staffRole: 'system', note: 'bootstrap import' }),
        E({ seq: 2, id: 'adj', kind: 'adjustment', itemTypeId: null, itemName: 'Adjustment', amount: 12515, direction: -1, staff: 'system', staffRole: 'system', note: 'bootstrap reconcile' }),
        E({ seq: 3, id: 'op1', kind: 'deposit', amount: 1000, direction: 1, guest: 'WALK-IN GUEST', room: '305', staff: 'Darren', staffRole: 'manager', note: 'operational entry' }),
      ],
      audit: [],
    };
    await new Promise((res, rej) => {
      const r = indexedDB.open('fdtt', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => { const db = r.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(state, 'state'); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
      r.onerror = () => rej(r.error);
    });
  }, version);
}
async function signInStaff(page) {
  await page.waitForSelector('.lockcard input:not([type=password])', { timeout: 25000 }).catch(() => {});
  if (await page.$('.lockcard input:not([type=password])')) {
    await page.evaluate(() => { const n = document.querySelector('.lockcard input:not([type=password])'); n.value = 'john'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    await clickText(page, 'Sign in');
    await page.waitForSelector('.sidebar', { timeout: 12000 }).catch(() => {});
  }
}
async function signInManager(page, name, pin) {
  await page.waitForSelector('.lockcard input:not([type=password])', { timeout: 20000 }).catch(() => {});
  await clickText(page, 'Manager');     // reveals the PIN field
  await sleep(150);
  await page.evaluate((nm, pn) => {
    const card = document.querySelector('.lockcard');
    const nameI = card.querySelector('input:not([type=password])');
    const pinI = card.querySelector('input[type=password]');
    if (nameI) { nameI.value = nm; nameI.dispatchEvent(new Event('input', { bubbles: true })); }
    if (pinI) { pinI.value = pn; pinI.dispatchEvent(new Event('input', { bubbles: true })); }
  }, name, pin);
  await clickText(page, 'Sign in');
  await page.waitForSelector('.sidebar', { timeout: 8000 }).catch(() => {});
}
async function signInStaffWithPin(page, pin) {
  await page.waitForSelector('.lockcard input:not([type=password])', { timeout: 20000 }).catch(() => {});
  // staff is the default role; the PIN field shows because staff accounts exist
  await page.evaluate((pn) => {
    const card = document.querySelector('.lockcard');
    const nameI = card.querySelector('input:not([type=password])'); if (nameI) { nameI.value = ''; nameI.dispatchEvent(new Event('input', { bubbles: true })); }
    const pinI = card.querySelector('input[type=password]'); if (pinI) { pinI.value = pn; pinI.dispatchEvent(new Event('input', { bubbles: true })); }
  }, pin);
  await clickText(page, 'Sign in');
  await page.waitForSelector('.sidebar', { timeout: 8000 }).catch(() => {});
}
const readCOH = (page) => page.evaluate(() => { const a = document.querySelector('.coh-hero .amount'); return a ? a.textContent.replace(/\s+/g, ' ').trim() : '(none)'; });
const onDashboard = (page) => page.evaluate(() => !!document.querySelector('.coh-hero'));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));

await page.goto(BASE, NID);

// ── TEST 1: reproduce the user's condition — existing OLD-official instance ──
await clearAll(page);
await injectOldOfficialInstance(page);   // COH ₱58,800 @ version coh58800
await page.reload(NID);                   // bumped version must re-provision
await signInStaff(page);
await sleep(900);
const coh1 = await readCOH(page);
console.log('TEST 1  old-official(58,800) → re-provisions → COH', coh1);
await page.screenshot({ path: `${OUT}/reprovision-to-42800.png` });

// ── TEST 2: session persists across a refresh ───────────────────────────────
await page.reload(NID);
await sleep(1500);
const stillIn = await onDashboard(page);
const coh2 = await readCOH(page);
console.log('TEST 2  reload-stays-signed-in →', stillIn, '| COH', coh2);

// ── TEST 3: a truly fresh browser auto-provisions the real records ───────────
await clearAll(page);
await page.reload(NID);
await signInStaff(page);
await sleep(900);
const coh3 = await readCOH(page);
console.log('TEST 3  fresh-device-provision → COH', coh3);
await page.screenshot({ path: `${OUT}/fresh-provision.png` });

// ── TEST 4: the baked manager PIN is enforced (Darren / 1012) ────────────────
await clearAll(page);
await page.reload(NID);
await signInManager(page, 'Darren', '0000');   // wrong PIN must NOT get in
await sleep(500);
const wrongBlocked = !(await onDashboard(page));
await signInManager(page, 'Darren', '1012');    // correct PIN must get in
await sleep(900);
const mgrIn = await onDashboard(page);
const coh4 = await readCOH(page);
const isManager = await page.evaluate(() => /manager/i.test((document.querySelector('.sidebar') || document.body).innerText));
console.log('TEST 4  manager: wrong-PIN-blocked →', wrongBlocked, '| Darren/1012 →', mgrIn, '(manager:', isManager + ') | COH', coh4);
await page.screenshot({ path: `${OUT}/manager-darren.png` });

// ── TEST 5: a clerk's entry SURVIVES a normal close/reopen (current version) ──
await clearAll(page);
await injectInstanceWithUserEntry(page, CURRENT_VERSION);   // COH ₱43,800, op-entry present
await page.reload(NID);                                     // = "close & reopen the website"
await signInStaff(page);
await sleep(900);
const coh5 = await readCOH(page);
const opKept5 = await page.evaluate(() => /walk-in guest/i.test(document.body.innerText));
console.log('TEST 5  close/reopen keeps user entry → COH', coh5, '| op-entry visible:', opKept5);

// ── TEST 6: a clerk's entry SURVIVES even a stale data-version reload (guard) ─
await clearAll(page);
await injectInstanceWithUserEntry(page, '2026-06-02-coh42800');  // OLDER version + real entry
await page.reload(NID);                                          // guard must NOT wipe it
await signInStaff(page);
await sleep(900);
const coh6 = await readCOH(page);
const opKept6 = await page.evaluate(() => /walk-in guest/i.test(document.body.innerText));
console.log('TEST 6  stale-version guard keeps user entry → COH', coh6, '| op-entry visible:', opKept6);
await page.screenshot({ path: `${OUT}/operation-ready.png` });

// ── TEST 7: manager adds a staff account; staff signs in with NO admin access ─
await clearAll(page);
await page.reload(NID);
await signInManager(page, 'Darren', '1012');     // fresh device → manager
await sleep(700);
await page.evaluate(() => { const b = [...document.querySelectorAll('.navbtn')].find((x) => /settings/i.test(x.innerText)); if (b) b.click(); });
await sleep(500);
await page.evaluate(() => {                        // fill the "Add staff" form by placeholder
  const name = [...document.querySelectorAll('input')].find((i) => /staff name/i.test(i.placeholder || ''));
  const pin = [...document.querySelectorAll('input')].find((i) => /^PIN \(4-6/i.test(i.placeholder || ''));
  if (name) { name.value = 'Maria'; name.dispatchEvent(new Event('input', { bubbles: true })); }
  if (pin) { pin.value = '2024'; pin.dispatchEvent(new Event('input', { bubbles: true })); }
});
await clickText(page, 'Add staff');
await sleep(500);
const rosterHasMaria = await page.evaluate(() => /maria/i.test(document.body.innerText));
await clickText(page, 'Sign out');
await sleep(400);
await signInStaffWithPin(page, '2024');           // the new staff's own PIN
await sleep(700);
const staffIn = await onDashboard(page);
const staffName = await page.evaluate(() => ((document.querySelector('.side-foot .who') || {}).textContent || '').trim());
const noAdminNav = await page.evaluate(() => ![...document.querySelectorAll('.navbtn')].some((b) => /settings|activity/i.test(b.innerText)));
console.log('TEST 7  add-staff → staff login: in:', staffIn, '| name:', staffName, '| roster has Maria:', rosterHasMaria, '| staff sees NO admin nav:', noAdminNav);
await page.screenshot({ path: `${OUT}/staff-no-admin.png` });

const pass = coh1 === EXPECT && stillIn && coh2 === EXPECT && coh3 === EXPECT
  && wrongBlocked && mgrIn && isManager && coh4 === EXPECT
  && coh5 === EXPECT_OP && opKept5 && coh6 === EXPECT_OP && opKept6
  && rosterHasMaria && staffIn && /maria/i.test(staffName) && noAdminNav;
console.log(pass
  ? `\nALL PASS ✓ — COH ${EXPECT}; manager PIN enforced; entries persist; staff accounts work + staff locked out of admin`
  : `\nFAIL ✗ — see values above`);
await browser.close();
process.exit(pass ? 0 : 1);
