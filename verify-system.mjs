// verify-system.mjs — the standing regression for the whole app, both buildings.
//
// Lives in the repo on purpose: the earlier per-feature suites were written to a
// temp directory and were repeatedly cleared away, so the coverage had to be
// rebuilt from scratch each time. Run it before shipping anything.
//
//   node verify-system.mjs                                  (against localhost:4173)
//   BASE=https://<pages-url>/ node verify-system.mjs        (against the live site)
import { createRequire } from 'node:module';
const require = createRequire('c:/Users/johns/OneDrive/Documents/GitHub/Experience Organizer/');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:4173';
const NID = { waitUntil: 'networkidle2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}${e ? ' · ' + e : ''}`); else { bad++; console.log(`  FAIL  ${n}${e ? ' · ' + e : ''}`); } };
const section = (t) => console.log(`\n${t}`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push('EXCEPTION: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/favicon|net::ERR_|Failed to load resource/.test(t)) errors.push('CONSOLE: ' + t); } });

const click = async (t, s = 'button') => {
  const h = await page.evaluateHandle((t, s) => [...document.querySelectorAll(s)]
    .find((e) => e.textContent.replace(/\s+/g, ' ').trim().includes(t)), t, s);
  const el = h.asElement();
  if (el) { await el.click(); return true; }
  return false;
};
// A signed-in session persists PER BUILDING by design, so it must be cleared or
// the login screen never appears and the next check measures the previous person.
const forget = () => page.evaluate(() => {
  try {
    localStorage.removeItem('fdtt_location');
    localStorage.removeItem('fdtt_session');
    localStorage.removeItem('fdtt_session_beachfront');
    localStorage.removeItem('fdtt_system');
  } catch (e) { /* private mode */ }
});

async function open(building, name = 'Darren', pin = '1012') {
  await forget();
  await page.goto(BASE, NID);
  await page.waitForSelector('.lockcard', { timeout: 60000 });
  await sleep(1200);
  await click(building, '.syscard');
  // Main restores a ~17 MB record, so allow generously.
  await page.waitForFunction(
    () => !!document.querySelector('.lockcard .role-toggle') || !!document.querySelector('.sysgrid .syscard'),
    { timeout: 180000, polling: 500 });
  await sleep(2500);
  if (await page.evaluate(() => !!document.querySelector('.lockcard .role-toggle'))) {
    await click('Admin');
    await page.type('.lockcard input.input', name);
    await page.type('.lockcard input[type=password]', pin);
    await click('Sign in');
    await sleep(1500);
    // an issued credential offers a change on first sign-in — decline and move on
    if (await page.evaluate(() => !!document.querySelector('.modal'))) {
      await click('Keep the one I was given', '.modal button');
    }
  }
  await page.waitForSelector('.sysgrid .syscard', { timeout: 60000 });
}
async function intoSystem(system) {
  await click(system, '.syscard');
  await page.waitForSelector('.nav', { timeout: 30000 });
  await sleep(800);
}
async function walkScreens(labels) {
  for (const label of labels) {
    errors.length = 0;
    if (!await click(label, '.nav button')) { bad++; console.log(`  FAIL  nav item missing: ${label}`); continue; }
    await sleep(1100);
    const crashed = await page.evaluate(() => !!document.querySelector('#main-view pre'));
    ok(label, !crashed && errors.length === 0, crashed ? 'view threw' : (errors[0] || ''));
  }
}

const TOWEL_MAIN = ['Dashboard', 'New Deposit', 'New Refund', 'Towel Exchange', 'Outstanding', 'Ledger', 'Passports', 'Private Rooms', 'Towel Tracker', 'Shifts', 'Activity Log', 'Settings'];
const TOWEL_BF = TOWEL_MAIN.map((l) => (l === 'Passports' ? 'IDs Held' : l));
const TRAVEL = ['Dashboard', 'New Booking', 'Booking Sheet', 'Remit & Payouts', 'Reports', 'Activity Log', 'Settings'];

await page.goto(BASE, NID);
await page.evaluate(async () => {
  localStorage.clear();
  await new Promise((r) => { const q = indexedDB.deleteDatabase('fdtt'); q.onsuccess = q.onerror = q.onblocked = () => r(); });
});

// ─────────────────────────────────────────────────────────── MAIN
section('MAIN · every screen renders');
await open('Frendz Hostel Main');
await intoSystem('Towel Management');
await walkScreens(TOWEL_MAIN);
await click('Switch', '.sysbadge');
await intoSystem('Travelista Management');
await walkScreens(TRAVEL);

section('MAIN · the money invariants');
const M = await page.evaluate(async () => {
  const { store } = await import('./app/store.js');
  const { tv } = await import('./app/travelista.js');
  const gap = () => { const r = store.reconciliation(); return Math.abs((r.beginning || 0) + r.held - r.over + (r.adjustments || 0) - r.coh); };
  const item = store.activeItems()[0];
  const o = { coh0: store.coh(), n: store.ledger.length };
  // zero-cash paths must move nothing at either end
  const pr = store.addDeposit({ itemTypeId: item.id, qty: 1, unitAmount: 1000, amount: 0, guest: 'VS PR', room: 'R1', towelNo: '9911', privateRoom: true });
  o.hold = store.coh();
  store.checkoutPrivateRoom(pr.seq);
  o.out = store.coh();
  o.twice = store.checkoutPrivateRoom(pr.seq);
  const pp = store.addDeposit({ itemTypeId: item.id, qty: 1, unitAmount: 1000, amount: 0, guest: 'VS PP', room: 'P1', mewsRes: 'RES-VS' });
  store.returnPassport(pp.seq);
  o.afterPassport = store.coh();
  // a cash deposit and its refund cancel out
  const d = store.addDeposit({ itemTypeId: item.id, qty: 1, unitAmount: 1000, amount: 1000, guest: 'VS CASH', room: 'C1' });
  o.afterDeposit = store.coh();
  const r1 = store.addRefund({ itemTypeId: item.id, qty: 1, unitAmount: 1000, amount: 1000, guest: 'VS CASH', room: 'C1', refundsSeq: d.seq });
  o.afterRefund = store.coh();
  store.reverse(r1.id, 'verify');
  o.afterVoidRefund = store.coh();
  o.doubleVoid = store.reverse(r1.id, 'again');
  // travelista splits and voids cleanly
  const t0 = tv.reconciliation();
  const bk = tv.addBooking({ departureDate: '2026-09-02', guest: 'VS BOOK', destinationId: tv.activeDestinations()[0].id, pax: 1, bookedBy: 'GINO' });
  const t1 = tv.reconciliation();
  o.split = Math.abs((t1.payable - t0.payable) - bk.travelistaShare) < 0.005 && Math.abs((t1.commissionHeld - t0.commissionHeld) - bk.commission) < 0.005;
  tv.reverse(bk.id, 'verify');
  const t2 = tv.reconciliation();
  o.tvVoided = Math.abs(t2.cash - t0.cash) < 0.005 && t2.balances;
  o.gap = gap();
  o.chains = store.verifyIntegrity().ok && store.verifyAuditIntegrity().ok && store.verifyTravelistaIntegrity().ok;
  return o;
});
ok('a private-room hold takes no cash', M.hold === M.coh0, `₱${M.coh0.toLocaleString()}`);
ok('…and neither does its check-out', M.out === M.coh0);
ok('checking out twice is refused', M.twice === null);
ok('a passport hold and its return take no cash', M.afterPassport === M.coh0);
ok('a cash deposit raises COH by its amount', M.afterDeposit === M.coh0 + 1000);
ok('…its refund gives it back', M.afterRefund === M.coh0);
ok('…and voiding that refund re-takes it', M.afterVoidRefund === M.coh0 + 1000);
ok('the same entry cannot be voided twice', M.doubleVoid === null);
ok('a booking splits into share + commission', M.split);
ok('voiding a booking backs it all out', M.tvVoided);
ok('cash reconciles exactly', M.gap < 0.01, `gap ${M.gap}`);
ok('all three chains verify', M.chains);

section('MAIN · who can sign in, and as what');
const A = await page.evaluate(async () => {
  const { store } = await import('./app/store.js');
  const t = (role, pin) => { store.session = null; const r = store.login(role, pin, 'typed'); return { r, name: store.session && store.session.name, role: store.session && store.session.role, admin: store.isManager() }; };
  const o = {};
  o.adminTab = t('manager', '1012');
  o.staffTabWithAdminPin = t('staff', '1012');      // must NOT downgrade to staff
  o.gino = t('manager', 'Tinomoliona24.');
  o.ginoStaffTab = t('staff', 'Tinomoliona24.');
  o.wrong = t('manager', '0000');
  o.gate = { shared: store.verifyAdminPin('1012'), gino: store.verifyAdminPin('Tinomoliona24.'), junk: store.verifyAdminPin('0000') };
  o.rosters = { admins: store.adminList().map((a) => a.name), staff: store.staffList().map((s) => s.name) };
  const first = store.staffList()[0];
  if (first) { store.setStaffPin(first.id, '4321'); o.staff = t('staff', '4321'); o.staffName = first.name; }
  return o;
});
ok('the shared admin PIN gives Admin', A.adminTab.admin);
ok('…from the Staff tab too', A.staffTabWithAdminPin.admin, `${A.staffTabWithAdminPin.name} · ${A.staffTabWithAdminPin.role}`);
ok('GINO signs in as Admin', A.gino.admin && A.gino.name === 'GINO', `${A.gino.name} · ${A.gino.role}`);
ok('…from the Staff tab too', A.ginoStaffTab.admin);
ok('a wrong PIN is refused', A.wrong.r === false);
ok('the admin-approval gate accepts admins and rejects others', A.gate.shared && A.gate.gino && !A.gate.junk);
ok('GINO is no longer on the staff roster', !A.rosters.staff.map((s) => s.toUpperCase()).includes('GINO'), A.rosters.staff.join(', '));
ok('a real staff PIN still gives a STAFF session', !A.staff || (A.staff.role === 'staff' && !A.staff.admin && A.staff.name === A.staffName), A.staff ? `${A.staff.name} · ${A.staff.role}` : 'no staff');

const mainSnapshot = await page.evaluate(async () => {
  const { store } = await import('./app/store.js');
  return { coh: store.coh(), n: store.ledger.length, integ: store.verifyIntegrity().ok };
});

// ─────────────────────────────────────────────────────────── BEACHFRONT
section('BEACHFRONT · every screen renders');
await open('Frendz Hostel Beachfront');
await intoSystem('Towel Management');
await walkScreens(TOWEL_BF);
await click('Switch', '.sysbadge');
await intoSystem('Travelista Management');
await walkScreens(TRAVEL);

section('BEACHFRONT · isolation and its own setup');
const B = await page.evaluate(async () => {
  const { store } = await import('./app/store.js');
  const { tv } = await import('./app/travelista.js');
  const item = store.activeItems()[0];
  store.addDeposit({ itemTypeId: item.id, qty: 1, unitAmount: 300, amount: 300, guest: 'BF ONLY', room: 'B1', towelNo: '55' });
  tv.addBooker('BF BOOKER');
  tv.addBooking({ departureDate: '2026-09-02', guest: 'BF BOOKING', destinationId: tv.activeDestinations()[0].id, pax: 1, bookedBy: 'BF BOOKER' });
  return { path: (store.config.github || {}).path, items: store.activeItems().map((i) => i.name),
    admins: store.adminList().map((a) => a.name), coh: store.coh(),
    bookings: tv.entries.filter((e) => e.kind === 'booking').length,
    ownRecords: store.hasOwnRecords(), integ: store.verifyIntegrity().ok, tvi: store.verifyTravelistaIntegrity().ok };
});
ok('it writes to its OWN backup file', B.path === 'data/beachfront-backup.json', B.path);
ok('it has its own five deposit items', B.items.length === 5, B.items.join(' · '));
ok('GINO and Louise are admins here too', B.admins.includes('GINO') && B.admins.includes('Louise'), B.admins.join(', '));
ok('a device holding bookings is NOT treated as blank', B.ownRecords);
ok('both chains verify', B.integ && B.tvi, `₱${B.coh} · ${B.bookings} booking(s)`);

section('MAIN · untouched by everything done at the Beachfront');
await open('Frendz Hostel Main');
const M2 = await page.evaluate(async () => {
  const { store } = await import('./app/store.js');
  return { coh: store.coh(), n: store.ledger.length, integ: store.verifyIntegrity().ok,
    leak: store.ledger.some((e) => String(e.guest || '').startsWith('BF ')) };
});
ok('entry count unchanged', M2.n === mainSnapshot.n, `${mainSnapshot.n} → ${M2.n}`);
ok('COH unchanged to the peso', M2.coh === mainSnapshot.coh, `₱${mainSnapshot.coh.toLocaleString()} → ₱${M2.coh.toLocaleString()}`);
ok('no Beachfront record leaked in', !M2.leak);
ok('the ledger still verifies', M2.integ);

console.log(bad ? `\n${bad} CHECK(S) FAILED\n` : '\nALL CHECKS PASSED\n');
await browser.close();
process.exit(bad ? 1 : 0);
