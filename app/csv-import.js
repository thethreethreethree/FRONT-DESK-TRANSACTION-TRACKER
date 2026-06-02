// csv-import.js — import the real front-desk spreadsheet (the two-sided
// deposit/refund layout) into the ledger. Validated to reproduce the sheet's
// totals exactly (Deposits 52,660 / Refunds 46,570 / COH 6,090).
//
// Layout (0-indexed columns):
//   0 name(deposit) 1 date/shift 2 towel€ 3 padlock€ 4 hairdryer€
//   6 name(refund)  7 towel€      8 padlock€ 9 hairdryer€

import { sha256, stableStringify } from './util.js';

const GENESIS = '0'.repeat(64);
const YEAR = 2025; // the sheet covers February 2025
const DEP_COLS = [[2, 'Towel'], [3, 'Padlock'], [4, 'Hair Dryer']];
const REF_COLS = [[7, 'Towel'], [8, 'Padlock'], [9, 'Hair Dryer']];
const SHIFT_HOUR = { AM: 9, PM: 16, GY: 23 };

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}

const num = (v) => { if (v == null) return 0; const n = parseFloat(String(v).replace(/[, ]/g, '')); return isNaN(n) ? 0 : n; };
const pad = (n) => String(n).padStart(2, '0');

function parseDateShift(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const dm = t.match(/feb\.?\s*0*(\d{1,2})/);
  let shift = null;
  if (/gy/.test(t)) shift = 'GY';
  else if (/\bpm\b|pm\s*shift|pmshift/.test(t)) shift = 'PM';
  else if (/\bam\b|am\s*shift/.test(t)) shift = 'AM';
  if (!dm && !shift) return null;
  return { day: dm ? +dm[1] : null, shift };
}

function extractGuestRoom(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { guest: '', room: '', pax: null };
  let pax = null;
  const pm = t.match(/(\d+)\s*pax/i);
  if (pm) { pax = +pm[1]; t = t.replace(pm[0], ' '); }
  let room = '';
  const rm = t.match(/(?:rm\.?|room)\s*\.?\s*#?\s*(\d{2,4})/i) || t.match(/#\s*(\d{2,4})/) || t.match(/-\s*(\d{2,4})\b/) || t.match(/\b(\d{3})\b/);
  if (rm) { room = rm[1]; t = t.replace(rm[0], ' '); }
  // strip date/shift words that sometimes share the name cell
  t = t.replace(/feb\.?\s*\d{1,2}/ig, ' ').replace(/\b(am|pm|gy)\b/ig, ' ').replace(/\bshift\b/ig, ' ');
  t = t.replace(/[-#.,/]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { guest: t, room, pax };
}

// Pure parse → ordered list of normalized entries (deposit then refund per row).
export function parseSheet(text) {
  const rows = parseCSV(text);
  let h = rows.findIndex((r) => r.some((c) => /TOWEL DEPOSIT/i.test(c || '')));
  if (h < 0) h = 5; // fall back to the known header position
  const entries = [];
  const dep = { day: 3, shift: 'AM' };
  const ref = { day: 3, shift: 'AM' };
  let skipped = 0;

  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;

    const dMeta = parseDateShift(r[1]);
    if (dMeta) { if (dMeta.day) dep.day = dMeta.day; if (dMeta.shift) dep.shift = dMeta.shift; }
    const rMeta = parseDateShift(r[6]);
    if (rMeta) { if (rMeta.day) ref.day = rMeta.day; if (rMeta.shift) ref.shift = rMeta.shift; }

    for (const [col, item] of DEP_COLS) {
      const amt = num(r[col]);
      if (amt > 0) {
        const gr = extractGuestRoom(r[0]);
        entries.push({ kind: 'deposit', item, amount: amt, guest: gr.guest || '(unlabeled)', room: gr.room, pax: gr.pax, day: dep.day, shift: dep.shift, note: 'Imported from sheet' });
      }
    }
    for (const [col, item] of REF_COLS) {
      const amt = num(r[col]);
      if (amt > 0) {
        const gr = extractGuestRoom(r[6]);
        entries.push({ kind: 'refund', item, amount: amt, guest: gr.guest || '(unlabeled)', room: gr.room, pax: gr.pax, day: ref.day, shift: ref.shift, note: 'Imported from sheet' });
      }
    }
  }

  const deposits = entries.filter((e) => e.kind === 'deposit').reduce((s, e) => s + e.amount, 0);
  const refunds = entries.filter((e) => e.kind === 'refund').reduce((s, e) => s + e.amount, 0);
  return { entries, summary: { count: entries.length, deposits, refunds, coh: deposits - refunds } };
}

// Recompute the whole ledger hash chain after bulk insert/backdate.
function rechain(store) {
  let prev = GENESIS;
  for (const e of store.ledger) {
    const { hash, ...rest } = e;
    rest.prevHash = prev;
    e.prevHash = prev;
    e.hash = sha256(stableStringify(rest));
    prev = e.hash;
  }
}

// Import into the store. replace=true clears existing ledger+shifts first.
export function importSheet(store, text, { replace = true } = {}) {
  const parsed = parseSheet(text);
  store._suppressAudit = true;

  // ensure the three standard items exist; map by name
  const need = [['Towel', 200], ['Padlock', 100], ['Hair Dryer', 500]];
  for (const [name, amt] of need) {
    if (!store.itemTypes.some((it) => it.name === name)) store.addItem({ name, defaultAmount: amt });
  }
  const byName = {}; for (const it of store.activeItems()) byName[it.name] = it;

  if (replace) { store.state.ledger = []; store.state.shifts = []; }

  let idx = 0;
  for (const e of parsed.entries) {
    const item = byName[e.item];
    if (!item) continue;
    const unit = item.defaultAmount;
    const qty = (unit > 0 && e.amount % unit === 0) ? e.amount / unit : 1;
    const unitAmount = qty === 1 ? e.amount : unit;
    const common = { itemTypeId: item.id, qty, unitAmount, amount: e.amount, guest: e.guest, room: e.room, pax: e.pax, note: e.note };
    const created = e.kind === 'deposit' ? store.addDeposit(common) : store.addRefund(common);
    // backdate to the parsed shift/date
    const hour = SHIFT_HOUR[e.shift] || 9;
    const min = idx % 60;
    created.businessDate = `${YEAR}-02-${pad(e.day || 3)}`;
    created.ts = `${created.businessDate}T${pad(hour)}:${pad(min)}:00`;
    created.shiftLabel = e.shift || 'AM';
    idx++;
  }

  rechain(store);
  store._suppressAudit = false;
  store.verifyIntegrity();
  store._audit('data.csv_import',
    `Imported ${parsed.entries.length} entries from spreadsheet · COH ₱${parsed.summary.coh.toLocaleString()}`,
    { count: parsed.entries.length, deposits: parsed.summary.deposits, refunds: parsed.summary.refunds, coh: parsed.summary.coh, replaced: replace });
  store.save();
  return parsed.summary;
}
