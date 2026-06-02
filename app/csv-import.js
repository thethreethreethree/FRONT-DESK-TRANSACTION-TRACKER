// csv-import.js — import the front-desk spreadsheet(s) into the ledger.
//
// Handles BOTH known layouts by auto-detecting columns from the header row
// (the one containing "TOWEL DEPOSIT"):
//   • Original sheet:  name | date | towel€ | padlock€ | hairdryer€ | … | name | towel€ | padlock€ | hairdryer€
//   • TOWEL_2 sheet:   name | towel# | date | towel€ | padlock€ | hairdryer€ | rem | | name | date | towel€ | padlock€ | hairdryer€ | rem
//
// Robustness:
//   • Skips summary/total rows and the header row itself.
//   • Per-column caps drop formula/typo cells (e.g. a 2,000,000 refund) while
//     keeping legitimate large cash moves (transfers up to ₱30k).
//   • Years are inferred by chronological roll-over (starts 2025; +1 when the
//     month sequence wraps, e.g. Dec→Jan). The raw date text is kept on each
//     entry's note so nothing is lost.
//   • Bulk hash-chain build (no per-row save) so tens of thousands of rows import fast.

import { sha256, stableStringify } from './util.js';

const GENESIS = '0'.repeat(64);
const SHIFT_HOUR = { AM: 9, PM: 16, GY: 23 };
const START_YEAR = 2025;
// Per-item sanity caps (pesos). Towel allows large cash transfers; padlock/dryer are small.
const CAP = { Towel: 30000, Padlock: 3000, 'Hair Dryer': 6000 };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}

const num = (v) => {
  if (v == null) return NaN;
  const s = String(v).replace(/[, ]/g, '');
  if (s === '') return NaN;
  return parseFloat(s);
};

function allIndexes(header, re) {
  const out = [];
  header.forEach((c, i) => { if (re.test(String(c || ''))) out.push(i); });
  return out;
}

// Detect the column layout from the header row (or fall back to the TOWEL_2 layout).
function detectColumns(rows) {
  const hi = rows.findIndex((r) => r.some((c) => /TOWEL\s*DEPOSIT/i.test(c || '')));
  if (hi < 0) {
    // default = TOWEL_2 layout
    return { headerIndex: -1, name0: 0, towelNo: 1, date0: 2, t0: 3, p0: 4, h0: 5, rem0: 6, name1: 8, date1: 9, t1: 10, p1: 11, h1: 12, rem1: 13 };
  }
  const H = rows[hi];
  const t0 = H.findIndex((c) => /TOWEL\s*DEPOSIT/i.test(c || ''));
  const p0 = H.findIndex((c) => /PADLOCK\s*DEPOSIT/i.test(c || ''));
  const h0 = H.findIndex((c) => /HAIR\s*DRYER\s*DEPOSIT/i.test(c || ''));
  const t1 = H.findIndex((c) => /TOWEL\s*REFUND/i.test(c || ''));
  const p1 = H.findIndex((c) => /PADLOCK\s*REFUND/i.test(c || ''));
  const h1 = H.findIndex((c) => /HAIR\s*DRYER\s*REFUND/i.test(c || ''));
  const names = allIndexes(H, /NAME\s*&\s*RM/i);
  const dates = allIndexes(H, /DATE\s*&\s*TIME/i);
  const towelNos = allIndexes(H, /TOWEL\s*NUMBER/i);
  const rems = allIndexes(H, /REMARK/i);
  const before = (arr, x) => arr.filter((i) => i < x).pop();
  const after = (arr, x) => arr.find((i) => i > x);
  return {
    headerIndex: hi,
    name0: before(names, t0) ?? 0,
    date0: before(dates, t0) ?? (t0 - 1),
    towelNo: towelNos.find((i) => i < t0) ?? -1,
    t0, p0, h0,
    rem0: rems.find((i) => i > h0 && i < (t1 < 0 ? Infinity : t1)) ?? -1,
    name1: after(names, h0) ?? (h0 + 2),
    date1: (() => { const d = after(dates, h0); return d == null ? -1 : d; })(),
    t1, p1, h1,
    rem1: rems.filter((i) => i > h0).pop() ?? -1,
  };
}

function parseDateShift(text) {
  if (!text) return null;
  const t = String(text).toUpperCase();
  let monthIdx = -1;
  for (let m = 0; m < 12; m++) {
    if (t.includes(MONTHS[m])) { monthIdx = m; break; }
  }
  const dm = t.match(/\b(\d{1,2})\b/);
  let shift = null;
  if (/\bGY\b|GY\s*SHIFT/.test(t)) shift = 'GY';
  else if (/\bPM\b|PMSHIFT|PM\s*SHIFT/.test(t)) shift = 'PM';
  else if (/\bAM\b|AMSHIFT|AM\s*SHIFT/.test(t)) shift = 'AM';
  if (monthIdx < 0 && !shift) return null;
  return { monthIdx, day: dm ? +dm[1] : null, shift };
}

function extractGuestRoom(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { guest: '', room: '', pax: null };
  let pax = null;
  const pm = t.match(/(\d+)\s*PAX/i);
  if (pm) { pax = +pm[1]; t = t.replace(pm[0], ' '); }
  let room = '';
  const rm = t.match(/(?:^|[^0-9])([1-8]\d{2})(?![0-9])/); // 100–899 room number
  if (rm) { room = rm[1]; t = t.replace(rm[1], ' '); }
  t = t.replace(/^[\s\-#./]+|[\s\-#./]+$/g, '').replace(/\s+/g, ' ').trim();
  return { guest: t, room, pax };
}

function isSummaryRow(r, C) {
  const a = String(r[C.name0] || '').trim().toUpperCase();
  const d = String(r[C.date0] || '').trim().toUpperCase();
  if (a === '0' || d === 'TOTAL') return true;
  if (/^(TOTAL|BEGINNING|DEPOSIT|REFUND|COH|NOTE)\b/.test(a)) return true;
  return false;
}

// Pure parse → ordered, cleaned entries + summary stats.
export function parseSheet(text) {
  const rows = parseCSV(text);
  const C = detectColumns(rows);
  const entries = [];
  const dropped = { summary: 0, capped: 0, nan: 0, nonpos: 0 };
  // chronological year tracking per stream
  const ctx = {
    dep: { y: START_YEAR, m: 2, d: 3, shift: 'AM', lastM: 1 },
    ref: { y: START_YEAR, m: 2, d: 3, shift: 'AM', lastM: 1 },
  };

  function rollYear(stream, monthIdx) {
    if (monthIdx < 0) return;
    // wrap detected when the month drops by a lot (e.g. Dec→Jan)
    if (monthIdx <= stream.lastM - 6) stream.y += 1;
    stream.lastM = monthIdx;
    stream.m = monthIdx + 1;
  }

  const SIDES = [
    { who: 'deposit', dir: +1, name: C.name0, date: C.date0, cols: [[C.t0, 'Towel'], [C.p0, 'Padlock'], [C.h0, 'Hair Dryer']], rem: C.rem0, stream: ctx.dep, towelNo: C.towelNo },
    { who: 'refund', dir: -1, name: C.name1, date: C.date1, cols: [[C.t1, 'Towel'], [C.p1, 'Padlock'], [C.h1, 'Hair Dryer']], rem: C.rem1, stream: ctx.ref, towelNo: -1 },
  ];

  let idx = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === C.headerIndex) continue;
    const r = rows[i];
    if (isSummaryRow(r, C)) { dropped.summary++; continue; }

    for (const side of SIDES) {
      // Date/shift context can sit in the dedicated date column OR be embedded in
      // the name/marker cell (e.g. refund rows like "ALL CHECK OUT FEB 3 AM").
      // parseDateShift returns null unless a real month or shift word is present,
      // so a plain name/room never spoofs a date.
      const md = side.date >= 0 ? parseDateShift(r[side.date]) : null;
      const mn = parseDateShift(r[side.name]);
      let meta = null;
      if (md || mn) {
        meta = {
          monthIdx: (md && md.monthIdx >= 0) ? md.monthIdx : (mn ? mn.monthIdx : -1),
          day: (md && md.day) || (mn && mn.day) || null,
          shift: (md && md.shift) || (mn && mn.shift) || null,
        };
      }
      if (meta) {
        if (meta.monthIdx >= 0) rollYear(side.stream, meta.monthIdx);
        if (meta.day) side.stream.d = meta.day;
        if (meta.shift) side.stream.shift = meta.shift;
      }
      for (const [ci, item] of side.cols) {
        if (ci == null || ci < 0) continue;
        const raw = r[ci];
        if (raw == null || String(raw).trim() === '') continue;
        const n = num(raw);
        if (isNaN(n)) { dropped.nan++; continue; }
        if (n <= 0) { dropped.nonpos++; continue; }
        if (n > CAP[item]) { dropped.capped++; continue; }
        const gr = extractGuestRoom(r[side.name]);
        const noteParts = [];
        if (side.towelNo >= 0 && r[side.towelNo] && String(r[side.towelNo]).trim()) noteParts.push('tags ' + String(r[side.towelNo]).trim());
        if (side.rem >= 0 && r[side.rem] && String(r[side.rem]).trim()) noteParts.push(String(r[side.rem]).trim());
        if (side.date >= 0 && r[side.date] && String(r[side.date]).trim()) noteParts.push(String(r[side.date]).trim());
        entries.push({
          kind: side.who, dir: side.dir, item, amount: round2(n),
          guest: gr.guest || '(unlabeled)', room: gr.room, pax: gr.pax,
          y: side.stream.y, m: side.stream.m, d: side.stream.d, shift: side.stream.shift,
          note: noteParts.join(' · ').slice(0, 160),
          order: idx++,
        });
      }
    }
  }

  const deposits = entries.filter((e) => e.kind === 'deposit').reduce((s, e) => s + e.amount, 0);
  const refunds = entries.filter((e) => e.kind === 'refund').reduce((s, e) => s + e.amount, 0);
  const years = entries.map((e) => e.y);
  return {
    entries,
    columns: C,
    summary: {
      count: entries.length,
      depCount: entries.filter((e) => e.kind === 'deposit').length,
      refCount: entries.filter((e) => e.kind === 'refund').length,
      deposits: round2(deposits), refunds: round2(refunds), coh: round2(deposits - refunds),
      dropped,
      yearMin: Math.min(...years), yearMax: Math.max(...years),
    },
  };
}

// Append a fully-formed, hash-chained entry directly (no per-row save) for bulk import.
function pushEntry(state, e) {
  const seq = state.ledger.length + 1;
  const prevHash = state.ledger.length ? state.ledger[state.ledger.length - 1].hash : GENESIS;
  const base = {
    seq, id: 'imp_' + seq, ts: e.ts,
    kind: e.kind, itemTypeId: e.itemTypeId, itemName: e.itemName,
    qty: 1, unitAmount: e.amount, amount: e.amount, direction: e.dir,
    guest: e.guest, room: e.room, pax: e.pax,
    shiftId: null, shiftLabel: e.shift,
    businessDate: e.businessDate, staff: 'import', staffRole: 'system',
    note: e.note, reversesId: null, prevHash,
  };
  base.hash = sha256(stableStringify(base));
  state.ledger.push(base);
}

// Import into the store. replace=true clears existing ledger + shifts first.
export function importSheet(store, text, { replace = true } = {}) {
  const parsed = parseSheet(text);
  store._suppressAudit = true;

  const need = [['Towel', 200], ['Padlock', 100], ['Hair Dryer', 500]];
  for (const [name, amt] of need) {
    if (!store.itemTypes.some((it) => it.name === name)) store.addItem({ name, defaultAmount: amt });
  }
  const byName = {}; for (const it of store.activeItems()) byName[it.name] = it;

  if (replace) { store.state.ledger = []; store.state.shifts = []; }

  for (const e of parsed.entries) {
    const item = byName[e.item];
    if (!item) continue;
    const businessDate = `${e.y}-${pad(e.m)}-${pad(e.d || 1)}`;
    const hour = SHIFT_HOUR[e.shift] || 9;
    const min = e.order % 60;
    pushEntry(store.state, {
      ...e, itemTypeId: item.id, itemName: e.item,
      businessDate, ts: `${businessDate}T${pad(hour)}:${pad(min)}:00`,
    });
  }

  store._suppressAudit = false;
  store.verifyIntegrity();
  store._audit('data.csv_import',
    `Imported ${parsed.summary.count} entries from spreadsheet (${parsed.summary.depCount} deposits, ${parsed.summary.refCount} refunds) · COH ₱${parsed.summary.coh.toLocaleString()}`,
    { count: parsed.summary.count, deposits: parsed.summary.deposits, refunds: parsed.summary.refunds, coh: parsed.summary.coh, replaced: replace });
  store.save();
  return parsed.summary;
}
