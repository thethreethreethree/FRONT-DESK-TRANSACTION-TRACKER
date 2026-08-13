// travelista.js — Travelista Management & Tracking: the second system.
//
// Mirrors the Travelista_monitoring sheet (departure date, guest, destination,
// pax, fare, total, booked by, travelista share, commission, remarks) and runs
// on the SAME integrity discipline as the front-desk ledger:
//
//   1. APPEND-ONLY. No edit, no delete. A mistake is corrected by appending a
//      reversal that points at the original.
//   2. Cash is DERIVED (opening float + Σ signed amounts), never a typed field.
//   3. Every entry is HASH-CHAINED to the one before it, so an out-of-band edit
//      to storage is detectable (store.verifyTravelistaIntegrity).
//
// It shares the app's state object — one login, one backup file, one GitHub
// sync — but keeps its OWN chain, so the towel ledger's COH reconciliation is
// mathematically untouched by anything that happens here. See defaultTravelista()
// in store.js for why the two "cash on hand" figures must not be merged.
//
// THE MONEY, PRECISELY:
//   total  = what the guest paid us for the ticket   (cash IN)
//   commission = the hostel's cut of that total      (stays with the hostel)
//   share  = total − commission                      (payable to the travelista)
//   cash   = opening float + Σ collected − Σ paid out
//          = (travelista payable still held) + (commission not yet taken out)
// That last identity is the reconciliation check shown on the dashboard — the
// same role `held − over` plays for the front-desk drawer.

import { sha256, stableStringify, uid, nowISO, businessDate } from './util.js';
import { store } from './store.js';

const GENESIS = '0'.repeat(64);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// The rate table the sheet implies. PPS is priced per head (750 → 650 + 100);
// EL NIDO rows are a whole private van at a flat 8,000 → 7,000 + 1,000 no matter
// how many pax ride it (rows 12 and 13 charge the same for 5 and 8 pax). Both
// are editable in Travelista → Settings; nothing here is hard-coded downstream.
// The ids are FIXED, not generated: a booking hashes its destinationId, so two
// devices seeding independently must land on the same id or the same booking
// would hash differently on each. See seedStarterOnce().
const SEED_DESTINATIONS = [
  { id: 'dest_pps', name: 'PPS', fare: 750, fareBasis: 'per_pax', commission: 100, commissionBasis: 'per_pax' },
  { id: 'dest_elnido', name: 'EL NIDO', fare: 8000, fareBasis: 'flat', commission: 1000, commissionBasis: 'flat' },
];
const SEED_BOOKERS = ['MARIE', 'BECCA', 'DARREN', 'GINO', 'CHALYN', 'MONIE'];

// ---------------------------------------------------------------- date helpers
const pad = (n) => String(n).padStart(2, '0');

// Accepts "2026-08-01", "01-Aug-2026", "9-August-2026", "8/1/2026" → "YYYY-MM-DD".
// Returns '' when it can't be read, so a bad cell is visible rather than guessed.
export function toYMD(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]+)[-\s](\d{4})$/);
  if (m) {
    const mi = MONTH_NAMES.findIndex((n) => n.startsWith(m[2].toUpperCase().slice(0, 3)));
    if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(m[1])}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // M/D/YYYY (sheet default)
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return '';
}
export function fmtYMD(ymd) {
  const s = String(ymd || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

// The reporting period a departure date falls in. The sheet runs half-months
// ("Aug. 1-15"), so that's the default; 'month' is offered for teams that would
// rather close monthly. Period is keyed off the DEPARTURE date, matching how the
// sheet is organised — not off when the booking was typed in.
export function periodOf(ymd, mode) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const monthly = (mode || tv.config.periodMode) === 'month';
  return periodFromKey(monthly ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${Number(m[3]) <= 15 ? 'A' : 'B'}`);
}
// Expand a period key back into its label and date range. Keys are self-
// describing, so a period is always rendered from the key itself and never
// from stale state — switching the reporting mode can't mislabel old rows.
export function periodFromKey(key) {
  let m = String(key || '').match(/^(\d{4})-(\d{2})-([AB])$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), eom = daysInMonth(y, mo), first = m[3] === 'A';
    return { key, label: `${MONTHS[mo - 1]}. ${first ? '1-15' : `16-${eom}`}, ${y}`,
      start: `${m[1]}-${m[2]}-${first ? '01' : '16'}`, end: `${m[1]}-${m[2]}-${first ? '15' : pad(eom)}` };
  }
  m = String(key || '').match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), eom = daysInMonth(y, mo);
    return { key, label: `${MONTHS[mo - 1]} ${y}`, start: `${key}-01`, end: `${key}-${pad(eom)}` };
  }
  return null;
}

// =============================================================== the data layer
export const tv = {
  // ------------------------------------------------------------------ access
  get state() { return store.state.travelista; },
  get entries() { return store.state.travelista.entries; },
  get config() { return store.state.travelista.config; },
  get enabled() { return !!store.state.travelista.enabled; },
  get integrity() { return store.travelistaIntegrity; },

  // First run: lay down the rate table and the booker roster so the desk can
  // record a booking immediately instead of configuring first. Idempotent.
  ensureSeed() {
    const t = this.state;
    let touched = false;
    if (!t.destinations.length) {
      t.destinations = SEED_DESTINATIONS.map((d, i) => Object.assign({
        sortOrder: i, active: true, createdAt: nowISO(),
      }, d));
      touched = true;
    }
    if (!t.bookers.length) {
      t.bookers = SEED_BOOKERS.map((n) => ({ id: 'bkr_' + n.toLowerCase(), name: n, active: true, createdAt: nowISO() }));
      touched = true;
    }
    if (!t.config.startedAt) { t.config.startedAt = nowISO(); touched = true; }
    if (touched) store.save();
    return t;
  },
  enable() {
    if (this.state.enabled) return this.state;
    this.state.enabled = true;
    this.ensureSeed();
    store._audit('tv.enable', 'Travelista tracking enabled', { startedAt: this.state.config.startedAt });
    store.save();
    return this.state;
  },

  // -------------------------------------------------------------- rate table
  destinations() { return (this.state.destinations || []).slice().sort((a, b) => a.sortOrder - b.sortOrder); },
  activeDestinations() { return this.destinations().filter((d) => d.active); },
  destinationById(id) { return (this.state.destinations || []).find((d) => d.id === id) || null; },
  addDestination({ name, fare, fareBasis, commission, commissionBasis }) {
    const d = {
      id: uid('dest'), name: String(name || '').trim().toUpperCase(),
      fare: round2(fare), fareBasis: fareBasis === 'flat' ? 'flat' : 'per_pax',
      commission: round2(commission), commissionBasis: commissionBasis === 'flat' ? 'flat' : 'per_pax',
      sortOrder: this.state.destinations.length, active: true, createdAt: nowISO(),
    };
    this.state.destinations.push(d);
    store._audit('tv.destination.create', `Travelista: added destination "${d.name}" (₱${d.fare} ${d.fareBasis === 'flat' ? 'flat' : 'per pax'}, commission ₱${d.commission})`, { id: d.id, name: d.name });
    store.save();
    return d;
  },
  updateDestination(id, patch) {
    const d = this.destinationById(id);
    if (!d) return null;
    const before = { fare: d.fare, commission: d.commission, fareBasis: d.fareBasis, commissionBasis: d.commissionBasis, active: d.active };
    if (patch.fare != null) patch.fare = round2(patch.fare);
    if (patch.commission != null) patch.commission = round2(patch.commission);
    Object.assign(d, patch);
    store._audit('tv.destination.update', `Travelista: updated destination "${d.name}"`, { id, before, after: { fare: d.fare, commission: d.commission, fareBasis: d.fareBasis, commissionBasis: d.commissionBasis, active: d.active } });
    store.save();
    return d;
  },

  // ----------------------------------------------------------------- bookers
  bookers() { return (this.state.bookers || []).filter((b) => b.active !== false); },
  addBooker(name) {
    const nm = String(name || '').trim().toUpperCase();
    if (!nm) return null;
    if (this.bookers().some((b) => b.name === nm)) return null;
    const b = { id: uid('bkr'), name: nm, active: true, createdAt: nowISO() };
    this.state.bookers.push(b);
    store._audit('tv.booker.add', `Travelista: added booker "${nm}"`, { name: nm });
    store.save();
    return b;
  },
  removeBooker(id) {
    const arr = this.state.bookers || [];
    const i = arr.findIndex((b) => b.id === id);
    if (i < 0) return false;
    const [b] = arr.splice(i, 1);
    store._audit('tv.booker.remove', `Travelista: removed booker "${b.name}"`, { name: b.name });
    store.save();
    return true;
  },

  // --------------------------------------------------------------- the quote
  // What a booking costs and how it splits, from the rate table. Everything is
  // overridable at entry — the table is a fast default, never a constraint.
  quote({ destinationId, pax, fare, commission }) {
    const d = this.destinationById(destinationId);
    const n = Math.max(1, Number(pax) || 1);
    const f = fare != null && fare !== '' ? round2(fare) : (d ? d.fare : 0);
    const fb = d ? d.fareBasis : 'per_pax';
    const total = round2(fb === 'flat' ? f : f * n);
    const cRate = commission != null && commission !== '' ? round2(commission) : (d ? d.commission : 0);
    const cb = d ? d.commissionBasis : 'per_pax';
    const comm = round2(cb === 'flat' ? cRate : cRate * n);
    return { fare: f, fareBasis: fb, pax: n, total, commission: comm, share: round2(total - comm), destination: d ? d.name : '' };
  },

  // ------------------------------------------------------- the append-only chain
  _lastHash() {
    const E = this.entries;
    return E.length ? E[E.length - 1].hash : GENESIS;
  },
  // Every travelista write funnels through here, so no entry can exist unhashed
  // or unchained. Field set is fixed (all keys always present) so the hash shape
  // stays stable across kinds and future additive fields verify cleanly.
  _append(entry) {
    const base = {
      seq: this.entries.length + 1,
      id: entry.id || uid('tv'),
      ts: entry.ts || nowISO(),
      kind: entry.kind,                       // booking | payout | reversal
      direction: entry.direction,             // +1 cash in, -1 cash out
      amount: round2(entry.amount || 0),      // the cash that actually moved
      departureDate: entry.departureDate || '',
      guest: (entry.guest || '').trim(),
      destination: (entry.destination || '').trim(),
      destinationId: entry.destinationId || null,
      pax: entry.pax != null && entry.pax !== '' ? Number(entry.pax) : null,
      fare: entry.fare != null ? round2(entry.fare) : null,
      fareBasis: entry.fareBasis || '',
      total: entry.total != null ? round2(entry.total) : 0,
      travelistaShare: entry.travelistaShare != null ? round2(entry.travelistaShare) : 0,
      commission: entry.commission != null ? round2(entry.commission) : 0,
      bookedBy: (entry.bookedBy || '').trim(),
      remarks: (entry.remarks || '').trim(),
      payoutType: entry.payoutType || '',     // travelista | commission | other
      payee: (entry.payee || '').trim(),
      method: (entry.method || '').trim(),
      periodKey: entry.periodKey || '',
      staff: entry.staff || (store.session ? store.session.name : 'system'),
      staffRole: entry.staffRole || (store.session ? store.session.role : 'system'),
      businessDate: entry.businessDate || businessDate(entry.ts),
      reversesId: entry.reversesId || null,
      reversesKind: entry.reversesKind || null,
      prevHash: this._lastHash(),
    };
    base.hash = sha256(stableStringify(base));
    this.entries.push(base);
    store.save();
    return base;
  },

  // `id` / `ts` / `staff` are normally left blank (generated per entry). The seed
  // loader passes them explicitly so the same 15 rows hash IDENTICALLY on every
  // device — see seedStarterOnce() for why that matters to sync.
  addBooking({ departureDate, guest, destinationId, pax, fare, total, commission, bookedBy, remarks, id, ts, staff, staffRole }) {
    const d = this.destinationById(destinationId);
    const q = this.quote({ destinationId, pax, fare });
    const tot = total != null && total !== '' ? round2(total) : q.total;
    const comm = commission != null && commission !== '' ? round2(commission) : q.commission;
    const ymd = toYMD(departureDate) || businessDate();
    const per = periodOf(ymd);
    if (!this.state.enabled) this.enable();
    const e = this._append({
      kind: 'booking', direction: +1, amount: tot,
      departureDate: ymd, guest, destinationId, destination: d ? d.name : '',
      pax, fare: q.fare, fareBasis: q.fareBasis,
      total: tot, commission: comm, travelistaShare: round2(tot - comm),
      bookedBy, remarks, periodKey: per ? per.key : '',
      id, ts, staff, staffRole, businessDate: ts ? ymd : undefined,
    });
    store._audit('tv.booking.create',
      `Travelista booking #${e.seq} · ${e.guest || '—'} · ${e.destination} ×${e.pax} pax · ₱${e.total.toLocaleString()} (commission ₱${e.commission.toLocaleString()})`,
      { ref: e.seq, id: e.id, guest: e.guest, destination: e.destination, pax: e.pax, total: e.total, commission: e.commission, bookedBy: e.bookedBy });
    return e;
  },

  // Money leaving the travelista cash box: remitting the operator's share, or
  // the hostel drawing out its earned commission. Both reduce cash on hand; only
  // the first reduces what we still OWE the travelista.
  addPayout({ amount, payoutType, payee, method, note, periodKey }) {
    const amt = round2(amount);
    if (!(amt > 0)) return null;
    const type = ['travelista', 'commission', 'other'].includes(payoutType) ? payoutType : 'travelista';
    const e = this._append({
      kind: 'payout', direction: -1, amount: amt,
      payoutType: type, payee, method, remarks: note || '', periodKey: periodKey || '',
    });
    store._audit('tv.payout.create',
      `Travelista payout #${e.seq} · ₱${amt.toLocaleString()} · ${type}${e.payee ? ' → ' + e.payee : ''}${e.method ? ' (' + e.method + ')' : ''}`,
      { ref: e.seq, id: e.id, amount: amt, payoutType: type, payee: e.payee });
    return e;
  },

  // Correct a mistake the only way an append-only record allows: append its
  // inverse. The original row stays visible (struck through) with the reversal
  // pointing at it, so the record shows what happened AND that it was undone.
  reverse(targetId, reason) {
    const t = this.entries.find((e) => e.id === targetId);
    if (!t) return null;
    if (t.kind === 'reversal') return null;
    if (this.isReversed(targetId)) return null;
    const r = this._append({
      kind: 'reversal', direction: -t.direction, amount: t.amount,
      departureDate: t.departureDate, guest: t.guest,
      destination: t.destination, destinationId: t.destinationId, pax: t.pax,
      fare: t.fare, fareBasis: t.fareBasis,
      total: t.total, travelistaShare: t.travelistaShare, commission: t.commission,
      bookedBy: t.bookedBy, payoutType: t.payoutType, payee: t.payee, method: t.method,
      periodKey: t.periodKey,
      remarks: `VOID of #${t.seq} (${t.kind}${t.guest ? ' · ' + t.guest : ''}). Reason: ${reason || 'n/a'}`,
      reversesId: targetId, reversesKind: t.kind,
    });
    store._audit('tv.void', `Voided travelista #${t.seq} (${t.kind}${t.guest ? ' · ' + t.guest : ''} · ₱${t.amount.toLocaleString()})`,
      { ref: t.seq, reversalSeq: r.seq, reason: reason || '' });
    return r;
  },
  isReversed(id) { return this.entries.some((e) => e.reversesId === id); },
  entryBySeq(seq) { seq = Number(seq); return this.entries.find((e) => e.seq === seq) || null; },

  // --------------------------------------------------------- derived figures
  beginningCash() {
    const b = Number(this.config.beginningCash || 0);
    return isFinite(b) ? round2(b) : 0;
  },
  setBeginningCash(amount, { reason = '' } = {}) {
    const before = this.beginningCash();
    this.config.beginningCash = round2(Number(amount) || 0);
    const after = this.beginningCash();
    if (after !== before) {
      store._audit('tv.beginning_cash', `Travelista opening cash ₱${before.toLocaleString()} → ₱${after.toLocaleString()}${reason ? ' · ' + reason : ''}`, { before, after, reason });
    }
    store.save();
    return after;
  },
  setPeriodMode(mode) {
    this.config.periodMode = mode === 'month' ? 'month' : 'half';
    store._audit('tv.period_mode', `Travelista reporting period set to ${this.config.periodMode === 'month' ? 'monthly' : 'half-month (1–15 / 16–end)'}`, { mode: this.config.periodMode });
    store.save();
  },

  // Cash actually in the travelista box. Derived, never stored.
  cash() {
    return round2(this.beginningCash() + this.entries.reduce((s, e) => s + e.amount * e.direction, 0));
  },

  // Sales & payout totals over any slice of the record. A reversal carries a copy
  // of the original's figures, so subtracting it on `direction` undoes the whole
  // row — total, share and commission together — with no special-casing.
  totals(filterFn = () => true) {
    let collected = 0, share = 0, commission = 0, pax = 0, bookings = 0;
    let paidTravelista = 0, paidCommission = 0, paidOther = 0;
    for (const e of this.entries) {
      if (!filterFn(e)) continue;
      const sales = e.kind === 'booking' || (e.kind === 'reversal' && e.reversesKind === 'booking');
      if (sales) {
        const sign = e.kind === 'booking' ? 1 : -1;
        collected += e.total * sign;
        share += e.travelistaShare * sign;
        commission += e.commission * sign;
        pax += (e.pax || 0) * sign;
        bookings += sign;
        continue;
      }
      const payout = e.kind === 'payout' || (e.kind === 'reversal' && e.reversesKind === 'payout');
      if (payout) {
        const sign = e.kind === 'payout' ? 1 : -1;
        const v = e.amount * sign;
        if (e.payoutType === 'commission') paidCommission += v;
        else if (e.payoutType === 'other') paidOther += v;
        else paidTravelista += v;
      }
    }
    const paidOut = round2(paidTravelista + paidCommission + paidOther);
    return {
      collected: round2(collected), share: round2(share), commission: round2(commission),
      pax, bookings,
      paidTravelista: round2(paidTravelista), paidCommission: round2(paidCommission),
      paidOther: round2(paidOther), paidOut,
      net: round2(collected - paidOut),
    };
  },

  // The identity that keeps the box honest, and which the dashboard displays:
  //   opening + collected − paid out = cash = travelista payable + commission held
  // If those two sides ever disagree, something was recorded that shouldn't be.
  reconciliation() {
    const t = this.totals();
    const cash = this.cash();
    const payable = round2(t.share - t.paidTravelista);
    const commissionHeld = round2(t.commission - t.paidCommission);
    return {
      beginning: this.beginningCash(),
      collected: t.collected, paidOut: t.paidOut, cash,
      payable, commissionHeld, other: t.paidOther,
      balances: Math.abs(round2(this.beginningCash() + payable + commissionHeld - t.paidOther - cash)) < 0.005,
    };
  },

  // ---------------------------------------------------------------- periods
  bookings(filterFn = () => true) {
    return this.entries.filter((e) => e.kind === 'booking' && filterFn(e));
  },
  // Which period an entry belongs to, decided at READ time. A booking files by
  // its DEPARTURE date (that's how the sheet is organised); a payout files by the
  // period it was tagged to, falling back to when it was recorded. Derived rather
  // than trusted from the stored key, so changing the reporting mode re-files the
  // whole record consistently instead of leaving old rows under stale keys.
  periodKeyOf(e) {
    const sales = e.kind === 'booking' || (e.kind === 'reversal' && e.reversesKind === 'booking');
    if (!sales && e.periodKey && this._keyFitsMode(e.periodKey)) return e.periodKey;
    const p = periodOf(sales ? e.departureDate : (e.departureDate || businessDate(e.ts)));
    return p ? p.key : '';
  },
  _keyFitsMode(key) {
    return this.config.periodMode === 'month' ? /^\d{4}-\d{2}$/.test(key) : /^\d{4}-\d{2}-[AB]$/.test(key);
  },
  // Every period that has activity, newest first.
  periods() {
    const seen = new Map();
    for (const e of this.entries) {
      const key = this.periodKeyOf(e);
      if (!key || seen.has(key)) continue;
      seen.set(key, periodFromKey(key) || { key, label: key, start: '', end: '' });
    }
    return Array.from(seen.values()).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  },
  inPeriod(key) { return (e) => this.periodKeyOf(e) === key; },
  currentPeriodKey() {
    const p = periodOf(businessDate());
    return p ? p.key : '';
  },

  // ---------------------------------------------------------------- reports
  // Sales grouped by whoever booked the guest — who is bringing the business in,
  // and how much commission each has earned the hostel.
  byBooker(filterFn = () => true) {
    const map = new Map();
    for (const e of this.entries) {
      if (!filterFn(e)) continue;
      const sales = e.kind === 'booking' || (e.kind === 'reversal' && e.reversesKind === 'booking');
      if (!sales) continue;
      const sign = e.kind === 'booking' ? 1 : -1;
      const name = e.bookedBy || '—';
      const cur = map.get(name) || { name, bookings: 0, pax: 0, total: 0, share: 0, commission: 0 };
      cur.bookings += sign; cur.pax += (e.pax || 0) * sign;
      cur.total = round2(cur.total + e.total * sign);
      cur.share = round2(cur.share + e.travelistaShare * sign);
      cur.commission = round2(cur.commission + e.commission * sign);
      map.set(name, cur);
    }
    return Array.from(map.values()).filter((r) => r.bookings > 0).sort((a, b) => b.total - a.total);
  },
  byDestination(filterFn = () => true) {
    const map = new Map();
    for (const e of this.entries) {
      if (!filterFn(e)) continue;
      const sales = e.kind === 'booking' || (e.kind === 'reversal' && e.reversesKind === 'booking');
      if (!sales) continue;
      const sign = e.kind === 'booking' ? 1 : -1;
      const name = e.destination || '—';
      const cur = map.get(name) || { name, bookings: 0, pax: 0, total: 0, share: 0, commission: 0 };
      cur.bookings += sign; cur.pax += (e.pax || 0) * sign;
      cur.total = round2(cur.total + e.total * sign);
      cur.share = round2(cur.share + e.travelistaShare * sign);
      cur.commission = round2(cur.commission + e.commission * sign);
      map.set(name, cur);
    }
    return Array.from(map.values()).filter((r) => r.bookings > 0).sort((a, b) => b.total - a.total);
  },

  // ------------------------------------------------------------------ export
  // CSV in the sheet's own column order, so a period can go straight back to
  // whoever still works in Sheets.
  toCSV(filterFn = () => true) {
    const head = ['NO.', 'DEPARTURE DATE', 'Guest Name', 'Destination', 'No. of Pax', 'Fare', 'Total', 'Booked By:', 'Travelista', 'Commision', 'REMARKS'];
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = [head.join(',')];
    let n = 0;
    let total = 0, share = 0, commission = 0;
    for (const e of this.entries) {
      if (e.kind !== 'booking' || !filterFn(e)) continue;
      if (this.isReversed(e.id)) continue;
      n += 1;
      total = round2(total + e.total); share = round2(share + e.travelistaShare); commission = round2(commission + e.commission);
      rows.push([n, fmtYMD(e.departureDate), e.guest, e.destination, e.pax, e.fare, e.total, e.bookedBy, e.travelistaShare, e.commission, e.remarks].map(q).join(','));
    }
    rows.push(['', '', '', '', '', 'TOTAL', total, '', share, commission, ''].map(q).join(','));
    return rows.join('\n');
  },
};

// The Aug 1–15, 2026 sheet, exactly as handed over — the record this system was
// built from, so it IS the opening state rather than optional sample data.
//
// Every row carries a FIXED id, timestamp, business date and staff. That makes
// the seed byte-for-byte identical on every device that lays it down. It matters
// because sync adopts by entry id: if two devices seeded independently with
// generated ids, each would hold 15 bookings the other lacks, neither backup
// would be adoptable, and the two would diverge permanently. Fixed ids make the
// same seed CONVERGE instead — the second device recognises the first's rows as
// the very rows it holds. Order below is the sheet's own row order.
export const STARTER_SHEET = {
  version: 'aug-1-15-2026',
  label: 'Aug. 1-15, 2026 (Travelista_monitoring)',
  rows: [
    { no: 1, date: '2026-08-01', guest: 'SILUNA DON', dest: 'PPS', pax: 3, fare: 750, total: 2250, commission: 300, by: 'MARIE', remarks: '' },
    { no: 2, date: '2026-08-01', guest: 'INGA BHATT', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'BECCA', remarks: '' },
    { no: 3, date: '2026-08-02', guest: 'ALBERT MARSHALL', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'DARREN', remarks: '' },
    { no: 4, date: '2026-08-04', guest: 'LUKAS HORST', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'MARIE', remarks: '' },
    { no: 5, date: '2026-08-04', guest: 'KATHLEEN PALOMAR', dest: 'PPS', pax: 2, fare: 750, total: 1500, commission: 200, by: 'GINO', remarks: '' },
    { no: 6, date: '2026-08-05', guest: 'NIKLAS SCHEMER', dest: 'PPS', pax: 4, fare: 750, total: 3000, commission: 400, by: 'GINO', remarks: '' },
    { no: 7, date: '2026-08-07', guest: 'ELISABET FERRETE', dest: 'PPS', pax: 2, fare: 750, total: 1500, commission: 200, by: 'GINO', remarks: '' },
    // The sheet writes this one "9-August-2026" while its neighbours use "9-Aug-2026" — same date, kept in sheet order.
    { no: 8, date: '2026-08-09', guest: 'WILLIAN DB', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'GINO', remarks: '' },
    { no: 9, date: '2026-08-08', guest: 'MANAR ALI', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'CHALYN', remarks: '' },
    { no: 10, date: '2026-08-08', guest: 'BENJAMIN DOMMACH', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'CHALYN', remarks: '' },
    { no: 11, date: '2026-08-08', guest: 'NEREA S VEGA', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'MONIE', remarks: '' },
    { no: 12, date: '2026-08-08', guest: 'CARLOTTA TOSI', dest: 'EL NIDO', pax: 5, fare: 8000, total: 8000, commission: 1000, by: 'CHALYN', remarks: 'PRIVATE VAN' },
    { no: 13, date: '2026-08-09', guest: 'BELEN GUTIEREZ', dest: 'EL NIDO', pax: 8, fare: 8000, total: 8000, commission: 1000, by: 'BECCA', remarks: 'PRIVATE VAN' },
    { no: 14, date: '2026-08-10', guest: 'HISHAM AL BALUSHI', dest: 'PPS', pax: 2, fare: 750, total: 1500, commission: 200, by: 'BECCA', remarks: '' },
    { no: 15, date: '2026-08-10', guest: 'CARAYOL GASPERD', dest: 'PPS', pax: 1, fare: 750, total: 750, commission: 100, by: 'DARREN', remarks: '' },
  ],
};
// Stamp each starter row with its fixed identity (see the note above).
function starterRows() {
  return STARTER_SHEET.rows.map((r) => Object.assign({}, r, {
    id: `tv_seed_${STARTER_SHEET.version}_${String(r.no).padStart(2, '0')}`,
    ts: `${r.date}T02:00:00.000Z`,   // 10:00 PH — a stable, sheet-derived timestamp
    staff: 'sheet', staffRole: 'system',
  }));
}

// Lay the sheet down ONCE, on whichever device opens the app first; every other
// device then receives it through the normal backup/adopt path. Guarded twice —
// by a synced config flag AND by the presence of the seed's own ids — so it can
// never run a second time and double the money, even if the flag is lost.
export function seedStarterOnce() {
  const rows = starterRows();
  if (store.config.travelistaSeedV1 === STARTER_SHEET.version) return null;
  const have = new Set(tv.entries.map((e) => e.id));
  if (rows.some((r) => have.has(r.id))) { // already present (adopted from another device)
    store.setConfig({ travelistaSeedV1: STARTER_SHEET.version });
    return null;
  }
  const res = importRows(rows, { source: STARTER_SHEET.label + ' — opening record' });
  store.setConfig({ travelistaSeedV1: STARTER_SHEET.version });
  return res;
}
// True once the sheet is on this device, so Settings can say so instead of
// offering a load that would duplicate it.
export function starterLoaded() {
  if (store.config.travelistaSeedV1 === STARTER_SHEET.version) return true;
  const have = new Set(tv.entries.map((e) => e.id));
  return starterRows().some((r) => have.has(r.id));
}

// Load a set of sheet rows into the record. Used by the starter loader and the
// CSV importer. Each row is appended through the normal chain (so it is hashed,
// audited and reversible like anything else) — nothing bypasses the ledger.
export function importRows(rows, { source = 'import' } = {}) {
  tv.ensureSeed();
  const known = new Map(tv.destinations().map((d) => [d.name.toUpperCase(), d]));
  let added = 0, total = 0;
  store._suppressAudit = true; // one summary audit line instead of one per row
  try {
    for (const r of rows) {
      const dn = String(r.dest || r.destination || '').trim().toUpperCase();
      if (!dn) continue;
      let d = known.get(dn);
      if (!d) { // an unseen destination: register it from the row itself
        d = tv.addDestination({ name: dn, fare: r.fare, fareBasis: Number(r.pax) > 1 && round2(r.total) === round2(r.fare) ? 'flat' : 'per_pax', commission: r.commission, commissionBasis: 'flat' });
        known.set(dn, d);
      }
      const by = String(r.by || r.bookedBy || '').trim().toUpperCase();
      if (by && !tv.bookers().some((b) => b.name === by)) tv.addBooker(by);
      const e = tv.addBooking({
        departureDate: r.date || r.departureDate, guest: r.guest, destinationId: d.id,
        pax: r.pax, fare: r.fare, total: r.total, commission: r.commission,
        bookedBy: by, remarks: r.remarks || '',
        id: r.id, ts: r.ts, staff: r.staff, staffRole: r.staffRole, // set only by the seed
      });
      added += 1; total = round2(total + e.total);
    }
  } finally { store._suppressAudit = false; }
  store._audit('tv.import', `Travelista: imported ${added} booking${added === 1 ? '' : 's'} (₱${total.toLocaleString()}) from ${source}`, { added, total, source });
  store.save();
  return { added, total };
}

// Parse a CSV export of the Travelista_monitoring sheet. Column names are matched
// from the header row so a re-ordered or re-exported sheet still imports; rows
// without a guest name (the sheet's hundreds of blank numbered rows) are skipped.
export function parseTravelistaCSV(text) {
  const rows = [];
  { let row = [], cell = '', q = false;
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
  }
  const num = (v) => { const s = String(v == null ? '' : v).replace(/[₱, ]/g, ''); return s === '' ? NaN : parseFloat(s); };
  const find = (h, re) => h.findIndex((c) => re.test(String(c || '').trim()));
  const hi = rows.findIndex((r) => find(r, /guest\s*name/i) >= 0);
  if (hi < 0) throw new Error('No "Guest Name" column found — is this the Travelista sheet?');
  const H = rows[hi];
  const col = {
    date: find(H, /departure/i), guest: find(H, /guest\s*name/i), dest: find(H, /destination/i),
    pax: find(H, /pax/i), fare: find(H, /^fare$/i), total: find(H, /^total$/i),
    by: find(H, /booked\s*by/i), share: find(H, /travelista/i), commission: find(H, /commis/i),
    remarks: find(H, /remarks/i),
  };
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const guest = col.guest >= 0 ? String(r[col.guest] || '').trim() : '';
    if (!guest) continue;
    const date = toYMD(col.date >= 0 ? r[col.date] : '');
    if (!date) continue;
    const pax = col.pax >= 0 ? num(r[col.pax]) : NaN;
    const fare = col.fare >= 0 ? num(r[col.fare]) : NaN;
    const total = col.total >= 0 ? num(r[col.total]) : NaN;
    const commission = col.commission >= 0 ? num(r[col.commission]) : NaN;
    if (!isFinite(total) || total <= 0) continue; // blank / formula-zero row
    out.push({
      date, guest, dest: col.dest >= 0 ? String(r[col.dest] || '').trim() : '',
      pax: isFinite(pax) ? pax : 1, fare: isFinite(fare) ? fare : total,
      total, commission: isFinite(commission) ? commission : 0,
      by: col.by >= 0 ? String(r[col.by] || '').trim() : '',
      remarks: col.remarks >= 0 ? String(r[col.remarks] || '').trim() : '',
    });
  }
  return out;
}

export { round2 as tvRound2 };
