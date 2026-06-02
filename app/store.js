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
// Persistence: IndexedDB (front-desk device) — chosen over localStorage because
// a full year of entries is several MB, beyond localStorage's ~5MB quota. We
// keep a localStorage fallback for private-mode / no-IDB and migrate old data.
// GitHub repo holds versioned JSON backups (git history = durable audit trail).

import { sha256, stableStringify, uid, nowISO, businessDate, guessShift, pesoPlain } from './util.js';

const STORAGE_KEY = 'fdtt_state_v1';
const SESSION_KEY = 'fdtt_session'; // device-local signed-in session (not exported)
const GENESIS = '0'.repeat(64);

// ------------------------------------------------------------- IndexedDB layer
const IDB_NAME = 'fdtt';
const IDB_STORE = 'kv';
const IDB_KEY = 'state';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-idb')); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result == null ? null : req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
async function idbSet(key, val) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb-abort'));
    });
  } finally { db.close(); }
}

// ---- money helpers: integer-cents internally would be ideal, but we keep pesos
// as numbers rounded to 2dp to stay readable. round2 guards float drift. -------
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function defaultState() {
  return {
    version: 1,
    config: {
      brand: 'Frendz Hostel El Nido',
      currency: 'PHP',
      // Opening cash float the drawer started with, before any tracked deposit/
      // refund. COH = beginningBalance + Σ(deposits − refunds). Manager-set.
      beginningBalance: 0,
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
    audit: [], // append-only, hash-chained activity log (who / what / when)
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
    this.auditIntegrity = { ok: true, brokenAtSeq: null };
    this._suppressAudit = false; // used while bulk-loading demo/CSV data
  }

  // -------------------------------------------------------------- persistence
  // Async: reads IndexedDB; if empty, migrates any legacy localStorage state.
  async load() {
    let s = null;
    try { s = await idbGet(IDB_KEY); } catch (e) { /* no idb / private mode */ }
    if (!s) {
      let raw = null;
      try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      if (raw) { try { s = JSON.parse(raw); } catch (e) { s = null; } }
      if (s) this._migratedFromLS = true; // persist into IDB after shape-fix below
    }
    this.state = s || defaultState();
    // Migrate: ensure shape
    this.state = Object.assign(defaultState(), this.state);
    this.state.config = Object.assign(defaultState().config, this.state.config || {});
    if (!Array.isArray(this.state.audit)) this.state.audit = [];
    this.verifyIntegrity();
    this.verifyAuditIntegrity();
    if (this._migratedFromLS) { this._migratedFromLS = false; this._persist(); }
    this._restoreSession();
    return this.state;
  }

  // Persist current state to IndexedDB. Writes are coalesced and serialized so
  // rapid mutations never race; the in-memory state is always the source of truth.
  _persist() {
    this._dirty = true;
    if (this._writing) return this._writing;
    this._writing = (async () => {
      try {
        while (this._dirty) {
          this._dirty = false;
          try {
            await idbSet(IDB_KEY, this.state);
          } catch (e) {
            // Fallback: localStorage (works only for small states / private mode).
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
            catch (e2) { console.error('persist failed (idb + localStorage)', e, e2); }
          }
        }
      } finally { this._writing = null; }
    })();
    return this._writing;
  }

  // Resolves once all pending writes have flushed (use before app close / export).
  async flush() { if (this._writing) await this._writing; }

  save() {
    this._persist();
    this.emit();
  }

  reset() {
    const actor = this.session ? this.session.name : 'system';
    this.state = defaultState();
    this.session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    this._audit('data.reset', `All data reset by ${actor}`, {});
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
    this._audit('setup.complete', 'Front desk initialised', { brand: c.brand });
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
    // Persist the session (device-local, never exported) so a refresh / back
    // navigation keeps the user signed in instead of bouncing them to the PIN.
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(this.session)); } catch (e) { /* private mode */ }
    this._audit('auth.login', `${this.session.name} signed in as ${role}`, { role });
    this.emit();
    return true;
  }
  logout() {
    if (this.session) this._audit('auth.logout', `${this.session.name} signed out`, {});
    this.session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    this.emit();
  }
  // Re-hydrate a persisted session on load so refresh doesn't force re-login.
  // Only valid once setup is complete and the role still exists in config.
  _restoreSession() {
    if (this.session || !this.isSetup()) return;
    let raw = null;
    try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const s = JSON.parse(raw);
      if (s && (s.role === 'manager' || s.role === 'staff')) this.session = s;
    } catch (e) { /* corrupt — ignore */ }
  }
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
    this._audit('item.create', `Added item "${it.name}" (default ₱${pesoPlain(it.defaultAmount)})`, { name: it.name, defaultAmount: it.defaultAmount });
    this.save();
    return it;
  }
  updateItem(id, patch) {
    const it = this.itemById(id);
    if (!it) return;
    const before = { name: it.name, defaultAmount: it.defaultAmount, active: it.active };
    if (patch.defaultAmount != null) patch.defaultAmount = round2(patch.defaultAmount);
    Object.assign(it, patch);
    const after = { name: it.name, defaultAmount: it.defaultAmount, active: it.active };
    let action = 'item.update';
    let what = `Updated item "${it.name}"`;
    if ('active' in patch && patch.active !== before.active) {
      action = patch.active ? 'item.restore' : 'item.retire';
      what = `${patch.active ? 'Restored' : 'Retired'} item "${it.name}"`;
    } else if (after.defaultAmount !== before.defaultAmount) {
      what = `Changed "${it.name}" amount ₱${pesoPlain(before.defaultAmount)} → ₱${pesoPlain(after.defaultAmount)}`;
    }
    this._audit(action, what, { id, before, after });
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
    this._audit('shift.open', `Opened ${s.label} shift · ${s.businessDate}`, { id: s.id, label: s.label, businessDate: s.businessDate });
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
    this._audit('shift.close',
      `Closed ${s.label} shift · expected ₱${pesoPlain(s.expectedCash)}, counted ₱${pesoPlain(s.countedCash)}, variance ${s.variance >= 0 ? '+' : ''}${pesoPlain(s.variance)}`,
      { id: s.id, expected: s.expectedCash, counted: s.countedCash, variance: s.variance });
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
    const e = this._append({
      kind: 'deposit', direction: +1,
      itemTypeId, itemName: item ? item.name : 'Item',
      qty: qty || 1, unitAmount: unit, amount: amt,
      guest, room, pax, note,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('deposit.create', `Deposit ₱${pesoPlain(e.amount)} · ${e.itemName} ×${e.qty} · ${e.guest || e.room || '—'}`,
      { ref: e.seq, id: e.id, amount: e.amount, item: e.itemName, guest: e.guest, room: e.room });
    return e;
  }

  addRefund({ itemTypeId, qty, unitAmount, amount, guest, room, pax, note }) {
    const item = this.itemById(itemTypeId);
    const shift = this.ensureShift();
    const unit = unitAmount != null ? unitAmount : (item ? item.defaultAmount : 0);
    const amt = amount != null ? amount : round2(unit * Number(qty || 1));
    const e = this._append({
      kind: 'refund', direction: -1,
      itemTypeId, itemName: item ? item.name : 'Item',
      qty: qty || 1, unitAmount: unit, amount: amt,
      guest, room, pax, note,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('refund.create', `Refund ₱${pesoPlain(e.amount)} · ${e.itemName} ×${e.qty} · ${e.guest || e.room || '—'}`,
      { ref: e.seq, id: e.id, amount: e.amount, item: e.itemName, guest: e.guest, room: e.room });
    return e;
  }

  // Manager-only: void/correct an existing entry by appending its inverse.
  reverse(targetId, reason) {
    const t = this.state.ledger.find((e) => e.id === targetId);
    if (!t) return null;
    if (t.kind === 'reversal') return null; // don't reverse a reversal
    // already reversed?
    if (this.state.ledger.some((e) => e.reversesId === targetId)) return null;
    const shift = this.ensureShift();
    const r = this._append({
      kind: 'reversal', direction: -t.direction,
      itemTypeId: t.itemTypeId, itemName: t.itemName,
      qty: t.qty, unitAmount: t.unitAmount, amount: t.amount,
      guest: t.guest, room: t.room, pax: t.pax,
      note: `VOID of #${t.seq} (${t.kind} ${t.itemName} ${t.guest}). Reason: ${reason || 'n/a'}`,
      reversesId: targetId,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('txn.void', `Voided #${t.seq} (${t.kind} ${t.itemName} · ${t.guest || t.room || '—'} · ₱${pesoPlain(t.amount)})`,
      { ref: t.seq, reversalSeq: r.seq, reason: reason || '' });
    return r;
  }
  isReversed(id) { return this.state.ledger.some((e) => e.reversesId === id); }

  // Book a single, labelled reconciliation entry so COH equals `target`. Used to
  // tie the derived COH to the official sheet figure when the imported CSV is an
  // older/partial snapshot — the difference is a visible, hash-chained adjustment
  // (cash in/out), never a hidden override. Returns the entry, or null if exact.
  reconcileCOH(target, { reason = '', source = '' } = {}) {
    const cur = this.coh();
    const diff = round2(Number(target) - cur);
    if (!isFinite(diff) || Math.abs(diff) < 0.005) return null;
    const shift = this.currentOpenShift();
    const e = this._append({
      kind: 'adjustment', direction: diff >= 0 ? 1 : -1,
      itemTypeId: null, itemName: 'Adjustment',
      qty: null, unitAmount: Math.abs(diff), amount: Math.abs(diff),
      guest: '', room: '', pax: null,
      note: reason || `Reconciliation to official COH ₱${pesoPlain(target)}`,
      shiftId: shift ? shift.id : null, shiftLabel: shift ? shift.label : null,
    });
    this._audit('coh.reconcile',
      `Reconciled COH ₱${pesoPlain(cur)} → ₱${pesoPlain(round2(Number(target)))} (adjustment ${diff >= 0 ? '+' : '−'}₱${pesoPlain(Math.abs(diff))})`,
      { from: cur, to: round2(Number(target)), adjustment: diff, source });
    return e;
  }

  // ----------------------------------------------------------- derived values
  // Opening cash float — the only typed input to COH. Everything else is derived.
  beginningBalance() {
    const b = Number(this.state.config.beginningBalance || 0);
    return isFinite(b) ? round2(b) : 0;
  }
  // Set the opening balance (manager-gated by the caller). Audited.
  setBeginningBalance(amount, { source = '' } = {}) {
    const before = this.beginningBalance();
    this.state.config.beginningBalance = round2(Number(amount) || 0);
    const after = this.beginningBalance();
    if (after !== before) {
      this._audit('settings.beginning_balance',
        `Beginning balance ₱${pesoPlain(before)} → ₱${pesoPlain(after)}${source ? ' (' + source + ')' : ''}`,
        { before, after, source });
    }
    this.save();
    return after;
  }

  // Net flow from the ledger alone (deposits − refunds), excluding the opening float.
  netFlow(upToSeq = Infinity) {
    return round2(this.state.ledger
      .filter((e) => e.seq <= upToSeq)
      .reduce((sum, e) => sum + e.amount * e.direction, 0));
  }

  // Cash On Hand = opening float + net flow. The float is the only set value;
  // every deposit (+) and refund (−) moves COH by its amount. Cannot be over-typed.
  coh(upToSeq = Infinity) {
    return round2(this.beginningBalance() + this.netFlow(upToSeq));
  }

  // Totals split by gross deposits vs gross refunds (reversals net into each).
  // `coh` here is the NET FLOW (deposits − refunds) for the filtered set; the
  // opening float is added separately by coh() to get true Cash On Hand.
  totals(filterFn = () => true) {
    let deposits = 0, refunds = 0, adjustments = 0;
    for (const e of this.state.ledger) {
      if (!filterFn(e)) continue;
      const signed = e.amount * e.direction;
      if (e.kind === 'adjustment') { adjustments += signed; continue; }
      if (signed >= 0) deposits += signed; else refunds += -signed;
    }
    return {
      deposits: round2(deposits), refunds: round2(refunds),
      adjustments: round2(adjustments),
      coh: round2(deposits - refunds + adjustments),
    };
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

  // Net balance per guest (deposits − refunds attributed by name+room).
  _guestNets() {
    const map = new Map();
    for (const e of this.state.ledger) {
      const g = (e.guest || '').toUpperCase().trim();
      const r = (e.room || '').toUpperCase().trim();
      if (!g && !r) continue;
      const key = `${g}|${r}`;
      const cur = map.get(key) || { guest: e.guest || '', room: e.room || '', held: 0, items: {} };
      cur.held = round2(cur.held + e.amount * e.direction);
      const it = e.itemName || 'Item';
      cur.items[it] = round2((cur.items[it] || 0) + e.amount * e.direction);
      map.set(key, cur);
    }
    return Array.from(map.values());
  }

  // Guests who still hold a deposit (owed back). Positive balances only.
  outstandingByGuest() {
    return this._guestNets().filter((x) => x.held > 0.005).sort((a, b) => b.held - a.held);
  }

  // Guests refunded MORE than they deposited under this exact name/room — usually
  // a name/room mismatch or a refund of a pre-system deposit. Worth a look.
  overReturnedByGuest() {
    return this._guestNets().filter((x) => x.held < -0.005).sort((a, b) => a.held - b.held);
  }

  // Reconciliation that ALWAYS ties back to COH:
  //   beginningBalance + held − overReturned + adjustments = COH.
  // (Adjustment entries carry no guest, so they sit outside held/over.)
  reconciliation() {
    const nets = this._guestNets();
    const held = round2(nets.filter((x) => x.held > 0).reduce((s, x) => s + x.held, 0));
    const over = round2(-nets.filter((x) => x.held < 0).reduce((s, x) => s + x.held, 0));
    const adjustments = round2(this.state.ledger
      .filter((e) => e.kind === 'adjustment')
      .reduce((s, e) => s + e.amount * e.direction, 0));
    return {
      beginning: this.beginningBalance(),
      held, over, adjustments, coh: this.coh(),
      positives: nets.filter((x) => x.held > 0.005).length,
      negatives: nets.filter((x) => x.held < -0.005).length,
    };
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

  // ------------------------------------------------------ activity / audit log
  // Append a tamper-evident audit event. Funnels every meaningful action so the
  // log answers WHO did WHAT and WHEN — including before→after on edits.
  _lastAuditHash() {
    const A = this.state.audit;
    return A.length ? A[A.length - 1].hash : GENESIS;
  }
  _audit(action, what, details = {}) {
    if (this._suppressAudit) return null;
    const ev = {
      seq: this.state.audit.length + 1,
      id: uid('aud'),
      ts: nowISO(),
      actor: this.session ? this.session.name : 'system',
      role: this.session ? this.session.role : 'system',
      action,
      what: what || '',
      details: details || {},
      prevHash: this._lastAuditHash(),
    };
    ev.hash = sha256(stableStringify(ev));
    this.state.audit.push(ev);
    this.save();
    return ev;
  }
  verifyAuditIntegrity() {
    let prev = GENESIS;
    let brokenAtSeq = null;
    for (const ev of this.state.audit) {
      const { hash, ...rest } = ev;
      if (rest.prevHash !== prev) { brokenAtSeq = ev.seq; break; }
      if (sha256(stableStringify(rest)) !== hash) { brokenAtSeq = ev.seq; break; }
      prev = hash;
    }
    this.auditIntegrity = { ok: brokenAtSeq == null, brokenAtSeq };
    return this.auditIntegrity;
  }
  get audit() { return this.state.audit; }

  // Change a PIN. `who` is 'manager' or 'staff'. Records to the activity log.
  changePin(who, newPin, { recovery = false } = {}) {
    const c = this.state.config;
    if (who === 'manager') c.managerPin = Store.hashPin(newPin);
    else c.staffPin = newPin ? Store.hashPin(newPin) : null;
    this._audit(recovery ? 'auth.pin_reset' : 'auth.pin_change',
      `${recovery ? 'Recovered' : 'Changed'} ${who} PIN`, { who, recovery });
    this.save();
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
        auditEvents: this.state.audit.length,
        integrity: this.verifyIntegrity(),
        auditIntegrity: this.verifyAuditIntegrity(),
      },
      state: this.state,
    };
  }
  importData(payload) {
    const s = payload && payload.state ? payload.state : payload;
    if (!s || !Array.isArray(s.ledger)) throw new Error('Invalid backup file.');
    this.state = Object.assign(defaultState(), s);
    this.state.config = Object.assign(defaultState().config, s.config || {});
    if (!Array.isArray(this.state.audit)) this.state.audit = [];
    this.verifyIntegrity();
    this.verifyAuditIntegrity();
    this._audit('data.import', `Imported backup (${this.state.ledger.length} ledger entries)`, { entries: this.state.ledger.length });
    this.save();
  }
}

export const store = new Store();
export { round2, GENESIS };
