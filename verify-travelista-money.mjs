// Adversarial check on the correction/reversal bug: walk every neighbouring path
// and assert the FULL set of money invariants after every single step.
import { createRequire } from 'node:module';
const require = createRequire('c:/Users/johns/OneDrive/Documents/GitHub/Experience Organizer/');
const puppeteer = require('puppeteer-core');
const B=process.env.BASE||'http://localhost:4173';
let bad=0; const ok=(n,c,e='')=>{ if(c) console.log(`  PASS  ${n}${e?' · '+e:''}`); else {bad++; console.log(`  FAIL  ${n}${e?' · '+e:''}`);} };
const br=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',args:['--no-sandbox']});
const p=await br.newPage();
p.on('pageerror',e=>{bad++;console.log('  PAGE EXCEPTION:',e.message)});
await p.goto(B,{waitUntil:'networkidle2'});
await p.evaluate(async()=>{localStorage.clear();await new Promise(r=>{const q=indexedDB.deleteDatabase('fdtt');q.onsuccess=q.onerror=q.onblocked=()=>r()})});

const run = await p.evaluate(async () => {
  const { store } = await import('./app/store.js');
  const { tv } = await import('./app/travelista.js');
  store.useLocation('beachfront'); await store.load();
  store.state.config.setupComplete = true;
  store.session = { role:'manager', name:'INV' };
  tv.ensureSeed(); tv.addBooker('INV');
  const dest = tv.activeDestinations()[0];
  const steps = [];
  const r2 = n => Math.round((n+Number.EPSILON)*100)/100;

  // Every invariant that must hold, at every moment.
  const check = (label) => {
    const t = tv.totals(), rec = tv.reconciliation(), cash = tv.cash();
    const derived = r2(rec.beginning + t.collected - t.paidOut + t.adjustments);
    steps.push({
      label,
      cashMatchesEntries: Math.abs(derived - cash) < 0.005,
      balances: rec.balances,
      splitExact: Math.abs(r2(t.share + t.commission) - t.collected) < 0.005,
      chain: tv.integrity.ok,
      cash, collected: t.collected, share: t.share, commission: t.commission, adj: t.adjustments,
    });
  };

  const book = (guest, pax) => tv.addBooking({ departureDate:'2026-09-06', guest, destinationId:dest.id, pax, bookedBy:'INV' });
  check('baseline');

  // 1 — correction that INCREASES the money, then void it
  const b1 = book('UP', 1);
  const a1 = tv.amendBooking(b1.seq, { total: b1.total + 900, commission: b1.commission + 90 }, 'up');
  check('after an increasing correction');
  tv.reverse(a1.id, 'undo');
  check('after voiding an increasing correction');

  // 2 — correction that DECREASES the money, then void it
  const b2 = book('DOWN', 2);
  const a2 = tv.amendBooking(b2.seq, { total: r2(b2.total - 400), commission: r2(b2.commission - 40) }, 'down');
  check('after a decreasing correction');
  tv.reverse(a2.id, 'undo');
  check('after voiding a decreasing correction');

  // 3 — correction with NO money change at all
  const b3 = book('NAMEONLY', 1);
  const a3 = tv.amendBooking(b3.seq, { guest: 'NAME FIXED' }, 'typo');
  check('after a name-only correction');
  tv.reverse(a3.id, 'undo');
  check('after voiding a name-only correction');

  // 4 — TWO corrections stacked, voided newest-first
  const b4 = book('STACK', 1);
  const s1 = tv.amendBooking(b4.seq, { total: b4.total + 500, commission: b4.commission + 50 }, 'first');
  const s2 = tv.amendBooking(b4.seq, { total: b4.total + 1200, commission: b4.commission + 120 }, 'second');
  check('after two stacked corrections');
  const stackedReading = tv.effective(tv.entryBySeq(b4.seq)).total;
  tv.reverse(s2.id, 'undo second');
  check('after voiding the second');
  const afterSecondVoid = tv.effective(tv.entryBySeq(b4.seq)).total;
  tv.reverse(s1.id, 'undo first');
  check('after voiding the first too');
  const afterBothVoid = tv.effective(tv.entryBySeq(b4.seq)).total;

  // 5 — void the BOOKING while a correction stands on it
  const beforeB5 = { cash: tv.cash(), collected: tv.totals().collected, commission: tv.totals().commission };
  const b5 = book('VOIDME', 1);
  tv.amendBooking(b5.seq, { total: b5.total + 300, commission: b5.commission + 30 }, 'bump');
  check('booking with a live correction');
  tv.reverse(b5.id, 'void the booking itself');
  check('after voiding the corrected booking');
  const afterB5 = { cash: tv.cash(), collected: tv.totals().collected, commission: tv.totals().commission };

  // 6 — reconcile, then void the reconciliation
  const adj = tv.reconcileCash(r2(tv.cash() - 777.25), { reason:'count short', staffInvolved:'INV', refSeq:'1' });
  check('after a cash-box reconciliation');
  tv.reverse(adj.id, 'undo the reconciliation');
  check('after voiding the reconciliation');

  // 7 — amend again after a previous amendment was voided
  const a7 = tv.amendBooking(b1.seq, { total: b1.total + 250, commission: b1.commission + 25 }, 'again');
  check('after re-correcting a booking whose earlier correction was voided');

  return { steps, stack: { stackedReading, afterSecondVoid, afterBothVoid, base: b4.total },
    voidCascade: { beforeB5, afterB5 } };
});

console.log('\nEvery invariant, after every step:\n');
for (const s of run.steps) {
  const all = s.cashMatchesEntries && s.balances && s.splitExact && s.chain;
  ok(s.label, all, all ? `₱${s.cash} · collected ₱${s.collected} · adj ₱${s.adj}`
    : `cash-matches=${s.cashMatchesEntries} balances=${s.balances} split=${s.splitExact} chain=${s.chain} (cash ₱${s.cash}, collected ₱${s.collected})`);
}
console.log('\nStacked corrections read back correctly:');
ok('two corrections → the latest wins', run.stack.stackedReading === run.stack.base + 1200, `₱${run.stack.stackedReading}`);
ok('voiding the latest falls back to the first', run.stack.afterSecondVoid === run.stack.base + 500, `₱${run.stack.afterSecondVoid}`);
ok('voiding both returns the original figure', run.stack.afterBothVoid === run.stack.base, `₱${run.stack.afterBothVoid}`);
console.log('');
console.log('Voiding a booking must take its correction with it:');
const vc = run.voidCascade;
ok('cash returns to exactly what it was before the booking', vc.afterB5.cash === vc.beforeB5.cash, vc.beforeB5.cash + ' -> ' + vc.afterB5.cash);
ok('takings return too, no money left behind', vc.afterB5.collected === vc.beforeB5.collected, vc.beforeB5.collected + ' -> ' + vc.afterB5.collected);
ok('and the commission with it', vc.afterB5.commission === vc.beforeB5.commission, vc.beforeB5.commission + ' -> ' + vc.afterB5.commission);
console.log(bad?`\n${bad} CHECK(S) FAILED\n`:'\nNO IMBALANCE FOUND IN ANY PATH\n');
await br.close(); process.exit(bad?1:0);
