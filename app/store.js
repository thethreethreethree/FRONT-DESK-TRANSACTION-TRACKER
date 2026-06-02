// store.js — the integrity core.
//
// Design guarantees (serverless, but tamper-evident):
//   1. The ledger is APPEND-ONLY. There is no edit() or delete(). Mistakes are
//      corrected by appending a `reversal` entry that points at the original.
//   2. Cash On Hand (COH) is DERIVED (sum of signed amounts), never stored as an
//      editable field. There is nothing to overtype.
//   3. Every entry is HASH-CHAINED: entry.hash = sha256(entry-without-hash + prevHash).
//      Any out-of-band edit to storage breaks the chain and is flagged on load.
//
// Persistence: localStorage (front-desk device). GitHub repo holds versioned
// JSON backups (git history = durable, attributed audit trail).

import { sha256, stableStringify, uid, nowISO, businessDate, guessShift } from './util.js';

const STORAGE_KEY = 'fdtt_state_v1';
const GENESIS = '0'.repeat(64);

// ---- money helpers: integer-cents internally would be ideal, but we keep pesos
// as numbers rounded to 2dp to stay readable. round2 guards float drift. -------
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function defaultState() {
  return {
    version: 1,
    config: {
      brand: 'Frendz Hostel El Nido',
      currency: 'PHP',
      setupComplete: false,
      managerPin: null, // "salt$hash"
      staffPin: null,
      requireStaffPin: false,
      createdAt: nowISO(),
      github: { owner: '', repo: '', branch: 'main', path: 'data/ledger-backup.json', enabled: false },
    },
    itemTypes: [],
    staff: [],
    shifts: [],
    ledger: [],
  };
}

// Seed item types matching the current sheet.
function seedItemTypes() {
  const base = [
    { name: 'Towel', defaultAmount: 200 },
    { name: 'Padlock', defaultAmount: 100 },
    { name: 'Hair Dryer', defaultAmount: 500 },
  ];
  return base.map((b, i) => ({
    id: uid('item'), name: b.name, defaultAmount: b.defaultAmount,
    sortOrder: i, active: true, createdAt: nowISO(),
  }));
}

class Store {
  constructor() {
    this.state = null;
    this.session = null; // { name, role } set after login
    this._subs = new Set();
    this.integrity = { ok: true, brokenAtSeq: null };
  }

  // -------------------------------------------------------------- persistence
  load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* private mode */ }
    if (raw) {
      try { this.state = JSON.parse(raw); } catch (e) { this.state = defaultState(); }
    } else {
      this.state = defaultState();
    }
    // Migrate: ensure shape
    this.state = Object.assign(defaultState(), this.state);
    this.state.config = Object.assign(defaultState().config, this.state.config || {});
    this.verifyIntegrity();
    return this.state;
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error('save failed', e);
    }
    this.emit();
  }

  reset() {
    this.state = defaultState();
    this.save();
  }

  // ---------------------------------------------------------------- pub/sub
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  emit() { for (const fn of this._subs) { try { fn(this.state); } catch (e) { console.error(e); } } }

  // ---------------------------------------------------------------- config
  get config() { return this.state.config; }
  setConfig(patch) { Object.assign(this.state.config, patch); this.save(); }

  // ------------------------------------------------------------------ auth
  static hashPin(pin, salt) {
    salt = salt || Math.random().toString(36).slice(2, 12);
    return `${salt}$${sha256(salt + ':' + pin)}`;
  }
  static verifyPin(pin, stored) {
    if (!stored) return false;
    const [salt] = stored.split('$');
    return Store.hashPin(pin, salt) === stored;
  }
  isSetup() { return !!this.state.config.setupComplete; }
  completeSetup({ managerPin, staffPin, requireStaffPin, brand }) {
    const c = this.state.config;
    c.managerPin = Store.hashPin(managerPin);
    c.staffPin = staffPin ? Store.hashPin(staffPin) : null;
    c.requireStaffPin = !!requireStaffPin;
    if (brand) c.brand = brand;
    c.setupComplete = true;
    if (!this.state.itemTypes.length) this.state.itemTypes = seedItemTypes();
    this.save();
  }
  login(role, pin, name) {
    const c = this.state.config;
    if (role === 'manager') {
      if (!Store.verifyPin(pin, c.managerPin)) return false;
    } else if (c.requireStaffPin) {
      // staff pin OR manager pin both allow staff actions
      if (!Store.verifyPin(pin, c.staffPin) && !Store.verifyPin(pin, c.managerPin)) return false;
    }
    this.session = { role, name: name || (role === 'manager' ? 'Manager' : 'Staff'), at: nowISO() };
    this.emit();
    return true;
  }
  logout() { this.session = null; this.emit(); }
  isManager() { return this.session && this.session.role === 'manager'; }

  // ------------------------------------------------------------- item types
  get itemTypes() { return this.state.itemTypes; }
  activeItems() { return this.state.itemTypes.filter((i) => i.active).sort((a, b) => a.sortOrder - b.sortOrder); }
  itemById(id) { return this.state.itemTypes.find((i) => i.id === id); }
  addItem({ name, defaultAmount }) {
    const it = {
      id: uid('item'), name: name.trim(), defaultAmount: round2(defaultAmount),
      sortOrder: this.state.itemTypes.length, active: true, createdAt: nowISO(),
    };
    this.state.itemTypes.push(it);
    this.save();
    return it;
  }
  updateItem(id, patch) {
    const it = this.itemById(id);
    if (!it) return;
    if (patch.defaultAmount != null) patch.defaultAmount = round2(patch.defaultAmount);
    Object.assign(it, patch);
    this.save();
  }

  // ----------------------------------------------------------------- shifts
  get shifts() { return this.state.shifts; }
  currentOpenShift() {
    return this.state.shifts.find((s) => s.status === 'open') || null;
  }
  ensureShift() {
    let s = this.currentOpenShift();
    if (s) return s;
    s = {
      id: uid('shift'),
      label: guessShift(),
      businessDate: businessDate(),
      openedBy: this.session ? this.session.name : 'system',
      openedAt: nowISO(),
      closedBy: null, closedAt: null,
      countedCash: null, expectedCash: null, variance: null,
      status: 'open', note: '',
    };
    this.state.shifts.push(s);
    this.save();
    return s;
  }
  closeShift({ countedCash, note }) {
    const s = this.currentOpenShift();
    if (!s) return null;
    const expected = this.coh(); // expected COH at close
    s.countedCash = round2(countedCash);
    s.expectedCash = round2(expected);
    s.variance = round2(s.countedCash - s.expectedCash);
    s.note = note || '';
    s.closedBy = this.session ? this.session.name : 'system';
    s.closedAt = nowISO();
    s.status = 'closed';
    this.save();
    return s;
  }

  // ------------------------------------------------------- the append-only ledger
  get ledger() { return this.state.ledger; }
  _lastHash() {
    const L = this.state.ledger;
    return L.length ? L[L.length - 1].hash : GENESIS;
  }

  // Core append. ALL ledger writes funnel through here so every entry is
  // hashed & chained. There is intentionally no update/delete counterpart.
  _append(entry) {
    const seq = this.state.ledger.length + 1;
    const prevHash = this._lastHash();
    const base = {
      seq,
      id: entry.id || uid('txn'),
      ts: entry.ts || nowISO(),
      kind: entry.kind,
      itemTypeId: entry.itemTypeId || null,
      itemName: entry.itemName || null,
      qty: entry.qty != null ? Number(entry.qty) : null,
      unitAmount: entry.unitAmount != null ? round2(entry.unitAmount) : null,
      amount: round2(entry.amount),
      direction: entry.direction, // +1 cash in, -1 cash out
      guest: (entry.guest || '').trim(),
      room: (entry.room || '').trim(),
      pax: entry.pax != null && entry.pax !== '' ? Number(entry.pax) : null,
      shiftId: entry.shiftId || null,
      shiftLabel: entry.shiftLabel || null,
      businessDate: entry.businessDate || businessDate(entry.ts),
      staff: entry.staff || (this.session ? this.session.name : 'system'),
      staffRole: entry.staffRole || (this.session ? this.session.role : 'system'),
      note: (entry.note || '').trim(),
      reversesId: entry.reversesId || null,
      prevHash,
    };
    base.hash = sha256(stableStringify(base));
    this.state.ledger.push(base);
    this.save();
    return base;
  }

  addDeposit({ itemTypeId, qty, unitAmount, amount, guest, room, pax, note }) {
    const item = this.itemById(itemTypeId);
    const shift = this.ensureShift();
    const unit = unitAmount != null ? unitAmount : (item ? item.defaultAmount : 0);
    const amt = amount != null ? amount : round2(unit * Number(qty || 1));
    return this._append({
      kind: 'deposit', direction: +1,
      itemTypeId, itemName: item ? item.name : 'Item',
      qty: qty || 1, unitAmount: unit, amount: amt,
      guest, room, pax, note,
      shiftId: shift.id, shiftLabel: shift.label,
    });
  }

  addRefund({ itemTypeId, qty, unitAmount, amount, guest, room, pax, note }) {
    const item = this.itemById(itemTypeId);
    const shift = this.ensureShift();
    const unit = unitAmount != null ? unitAmount : (item ? item.defaultAmount : 0);
    const amt = amount != null ? amount : round2(unit * Number(qty || 1));
    return this._append({
      kind: 'refund', direction: -1,
      itemTypeId, itemName: item ? item.name : 'Item',
      qty: qty || 1, unitAmount: unit, amount: amt,
      guest, room, pax, note,
      shiftId: shift.id, shiftLabel: shift.label,
    });
  }

  // Manager-only: void/correct an existing entry by appending its inverse.
  reverse(targetId, reason) {
    const t = this.state.ledger.find((e) => e.id === targetId);
    if (!t) return null;
    if (t.kind === 'reversal') return null; // don't reverse a reversal
    // already reversed?
    if (this.state.ledger.some((e) => e.reversesId === targetId)) return null;
    const shift = this.ensureShift();
    return this._append({
      kind: 'reversal', direction: -t.direction,
      itemTypeId: t.itemTypeId, itemName: t.itemName,
      qty: t.qty, unitAmount: t.unitAmount, amount: t.amount,
      guest: t.guest, room: t.room, pax: t.pax,
      note: `VOID of #${t.seq} (${t.kind} ${t.itemName} ${t.guest}). Reason: ${reason || 'n/a'}`,
      reversesId: targetId,
      shiftId: shift.id, shiftLabel: shift.label,
    });
  }
  isReversed(id) { return this.state.ledger.some((e) => e.reversesId === id); }

  // ----------------------------------------------------------- derived values
  // Cash On Hand = net of all signed amounts. This IS the number; it cannot be set.
  coh(upToSeq = Infinity) {
    return round2(this.state.ledger
      .filter((e) => e.seq <= upToSeq)
      .reduce((sum, e) => sum + e.amount * e.direction, 0));
  }

  // Totals split by gross deposits vs gross refunds (reversals net into each).
  totals(filterFn = () => true) {
    let deposits = 0, refunds = 0;
    for (const e of this.state.ledger) {
      if (!filterFn(e)) continue;
      const signed = e.amount * e.direction;
      if (signed >= 0) deposits += signed; else refunds += -signed;
    }
    return { deposits: round2(deposits), refunds: round2(refunds), coh: round2(deposits - refunds) };
  }

  // Per-item breakdown of currently-held deposits.
  byItem() {
    const map = new Map();
    for (const e of this.state.ledger) {
      const key = e.itemTypeId || e.itemName || 'other';
      const cur = map.get(key) || { name: e.itemName || 'Other', held: 0 };
      cur.held = round2(cur.held + e.amount * e.direction);
      map.set(key, cur);
    }
    return Array.from(map.values()).filter((x) => Math.abs(x.held) > 0.005);
  }

  // Outstanding deposits per guest (net deposit still held). Positive = owed back.
  outstandingByGuest() {
    const map = new Map();
    for (const e of this.state.ledger) {
      const g = (e.guest || '').toUpperCase().trim();
      const r = (e.room || '').toUpperCase().trim();
      const key = `${g}|${r}`;
      if (!g && !r) continue;
      const cur = map.get(key) || { guest: e.guest || '', room: e.room || '', held: 0, items: {} };
      cur.held = round2(cur.held + e.amount * e.direction);
      const it = e.itemName || 'Item';
      cur.items[it] = round2((cur.items[it] || 0) + e.amount * e.direction);
      map.set(key, cur);
    }
    return Array.from(map.values())
      .filter((x) => x.held > 0.005)
      .sort((a, b) => b.held - a.held);
  }

  // ------------------------------------------------------------- integrity
  verifyIntegrity() {
    let prev = GENESIS;
    let brokenAtSeq = null;
    for (const e of this.state.ledger) {
      const { hash, ...rest } = e;
      const expectPrev = prev;
      if (rest.prevHash !== expectPrev) { brokenAtSeq = e.seq; break; }
      const recomputed = sha256(stableStringify(rest));
      if (recomputed !== hash) { brokenAtSeq = e.seq; break; }
      prev = hash;
    }
    this.integrity = { ok: brokenAtSeq == null, brokenAtSeq };
    return this.integrity;
  }

  // ------------------------------------------------------------- export/import
  exportData() {
    return {
      meta: {
        app: 'Frendz Front Desk Transaction Tracker',
        exportedAt: nowISO(),
        version: this.state.version,
        coh: this.coh(),
        entries: this.state.ledger.length,
        integrity: this.verifyIntegrity(),
      },
      state: this.state,
    };
  }
  importData(payload) {
    const s = payload && payload.state ? payload.state : payload;
    if (!s || !Array.isArray(s.ledger)) throw new Error('Invalid backup file.');
    this.state = Object.assign(defaultState(), s);
    this.state.config = Object.assign(defaultState().config, s.config || {});
    this.verifyIntegrity();
    this.save();
  }
}

export const store = new Store();
export { round2, GENESIS };
