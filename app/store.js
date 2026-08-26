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

import { sha256, stableStringify, uid, nowISO, businessDate, guessShift, pesoPlain, isTowelItem, entryTowelNo, towelTokens, normTowelNo, isPassportItem, setTagItems } from './util.js';
import { LOCATIONS, DEFAULT_LOCATION } from './locations.js';

// The build this code came from. Stamped onto every backup so it is possible to
// tell, from the repo alone, WHICH devices are running current code — a stale
// device is the one thing that can still break multi-device sync, and until now
// nothing recorded it. Bump when a change matters to how devices sync.
export const APP_BUILD = '2026-08-19-merge-sync';

const GENESIS = '0'.repeat(64);

// ------------------------------------------------------------- IndexedDB layer
const IDB_NAME = 'fdtt';
const IDB_STORE = 'kv';
// NOTE: the per-building record key, localStorage fallback key and session key
// all live on the location (see locations.js). Main's are unchanged from before
// buildings existed, so existing devices keep their data exactly where it was.

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

// Chronological sort by ISO timestamp (string compare orders ISO correctly),
// falling back to seq. Used for towel events so "most recent" means most recent
// by transaction date, not by insert order (imported rows aren't seq-by-date).
const byTsThenSeq = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq);

function defaultState(loc) {
  const L = loc || LOCATIONS[DEFAULT_LOCATION];
  return {
    version: 1,
    config: {
      brand: L.name,
      locationId: L.id,
      currency: 'PHP',
      // Opening cash float the drawer started with, before any tracked deposit/
      // refund. COH = beginningBalance + Σ(deposits − refunds). Manager-set.
      beginningBalance: 0,
      setupComplete: false,
      managerPin: null, // "salt$hash"
      staffPin: null,
      requireStaffPin: false,
      createdAt: nowISO(),
      github: { owner: '', repo: '', branch: 'main', path: L.backupPath, enabled: false },
      // Towel tracker: a clean, going-forward physical-towel inventory. `startedAt`
      // is the baseline — only towel deposits/refunds from this moment on move the
      // inventory, because historical refunds never recorded a towel number.
      towelTracker: { enabled: false, startedAt: null },
      // Dirty-towel / laundry tracking. When enabled, a returned towel becomes Dirty
      // (held out of the available pool) until it's washed & marked Clean. `startedAt`
      // is the cycle anchor; `hours` is the recording-period length (≥1, default 24).
      towelRecording: { enabled: false, startedAt: null, hours: 24 },
    },
    itemTypes: [],
    staff: [],
    admins: [], // elevated "Admin" accounts, each with its own PIN (own login tier)
    shifts: [],
    ledger: [],
    audit: [], // append-only, hash-chained activity log (who / what / when)
    towels: [],     // master towel inventory: { no, createdAt, createdBy }
    towelLog: [],   // admin resolutions for lost/written-off towels: { id, no, action, ts, by, note }
    laundryLog: [], // dirty/washing/clean transitions: { id, no, status, ts, by }
    // Travelista Management & Tracking — the SECOND system (van/boat ticket
    // bookings & commissions). It lives in the same state object (one backup
    // file, one sync, one login) but keeps its OWN append-only hash chain, so
    // the front-desk deposit ledger above is never touched by it. See the note
    // on defaultTravelista() for why the two cash figures must stay separate.
    travelista: defaultTravelista(),
  };
}

// The Travelista sub-state. Deliberately a SEPARATE record chain from `ledger`.
//
// WHY: the two systems both say "cash on hand" but mean different money. The
// front desk's COH is guest deposits the hostel HOLDS AND OWES BACK — its
// correctness rests on `beginning + held − over + adjustments = COH`. Travelista
// cash is ticket money COLLECTED, most of which is payable to the travelista
// operator and the rest is the hostel's commission. Posting bookings into the
// deposit ledger would put revenue inside that reconciliation and break it. So:
// same app, same integrity discipline, two independent chains.
export function defaultTravelista() {
  return {
    enabled: false,        // flipped on the first booking / on setup
    config: {
      beginningCash: 0,    // opening float of the travelista cash box
      startedAt: null,
      periodMode: 'half',  // 'half' = 1–15 / 16–end (matches the sheet), 'month'
    },
    destinations: [],      // rate table: fare + commission per destination
    bookers: [],           // who booked the guest ("Booked By:" on the sheet)
    entries: [],           // append-only, hash-chained: booking | payout | reversal
  };
}

// Seed the deposit items this building actually lends out.
function seedItemTypes(loc) {
  const base = (loc || LOCATIONS[DEFAULT_LOCATION]).seedItems;
  return base.map((b, i) => ({
    id: uid('item'), name: b.name, defaultAmount: b.defaultAmount,
    sortOrder: i, active: true, createdAt: nowISO(),
  }));
}

class Store {
  constructor() {
    // Which building this instance is serving. Set BEFORE load() — every storage
    // key, the session and the backup path all hang off it, so a device working
    // at one building cannot read or write another's records.
    this.loc = LOCATIONS[DEFAULT_LOCATION];
    this.state = null;
    this.session = null; // { name, role } set after login
    this._subs = new Set();
    this.integrity = { ok: true, brokenAtSeq: null };
    this.auditIntegrity = { ok: true, brokenAtSeq: null };
    this.travelistaIntegrity = { ok: true, brokenAtSeq: null };
    this._suppressAudit = false; // used while bulk-loading demo/CSV data
  }

  // ------------------------------------------------------------------ location
  // Point this store at a building. Main keeps the ORIGINAL keys and path, so
  // existing devices are completely unaffected by the arrival of a second one.
  useLocation(id) {
    this.loc = LOCATIONS[id] || LOCATIONS[DEFAULT_LOCATION];
    this.state = null;
    this.session = null;
    setTagItems(this.loc.tagItems); // which item carries a physical tag number here
    return this.loc;
  }
  get location() { return this.loc; }
  get _idbKey() { return this.loc.idbKey; }
  get _lsKey() { return this.loc.lsKey; }
  get _sessionKey() { return this.loc.sessionKey; }

  // Read another building's stored config WITHOUT switching to it. Used once, when
  // a new building is provisioned, so it can inherit the device's already-working
  // GitHub target instead of making someone retype it.
  async peekConfig(locId) {
    const L = LOCATIONS[locId];
    if (!L) return null;
    try {
      const s = await idbGet(L.idbKey);
      return s && s.config ? s.config : null;
    } catch (e) { return null; }
  }

  // -------------------------------------------------------------- persistence
  // Async: reads IndexedDB; if empty, migrates any legacy localStorage state.
  async load() {
    let s = null;
    try { s = await idbGet(this._idbKey); } catch (e) { /* no idb / private mode */ }
    if (!s) {
      let raw = null;
      try { raw = localStorage.getItem(this._lsKey); } catch (e) { /* ignore */ }
      if (raw) { try { s = JSON.parse(raw); } catch (e) { s = null; } }
      if (s) this._migratedFromLS = true; // persist into IDB after shape-fix below
    }
    this.state = s || defaultState(this.loc);
    // Migrate: ensure shape
    this.state = Object.assign(defaultState(this.loc), this.state);
    this.state.config = Object.assign(defaultState(this.loc).config, this.state.config || {});
    if (!Array.isArray(this.state.audit)) this.state.audit = [];
    if (!Array.isArray(this.state.towels)) this.state.towels = [];
    if (!Array.isArray(this.state.towelLog)) this.state.towelLog = [];
    if (!Array.isArray(this.state.admins)) this.state.admins = [];
    if (!Array.isArray(this.state.laundryLog)) this.state.laundryLog = [];
    if (!this.state.config.towelTracker) this.state.config.towelTracker = { enabled: false, startedAt: null };
    if (!this.state.config.towelRecording) this.state.config.towelRecording = { enabled: false, startedAt: null, hours: 24 };
    this._normalizeTravelista();
    this.verifyIntegrity();
    this.verifyAuditIntegrity();
    this.verifyTravelistaIntegrity();
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
            await idbSet(this._idbKey, this.state);
          } catch (e) {
            // Fallback: localStorage (works only for small states / private mode).
            try { localStorage.setItem(this._lsKey, JSON.stringify(this.state)); }
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
    this.state = defaultState(this.loc);
    this.session = null;
    try { localStorage.removeItem(this._sessionKey); } catch (e) { /* ignore */ }
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
  // Verify any hash-chained list on its OWN terms, from genesis. Used before a
  // merge to decide whether a remote's records can be trusted at all.
  static chainOk(arr) {
    if (!Array.isArray(arr)) return false;
    let prev = GENESIS;
    for (const e of arr) {
      if (!e || typeof e !== 'object') return false;
      const { hash, ...rest } = e;
      if (rest.prevHash !== prev) return false;
      if (sha256(stableStringify(rest)) !== hash) return false;
      prev = hash;
    }
    return true;
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
    if (!this.state.itemTypes.length) this.state.itemTypes = seedItemTypes(this.loc);
    this._audit('setup.complete', 'Front desk initialised', { brand: c.brand });
    this.save();
  }
  // Active staff accounts (each has its own PIN). Roster lives in state.staff.
  staffList() { return (this.state.staff || []).filter((s) => s.active !== false); }

  login(role, pin, name) {
    const c = this.state.config;
    let session = null;
    if (role === 'manager') {
      // Admin tier. The PIN identifies the person: match an Admin account first
      // (adopt its name for accountability), then the baked manager credential.
      const admin = this.adminList().find((a) => Store.verifyPin(pin, a.pin));
      if (admin) session = { role: 'manager', name: admin.name, adminId: admin.id, at: nowISO() };
      else if (Store.verifyPin(pin, c.managerPin)) session = { role: 'manager', name: name || 'Admin', at: nowISO() };
      else return false;
    } else {
      // Staff: the PIN identifies the person. Match the roster first (and adopt
      // that account's name, for accountability), then a legacy shared staff PIN,
      // then the manager PIN (manager covering the desk), then — only if NO staff
      // and no PIN are configured at all — an open no-PIN desk.
      const match = this.staffList().find((s) => Store.verifyPin(pin, s.pin));
      if (match) session = { role: 'staff', name: match.name, staffId: match.id, at: nowISO() };
      else if (c.staffPin && Store.verifyPin(pin, c.staffPin)) session = { role: 'staff', name: name || 'Staff', at: nowISO() };
      else if (Store.verifyPin(pin, c.managerPin)) session = { role: 'staff', name: name || 'Manager', at: nowISO() };
      else if (this.staffList().length === 0 && !c.requireStaffPin && !c.staffPin) session = { role: 'staff', name: name || 'Staff', at: nowISO() };
      else return false;
    }
    this.session = session;
    // Persist the session (device-local, never exported) so a refresh / back
    // navigation keeps the user signed in instead of bouncing them to the PIN.
    try { localStorage.setItem(this._sessionKey, JSON.stringify(this.session)); } catch (e) { /* private mode */ }
    this._audit('auth.login', `${this.session.name} signed in as ${this.session.role}`, { role: this.session.role });
    this.emit();
    return true;
  }
  logout() {
    if (this.session) this._audit('auth.logout', `${this.session.name} signed out`, {});
    this.session = null;
    try { localStorage.removeItem(this._sessionKey); } catch (e) { /* ignore */ }
    this.emit();
  }
  // Re-hydrate a persisted session on load so refresh doesn't force re-login.
  // Only valid once setup is complete and the role still exists in config.
  _restoreSession() {
    if (this.session || !this.isSetup()) return;
    let raw = null;
    try { raw = localStorage.getItem(this._sessionKey); } catch (e) { return; }
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
      // Towel tag number — only the "Towel" item carries one. Stored as its own
      // field so it's queryable; older entries keep it in the note (read via
      // entryTowelNo). New entries hash WITH this key; pre-existing entries have
      // no `towelNo` key, so their stored hashes still verify (chain unbroken).
      towelNo: isTowelItem(entry.itemName) ? (entry.towelNo || '').toString().trim() : '',
      // The towel handed back in an exchange (the new one going out is `towelNo`).
      oldTowelNo: isTowelItem(entry.itemName) ? (entry.oldTowelNo || '').toString().trim() : '',
      // Marks a refund where the towel was NOT returned (reported lost). Drives the
      // towel tracker's "lost" state. Additive field — old entries lack it and still
      // verify; only set true on lost refunds.
      towelLost: !!entry.towelLost,
      // The deposit transaction this refund settles, so a deposit and its refund
      // are linked by number. Additive field — old entries lack it and still verify.
      refundsSeq: entry.refundsSeq != null && entry.refundsSeq !== '' ? Number(entry.refundsSeq) : null,
      // The deposit an exchange belongs to. Distinct from refundsSeq: an exchange
      // links to the deposit but does NOT settle it (the deposit stays refundable).
      exchangesSeq: entry.exchangesSeq != null && entry.exchangesSeq !== '' ? Number(entry.exchangesSeq) : null,
      // MEWS reservation # — required on Passport deposits (non-cash collateral).
      mewsRes: (entry.mewsRes || '').toString().trim(),
      // PRIVATE ROOM: the guest takes the item on their room alone — no cash, no
      // passport. Cash-neutral by construction (amount 0), so it moves no money
      // at deposit OR at check-out; it only records that the item is out and who
      // has it. Additive field — pre-existing entries have no `privateRoom` key,
      // so their stored hashes still verify and the chain stays unbroken.
      privateRoom: !!entry.privateRoom,
      reversesId: entry.reversesId || null,
      prevHash,
    };
    base.hash = sha256(stableStringify(base));
    this.state.ledger.push(base);
    this.save();
    return base;
  }

  addDeposit({ itemTypeId, qty, unitAmount, amount, guest, room, pax, note, towelNo, mewsRes, privateRoom }) {
    const item = this.itemById(itemTypeId);
    const shift = this.ensureShift();
    const unit = unitAmount != null ? unitAmount : (item ? item.defaultAmount : 0);
    const amt = amount != null ? amount : round2(unit * Number(qty || 1));
    const e = this._append({
      kind: 'deposit', direction: +1,
      itemTypeId, itemName: item ? item.name : 'Item',
      qty: qty || 1, unitAmount: unit, amount: amt,
      guest, room, pax, note, towelNo, mewsRes, privateRoom,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('deposit.create', `Deposit ₱${pesoPlain(e.amount)} · ${e.itemName} ×${e.qty} · ${e.guest || e.room || '—'}`,
      { ref: e.seq, id: e.id, amount: e.amount, item: e.itemName, guest: e.guest, room: e.room });
    return e;
  }

  addRefund({ itemTypeId, qty, unitAmount, amount, guest, room, pax, note, towelNo, towelLost, refundsSeq }) {
    const item = this.itemById(itemTypeId);
    const shift = this.ensureShift();
    const unit = unitAmount != null ? unitAmount : (item ? item.defaultAmount : 0);
    const amt = amount != null ? amount : round2(unit * Number(qty || 1));
    const e = this._append({
      kind: 'refund', direction: -1,
      itemTypeId, itemName: item ? item.name : 'Item',
      qty: qty || 1, unitAmount: unit, amount: amt,
      guest, room, pax, note, towelNo, towelLost, refundsSeq,
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
      towelNo: entryTowelNo(t), // mirror the original's tag so the void row matches
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
  // A manual COH adjustment is accountability-critical: it must say WHY, which guest
  // and staff were involved, and the related transaction #. These are recorded on the
  // (visible) ledger entry AND the audit log. `source: 'official data file'` is the
  // one automated caller (provisioning) and isn't required to fill them.
  reconcileCOH(target, { reason = '', guest = '', staffInvolved = '', refSeq = '', source = '' } = {}) {
    const cur = this.coh();
    const diff = round2(Number(target) - cur);
    if (!isFinite(diff) || Math.abs(diff) < 0.005) return null;
    const shift = this.currentOpenShift();
    const ref = String(refSeq || '').replace(/^#/, '').trim();
    const parts = [];
    if (reason) parts.push(reason);
    if (guest) parts.push('guest ' + guest);
    if (staffInvolved) parts.push('staff ' + staffInvolved);
    if (ref) parts.push('ref #' + ref);
    const e = this._append({
      kind: 'adjustment', direction: diff >= 0 ? 1 : -1,
      itemTypeId: null, itemName: 'Adjustment',
      qty: null, unitAmount: Math.abs(diff), amount: Math.abs(diff),
      guest: guest || '', room: '', pax: null,
      note: `COH reconciliation to ₱${pesoPlain(round2(Number(target)))}${parts.length ? ' · ' + parts.join(' · ') : ''}`,
      shiftId: shift ? shift.id : null, shiftLabel: shift ? shift.label : null,
    });
    this._audit('coh.reconcile',
      `Reconciled COH ₱${pesoPlain(cur)} → ₱${pesoPlain(round2(Number(target)))} (${diff >= 0 ? '+' : '−'}₱${pesoPlain(Math.abs(diff))})${reason ? ' · ' + reason : ''}${guest ? ' · guest ' + guest : ''}${staffInvolved ? ' · staff ' + staffInvolved : ''}${ref ? ' · ref #' + ref : ''}`,
      { from: cur, to: round2(Number(target)), adjustment: diff, reason, guest, staffInvolved, refSeq: ref, source });
    return e;
  }

  // ----------------------------------------------------------- derived values
  // Opening cash float — the only typed input to COH. Everything else is derived.
  beginningBalance() {
    const b = Number(this.state.config.beginningBalance || 0);
    return isFinite(b) ? round2(b) : 0;
  }
  // Set the opening balance (manager-gated by the caller). Audited.
  setBeginningBalance(amount, { source = '', reason = '' } = {}) {
    const before = this.beginningBalance();
    this.state.config.beginningBalance = round2(Number(amount) || 0);
    const after = this.beginningBalance();
    if (after !== before) {
      this._audit('settings.beginning_balance',
        `Beginning balance ₱${pesoPlain(before)} → ₱${pesoPlain(after)}${reason ? ' · ' + reason : ''}${source ? ' (' + source + ')' : ''}`,
        { before, after, source, reason });
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

  // Net balance per guest+room, settled BY TRANSACTION #.
  //
  // Each NATIVE (live) deposit is its own open balance, drawn down only by a refund
  // that (a) links to it via `refundsSeq` / `reversesId`, or failing that (b) is a
  // LATER refund under the same guest+room. A refund can NEVER settle a deposit
  // created after it — that closes the cross-stay "namesake" hole where, e.g., a
  // 2025 refund for one LUISA in room 403 wrongly netted against a 2026 deposit by a
  // different LUISA in 403. Each deposit #, therefore, keeps its own true value.
  //
  // IMPORTED history (id `imp_*` / staff `import`) is left exactly as it was — a
  // single net bucket per guest+room — because those 8k+ refunds were never linked by
  // number and re-deriving them would only resurrect stale tags. `held − over` equals
  // the old plain name+room net to the cent, so COH reconciliation is unchanged.
  _guestNets() {
    const isImport = (e) => (typeof e.id === 'string' && e.id.startsWith('imp_')) || e.staff === 'import';
    const groups = new Map();
    for (const e of this.state.ledger) {
      // Adjustments are COH-level reconciliations, never a guest holding — they are
      // accounted for solely by reconciliation().adjustments. Including one here (e.g.
      // an adjustment mis-tagged with a guest like "N/A") would double-count it: once
      // in `held` and again in `adjustments`, breaking held−over == coh−beginning−adj.
      if (e.kind === 'adjustment') continue;
      const g = (e.guest || '').toUpperCase().trim();
      const r = (e.room || '').toUpperCase().trim();
      if (!g && !r) continue;
      let cur = groups.get(`${g}|${r}`);
      if (!cur) { cur = { guest: e.guest || '', room: e.room || '', entries: [] }; groups.set(`${g}|${r}`, cur); }
      if (!cur.guest && e.guest) cur.guest = e.guest;
      if (!cur.room && e.room) cur.room = e.room;
      cur.entries.push(e);
    }
    const out = [];
    for (const cur of groups.values()) {
      const entries = cur.entries.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
      let legacyNet = 0, nativeOrphan = 0, lastTs = '';
      const legacyItems = {}, netItems = {}, legacyTowels = [];
      const lots = [], bySeq = new Map(), byId = new Map(); // native open deposit lots
      for (const e of entries) {
        const signed = e.amount * e.direction;
        const it = e.itemName || 'Item';
        netItems[it] = round2((netItems[it] || 0) + signed); // raw net (for the over/attention view)
        if (isImport(e)) { // history: one net bucket, untouched
          legacyNet = round2(legacyNet + signed);
          legacyItems[it] = round2((legacyItems[it] || 0) + signed);
          if (e.kind === 'deposit' && isTowelItem(e.itemName)) for (const t of towelTokens(entryTowelNo(e))) if (!legacyTowels.includes(t)) legacyTowels.push(t);
          continue;
        }
        if (e.kind === 'deposit') { // a native deposit opens its own lot
          if (e.ts > lastTs) lastTs = e.ts;
          const lot = { seq: e.seq, ts: e.ts, itemTypeId: e.itemTypeId, itemName: e.itemName, towelNo: entryTowelNo(e), remaining: e.amount };
          lots.push(lot); bySeq.set(e.seq, lot); byId.set(e.id, lot);
        } else if (e.kind === 'exchange') {
          // Swap the held tag on the linked lot; balance/open status unchanged (amount 0).
          if (e.exchangesSeq != null) { const d = bySeq.get(e.exchangesSeq); const nt = towelTokens(e.towelNo); if (d && nt.length) d.towelNo = nt.join(', '); }
        } else if (signed < 0) { // a native settlement: link → reversal → later same-key lots
          let need = -signed;
          if (e.reversesId && byId.has(e.reversesId)) { const l = byId.get(e.reversesId); const u = Math.min(l.remaining, need); l.remaining = round2(l.remaining - u); need = round2(need - u); }
          if (need > 0.005 && e.refundsSeq != null && bySeq.has(e.refundsSeq)) { const l = bySeq.get(e.refundsSeq); const u = Math.min(l.remaining, need); l.remaining = round2(l.remaining - u); need = round2(need - u); }
          for (const l of lots) { if (need <= 0.005) break; if (l.remaining <= 0.005 || l.ts > e.ts) continue; const u = Math.min(l.remaining, need); l.remaining = round2(l.remaining - u); need = round2(need - u); }
          if (need > 0.005) nativeOrphan = round2(nativeOrphan + need); // refunded more than any matching deposit
        } else if (signed > 0) { // positive non-deposit (e.g. reversal of a refund) — also a lot
          const lot = { seq: e.seq, ts: e.ts, itemTypeId: e.itemTypeId, itemName: e.itemName, towelNo: entryTowelNo(e), remaining: e.amount };
          lots.push(lot); if (e.seq != null) bySeq.set(e.seq, lot);
        }
      }
      const open = lots.filter((l) => l.remaining > 0.005);
      const held = round2(open.reduce((s, l) => s + l.remaining, 0) + Math.max(0, legacyNet));
      const over = round2(nativeOrphan + Math.max(0, -legacyNet));
      // held-consistent item + towel breakdown (open native lots, plus legacy if it nets positive)
      const items = {}; const towels = [];
      for (const l of open) { const it = l.itemName || 'Item'; items[it] = round2((items[it] || 0) + l.remaining); if (isTowelItem(l.itemName)) for (const t of towelTokens(l.towelNo)) if (!towels.includes(t)) towels.push(t); }
      if (legacyNet > 0.005) { for (const [k, v] of Object.entries(legacyItems)) if (v > 0.005) items[k] = round2((items[k] || 0) + v); for (const t of legacyTowels) if (!towels.includes(t)) towels.push(t); }
      const openDeposits = open
        .filter((l) => typeof l.seq === 'number')
        .map((l) => ({ seq: l.seq, ts: l.ts, itemTypeId: l.itemTypeId, itemName: l.itemName, amount: l.remaining, towelNo: l.towelNo }))
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.seq - a.seq)); // newest first
      out.push({ guest: cur.guest, room: cur.room, held, over, items, netItems, towels, lastTs, openDeposits });
    }
    return out;
  }

  // True when this device holds records made AT THE DESK, as opposed to a ledger
  // that is purely bootstrap/imported data loaded from a file. A bootstrap-only
  // ledger is not authoritative — it should take the repo's record rather than
  // defend its own. Imported rows are written with staffRole 'system'.
  hasOwnRecords() {
    return this.state.ledger.some((e) => e.staffRole && e.staffRole !== 'system');
  }

  // Look up a ledger entry by its sequence number (the visible transaction #).
  entryBySeq(seq) { seq = Number(seq); return this.state.ledger.find((e) => e.seq === seq) || null; }

  // ------------------------------------------------------- passport deposits
  // A passport can SUBSTITUTE for the cash deposit on any item: the guest borrows
  // (e.g.) a ₱1,000 towel but leaves their passport instead of cash. So the deposit's
  // cash value is ₱0 (COH untouched), the item still goes OUT, the passport is held
  // (tied to a MEWS reservation #), and the deposit's nominal value is kept for
  // reference. A passport-held deposit is any deposit with a `mewsRes` set. Because
  // it's ₱0 it never shows in the cash "outstanding" list — tracked here instead.
  heldPassports() {
    const linked = new Set(); const reversed = new Set();
    for (const e of this.state.ledger) {
      if (e.kind === 'refund' && e.refundsSeq != null) linked.add(e.refundsSeq);
      if (e.reversesId) reversed.add(e.reversesId);
    }
    const out = [];
    for (const e of this.state.ledger) {
      if (e.kind !== 'deposit' || !e.mewsRes) continue;
      if (linked.has(e.seq) || reversed.has(e.id)) continue;
      out.push({ seq: e.seq, ts: e.ts, guest: e.guest, room: e.room, mewsRes: e.mewsRes || '', staff: e.staff, pax: e.pax, itemName: e.itemName, towelNo: entryTowelNo(e), value: e.unitAmount || 0 });
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.seq - a.seq)); // newest first
    return out;
  }

  // Return a held passport AND the item it secured: books a ₱0 refund linked to the
  // deposit, carrying the item/towel # so the towel tracker marks the towel back.
  // No cash moves. Returns the entry, or null if already returned.
  returnPassport(seq) {
    const dep = this.entryBySeq(seq);
    if (!dep || dep.kind !== 'deposit' || !dep.mewsRes) return null;
    if (this.state.ledger.some((e) => e.kind === 'refund' && e.refundsSeq === dep.seq)) return null; // already returned
    const shift = this.ensureShift();
    const towelNo = entryTowelNo(dep);
    const e = this._append({
      kind: 'refund', direction: -1, // amount 0 → COH unaffected; -1 just marks it a return
      itemTypeId: dep.itemTypeId, itemName: dep.itemName,
      qty: dep.qty || 1, unitAmount: 0, amount: 0,
      guest: dep.guest, room: dep.room, mewsRes: dep.mewsRes, towelNo, refundsSeq: dep.seq,
      note: `Passport + ${dep.itemName || 'item'} returned${dep.mewsRes ? ` · MEWS ${dep.mewsRes}` : ''} (deposit #${dep.seq})`,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('passport.return', `Passport returned · ${dep.guest || dep.room || '—'}${dep.mewsRes ? ` · MEWS ${dep.mewsRes}` : ''} (deposit #${dep.seq})`,
      { seq: dep.seq, guest: dep.guest, room: dep.room, mewsRes: dep.mewsRes, itemName: dep.itemName });
    return e;
  }

  // Convert a passport deposit to CASH: the guest pays the deposit, gets their
  // passport back, and the item stays out — now backed by cash. Books a ₱0
  // passport-close (linked, WITHOUT a towel # so the item is NOT marked returned —
  // it never came back) PLUS a normal cash deposit (carries the towel #), so COH
  // rises by `amount` and the guest now holds a regular cash deposit.
  convertPassportToCash(seq, { amount } = {}) {
    const dep = this.entryBySeq(seq);
    if (!dep || dep.kind !== 'deposit' || !dep.mewsRes) return null;
    if (this.state.ledger.some((e) => e.kind === 'refund' && e.refundsSeq === dep.seq)) return null; // already settled
    const value = round2(amount != null ? Number(amount) : Number(dep.unitAmount || 0));
    if (!(value > 0)) return null;
    const shift = this.ensureShift();
    const close = this._append({
      kind: 'refund', direction: -1, // amount 0 → COH unaffected by the close itself
      itemTypeId: dep.itemTypeId, itemName: dep.itemName,
      qty: 1, unitAmount: 0, amount: 0,
      guest: dep.guest, room: dep.room, mewsRes: dep.mewsRes, refundsSeq: dep.seq,
      note: `Passport returned — deposit converted to cash (was deposit ${dep.seq})`,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    const cash = this.addDeposit({
      itemTypeId: dep.itemTypeId, qty: dep.qty || 1, unitAmount: value, amount: value,
      guest: dep.guest, room: dep.room, pax: dep.pax,
      towelNo: entryTowelNo(dep),
      note: `Cash deposit (converted from passport, was deposit ${dep.seq})`,
    });
    this._audit('passport.convert',
      `Passport → cash · ${dep.guest || dep.room || '—'}${dep.mewsRes ? ` · MEWS ${dep.mewsRes}` : ''} · ₱${pesoPlain(value)} (deposit #${dep.seq} → #${cash.seq})`,
      { fromSeq: dep.seq, toSeq: cash.seq, amount: value, guest: dep.guest, room: dep.room, mewsRes: dep.mewsRes });
    return { close, cash, value };
  }

  // ------------------------------------------------------ private-room holds
  // The third way to take an item out. A passport substitutes collateral for the
  // cash; a PRIVATE ROOM substitutes the room itself — the guest is staying in a
  // private room, so the item is signed out against them with no cash and no
  // document held. Both deposit and check-out are ₱0, so this NEVER moves money:
  // COH is identical before and after, and it cannot appear in any cash total.
  // What it does do is keep the towel correctly marked OUT until they check out.
  heldPrivateRooms() {
    const linked = new Set(); const reversed = new Set();
    for (const e of this.state.ledger) {
      if (e.kind === 'refund' && e.refundsSeq != null) linked.add(e.refundsSeq);
      if (e.reversesId) reversed.add(e.reversesId);
    }
    const out = [];
    for (const e of this.state.ledger) {
      if (e.kind !== 'deposit' || !e.privateRoom) continue;
      if (linked.has(e.seq) || reversed.has(e.id)) continue;
      out.push({ seq: e.seq, ts: e.ts, guest: e.guest, room: e.room, staff: e.staff, pax: e.pax,
        itemName: e.itemName, qty: e.qty, towelNo: entryTowelNo(e), value: e.unitAmount || 0, note: e.note });
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.seq - a.seq)); // newest first
    return out;
  }

  // Guest checked out: close the private-room hold and bring the item back. Books
  // a ₱0 refund linked to the deposit and carrying the towel #, so the towel
  // tracker marks the towel returned — the same mechanism as returning a passport.
  // No cash moves in either direction. Returns null if it was already closed.
  checkoutPrivateRoom(seq, { note = '' } = {}) {
    const dep = this.entryBySeq(seq);
    if (!dep || dep.kind !== 'deposit' || !dep.privateRoom) return null;
    if (this.state.ledger.some((e) => e.kind === 'refund' && e.refundsSeq === dep.seq)) return null; // already closed
    const shift = this.ensureShift();
    const towelNo = entryTowelNo(dep);
    const extra = String(note || '').trim();
    const e = this._append({
      kind: 'refund', direction: -1, // amount 0 → COH unaffected; -1 only marks it a return
      itemTypeId: dep.itemTypeId, itemName: dep.itemName,
      qty: dep.qty || 1, unitAmount: 0, amount: 0,
      guest: dep.guest, room: dep.room, towelNo, privateRoom: true, refundsSeq: dep.seq,
      note: `Guest checked out — private room hold closed, ${dep.itemName || 'item'} returned (deposit #${dep.seq})${extra ? ' · ' + extra : ''}`,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('privateroom.checkout',
      `Guest checked out · ${dep.guest || dep.room || '—'}${dep.room ? ' · Rm ' + dep.room : ''} · ${dep.itemName || 'item'}${towelNo ? ' #' + towelNo : ''} returned (deposit #${dep.seq})`,
      { seq: dep.seq, guest: dep.guest, room: dep.room, itemName: dep.itemName, towelNo });
    return e;
  }

  // Set of deposit transaction #s that are still refundable (open deposit of a guest
  // who is currently outstanding). Drives the clickable transaction # in the ledger.
  refundableDepositSeqs() {
    const s = new Set();
    for (const g of this._guestNets()) if (g.held > 0.005) for (const d of g.openDeposits) s.add(d.seq);
    return s;
  }

  // Guests who still hold a deposit (owed back). Positive balances only.
  outstandingByGuest() {
    return this._guestNets().filter((x) => x.held > 0.005).sort((a, b) => b.held - a.held);
  }

  // Guests refunded MORE than they deposited under this exact name/room — usually
  // a name/room mismatch or a refund of a pre-system deposit. Worth a look.
  overReturnedByGuest() {
    return this._guestNets().filter((x) => x.over > 0.005).sort((a, b) => b.over - a.over);
  }

  // Reconciliation that ALWAYS ties back to COH:
  //   beginningBalance + held − overReturned + adjustments = COH.
  // (Adjustment entries carry no guest, so they sit outside held/over.)
  reconciliation() {
    const nets = this._guestNets();
    const held = round2(nets.reduce((s, x) => s + Math.max(0, x.held), 0));
    const over = round2(nets.reduce((s, x) => s + Math.max(0, x.over), 0));
    const adjustments = round2(this.state.ledger
      .filter((e) => e.kind === 'adjustment')
      .reduce((s, e) => s + e.amount * e.direction, 0));
    return {
      beginning: this.beginningBalance(),
      held, over, adjustments, coh: this.coh(),
      positives: nets.filter((x) => x.held > 0.005).length,
      negatives: nets.filter((x) => x.over > 0.005).length,
    };
  }

  // ---------------------------------------------------- towel tracker (inventory)
  // A physical-towel inventory layered ON TOP of the cash ledger. The ledger stays
  // the financial source of truth; this projects each Towel deposit/refund (which
  // carry a tag number) into per-towel state: available → out → back/lost. It is a
  // CLEAN, going-forward system: only events at/after `startedAt` count, because
  // historical refunds never recorded a towel number (see the import history).
  get towelTracker() { return this.state.config.towelTracker || { enabled: false, startedAt: null }; }
  towelBaseline() { const t = this.towelTracker; return t.enabled ? (t.startedAt || null) : null; }
  enableTowelTracker() {
    if (this.towelTracker.enabled) return this.towelTracker;
    this.state.config.towelTracker = { enabled: true, startedAt: nowISO() };
    this._audit('towel.enable', 'Towel tracker enabled — inventory tracking starts now', { startedAt: this.state.config.towelTracker.startedAt });
    this.save();
    return this.towelTracker;
  }
  // Wipe the towel tracker to a clean slate (inventory list, admin resolutions,
  // baseline) so the team can start fresh. The cash LEDGER is untouched — only the
  // towel-inventory layer (which lives outside the hash chain). Re-enabling later
  // sets a new baseline, so earlier test deposits won't reappear as "out".
  resetTowelTracker() {
    const had = (this.state.towels || []).length;
    this.state.towels = [];
    this.state.towelLog = [];
    this.state.config.towelTracker = { enabled: false, startedAt: null };
    this._audit('towel.reset', `Towel tracker reset — cleared ${had} towel${had === 1 ? '' : 's'} and returned to setup`, { clearedTowels: had });
    this.save();
  }

  // Add towel numbers to the master inventory. Accepts an array of numbers/strings;
  // de-duplicates against what's already there. Returns the list actually added.
  addTowels(nos) {
    const have = new Set((this.state.towels || []).map((t) => t.no));
    const added = [];
    for (const raw of nos || []) {
      const no = normTowelNo(raw);
      if (!no || have.has(no)) continue;
      have.add(no);
      this.state.towels.push({ no, createdAt: nowISO(), createdBy: this.session ? this.session.name : 'system' });
      added.push(no);
    }
    if (added.length) {
      this._audit('towel.add', `Added ${added.length} towel${added.length > 1 ? 's' : ''} to inventory`, { count: added.length, sample: added.slice(0, 50) });
      this.save();
    }
    return added;
  }
  // Hard-remove a towel from the master list (for a typo at setup). History is kept.
  removeTowel(no) {
    no = normTowelNo(no);
    const i = (this.state.towels || []).findIndex((t) => t.no === no);
    if (i < 0) return false;
    this.state.towels.splice(i, 1);
    this._audit('towel.remove', `Removed towel #${no} from inventory`, { no });
    this.save();
    return true;
  }
  // Resolve a lost (or any) towel: 'found' returns it to service, 'writeoff' retires
  // it permanently. Inventory-only (no cash); the cash was settled at refund time.
  resolveTowel(no, action, { note = '' } = {}) {
    no = normTowelNo(no);
    if (!['found', 'writeoff', 'restore'].includes(action)) return null;
    const ev = { id: uid('twl'), no, action, ts: nowISO(), by: this.session ? this.session.name : 'system', note: String(note || '').trim() };
    this.state.towelLog.push(ev);
    const verb = action === 'found' ? 'marked FOUND (back in service)' : action === 'writeoff' ? 'WRITTEN OFF (retired)' : 'restored';
    this._audit('towel.' + action, `Towel #${no} ${verb}${ev.note ? ' · ' + ev.note : ''}`, { no, action });
    this.save();
    return ev;
  }

  // Settle a LOST towel: refund the held deposit (X) so the guest is cleared, and
  // keep an admin-entered charge (K, 0..X) as towel-loss income — so cash only
  // drops by X−K and COH stays exact. Books two reconciling entries + flags lost.
  recordTowelLoss({ itemTypeId, guest, room, towelNo, deposit, refundsSeq }) {
    const item = this.itemById(itemTypeId);
    const value = round2(Number(deposit) || 0); // the deposit the guest forfeits
    const shift = this.ensureShift();
    // A lost towel moves NO cash. The deposit the guest already paid stays in the
    // drawer — they simply don't get it back, and they're not charged anything extra.
    // So COH is unchanged. We book a ₱0 entry that flags the towel LOST (drives the
    // inventory status + the lost indicator) and closes the deposit so it can't be
    // refunded. `unitAmount` carries the forfeited value for the indicator only — it
    // does NOT affect COH (amount is 0).
    const e = this._append({
      kind: 'refund', direction: -1, itemTypeId, itemName: item ? item.name : 'Towel',
      qty: 1, unitAmount: value, amount: 0, // amount 0 → COH unchanged (no addition/subtraction)
      guest, room, towelNo, towelLost: true, refundsSeq,
      note: `Towel ${towelNo} LOST — ₱${pesoPlain(value)} deposit forfeited (kept, no refund · no cash change)`,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('towel.lost', `Towel #${towelNo} LOST · ${guest || room || '—'} · ₱${pesoPlain(value)} deposit forfeited (no cash change)`,
      { towelNo, guest, room, value });
    return e;
  }

  // Lost-towel indicator: how many towels are currently lost and the total cash
  // value forfeited on them (the deposits the hostel kept). Pure read.
  lostTowelStats() {
    const lost = this.towelStatus().filter((t) => t.status === 'lost');
    const valueByNo = new Map();
    for (const e of this.state.ledger) {
      if (e.kind === 'refund' && e.towelLost) for (const no of towelTokens(entryTowelNo(e))) valueByNo.set(no, e.unitAmount || 0); // latest wins (ledger order)
    }
    let value = 0;
    for (const t of lost) value = round2(value + (valueByNo.get(t.no) || 0));
    return { count: lost.length, value };
  }

  // Towel exchange: the guest swaps towel `oldTowelNo` for `newTowelNo`. The old one
  // goes back to inventory, the new one goes out — but NO cash moves, so COH and the
  // guest's held balance are untouched (amount 0, direction 0). Links to the original
  // deposit via exchangesSeq WITHOUT settling it (the deposit stays refundable).
  recordTowelExchange({ itemTypeId, guest, room, oldTowelNo, newTowelNo, exchangesSeq, note }) {
    const oldNo = String(oldTowelNo || '').trim();
    const newNo = String(newTowelNo || '').trim();
    const item = this.itemById(itemTypeId);
    const shift = this.ensureShift();
    const extra = String(note || '').trim();
    const e = this._append({
      kind: 'exchange', direction: 0,
      itemTypeId, itemName: item ? item.name : 'Towel',
      qty: 1, unitAmount: 0, amount: 0,
      guest, room,
      towelNo: newNo, oldTowelNo: oldNo, exchangesSeq,
      note: `Towel exchange: #${oldNo} → #${newNo}${exchangesSeq ? ` (deposit #${exchangesSeq})` : ''}${extra ? ' · ' + extra : ''}`,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('towel.exchange',
      `Towel exchange · ${guest || room || '—'} · #${oldNo} → #${newNo}${exchangesSeq ? ` (deposit #${exchangesSeq})` : ''}`,
      { oldTowelNo: oldNo, newTowelNo: newNo, exchangesSeq, guest, room });
    return e;
  }

  // Admin-only towel-number CORRECTION: fix the tag recorded against an open deposit
  // (mis-typed at deposit, or the guest is actually holding a different towel) WITHOUT
  // issuing a refund. Mechanically it is a cash-neutral tag change — kind 'exchange',
  // amount 0, direction 0 — so it flows through EVERY projection: _guestNets swaps the
  // lot's tag (→ Outstanding), towelStatus moves the old tag to available and the new
  // one to out (→ Towel Tracker), and it lands in the ledger + activity log. The
  // deposit stays open and refundable; COH and the held balance are untouched.
  recordTowelNumberChange({ itemTypeId, guest, room, oldTowelNo, newTowelNo, exchangesSeq, note }) {
    const oldNo = String(oldTowelNo || '').trim();
    const newNo = String(newTowelNo || '').trim();
    const item = this.itemById(itemTypeId);
    const shift = this.ensureShift();
    const extra = String(note || '').trim();
    const e = this._append({
      kind: 'exchange', direction: 0,
      itemTypeId, itemName: item ? item.name : 'Towel',
      qty: 1, unitAmount: 0, amount: 0,
      guest, room,
      towelNo: newNo, oldTowelNo: oldNo, exchangesSeq,
      note: `Towel # corrected: #${oldNo || '—'} → #${newNo}${exchangesSeq ? ` (deposit #${exchangesSeq})` : ''} · admin${extra ? ' · ' + extra : ''}`,
      shiftId: shift.id, shiftLabel: shift.label,
    });
    this._audit('towel.correct',
      `Towel # corrected · ${guest || room || '—'} · #${oldNo || '—'} → #${newNo}${exchangesSeq ? ` (deposit #${exchangesSeq})` : ''}`,
      { oldTowelNo: oldNo, newTowelNo: newNo, exchangesSeq, guest, room, correction: true });
    return e;
  }

  // The live inventory projection. Returns { no, status, holder, registered, lastEvent }
  // per towel; status: available | out | lost | writeoff. Pure read — safe per render.
  //
  // Registered towels SYNC from the FULL ledger history, so a number already out
  // before it was added to inventory picks up its guest/room/dates. Unregistered
  // numbers only count from the baseline, so thousands of historical tags don't
  // flood the list. An "out" reading is confirmed against the depositing guest's
  // OUTSTANDING balance — so a return booked without a tag number (the old flow)
  // still flips the towel back to available, tying towel state to the cash truth.
  towelStatus() {
    if (!this.towelTracker.enabled) return [];
    const baseline = this.towelBaseline();
    const masterSet = new Set((this.state.towels || []).map((t) => t.no));
    // Guest+room keys that currently "hold" — i.e. their towel is genuinely still
    // out. Cash deposits show via a positive net; PASSPORT and PRIVATE-ROOM deposits
    // are ₱0 cash but the item is still out, so a guest with either kind of open
    // non-cash deposit counts too. Without this a private-room towel would read as
    // "available" the moment it was handed over — the cash truth says ₱0 held, but
    // the physical truth is that the guest has it.
    const outstanding = new Set();
    const gk = (e) => `${(e.guest || '').toUpperCase().trim()}|${(e.room || '').toUpperCase().trim()}`;
    for (const g of this._guestNets()) {
      if (g.held > 0.005) outstanding.add(`${(g.guest || '').toUpperCase().trim()}|${(g.room || '').toUpperCase().trim()}`);
    }
    const linkedReturns = new Set(); const reversedDep = new Set();
    for (const e of this.state.ledger) {
      if (e.kind === 'refund' && e.refundsSeq != null) linkedReturns.add(e.refundsSeq);
      if (e.reversesId) reversedDep.add(e.reversesId);
    }
    for (const e of this.state.ledger) {
      if (e.kind === 'deposit' && (e.mewsRes || e.privateRoom) && !linkedReturns.has(e.seq) && !reversedDep.has(e.id)) outstanding.add(gk(e));
    }
    const events = new Map(); // no -> [{ type, ts, seq, guest, room, staff }]
    // Registered → full history; unregistered → baseline-onward only.
    const pushEvt = (no, type, e) => {
      if (!masterSet.has(no) && !(baseline && e.ts >= baseline)) return;
      if (!events.has(no)) events.set(no, []);
      events.get(no).push({ type, ts: e.ts, seq: e.seq, guest: e.guest, room: e.room, staff: e.staff });
    };
    for (const e of this.state.ledger) {
      if (!isTowelItem(e.itemName)) continue;
      if (e.kind === 'exchange') {
        for (const no of towelTokens(e.towelNo)) pushEvt(no, 'out', e);     // new towel goes out
        for (const no of towelTokens(e.oldTowelNo)) pushEvt(no, 'in', e);   // old towel returns
        continue;
      }
      if (e.kind !== 'deposit' && e.kind !== 'refund') continue;
      const toks = towelTokens(entryTowelNo(e));
      if (!toks.length) continue;
      const type = e.kind === 'deposit' ? 'out' : (e.towelLost ? 'lost' : 'in');
      for (const no of toks) pushEvt(no, type, e);
    }
    // Latest admin resolution per towel.
    const res = new Map();
    for (const r of (this.state.towelLog || [])) {
      const cur = res.get(r.no);
      if (!cur || r.ts >= cur.ts) res.set(r.no, r);
    }
    // Latest laundry action per towel (dirty/washing/clean), for the laundry overlay.
    // The dirty baseline is the TOWEL-TRACKER setup time (not the recording cycle
    // anchor), so a returned towel is Dirty LIVE — immediately on refund/exchange —
    // regardless of the analytics cycle start. The cycle anchor only drives reports.
    const rec = this.state.config.towelRecording || {};
    const recStart = rec.enabled ? this.towelBaseline() : null;
    const laundry = new Map();
    // `>=` so the last-pushed action wins when two share a timestamp (same millisecond).
    if (recStart != null) for (const a of (this.state.laundryLog || [])) { const c = laundry.get(a.no); if (!c || a.ts >= c.ts) laundry.set(a.no, a); }
    const allNos = new Set([...masterSet, ...events.keys()]);
    const out = [];
    for (const no of allNos) {
      // Order by transaction DATE (when the towel actually moved), not insert seq —
      // imported rows aren't strictly seq-ordered by date. `last` = most recent.
      const evs = (events.get(no) || []).slice().sort(byTsThenSeq);
      const last = evs[evs.length - 1] || null;
      let status = 'available';
      let holder = null;
      if (last) {
        if (last.type === 'out') {
          const key = `${(last.guest || '').toUpperCase().trim()}|${(last.room || '').toUpperCase().trim()}`;
          if (outstanding.has(key)) { status = 'out'; holder = { guest: last.guest, room: last.room, ts: last.ts, staff: last.staff }; }
          else status = 'available'; // deposit already settled (return may have had no tag #)
        } else if (last.type === 'lost') status = 'lost';
        else status = 'available';
      }
      const r = res.get(no);
      if (r && (!last || r.ts >= last.ts)) {
        if (r.action === 'found' || r.action === 'restore') { status = 'available'; holder = null; }
        else if (r.action === 'writeoff') { status = 'writeoff'; holder = null; }
      }
      // Laundry overlay (when recording is on): a returned towel is Dirty (held out
      // of the available pool) until washed & marked Clean. Only returns at/after the
      // recording start count, so old history doesn't flood the dirty list.
      if (recStart != null && status === 'available') {
        const lastRet = evs.filter((e) => e.type === 'in').pop();
        const lastRetTs = lastRet ? lastRet.ts : '';
        const ld = laundry.get(no);
        if (ld && (!lastRetTs || ld.ts >= lastRetTs)) {
          if (ld.status === 'washing') status = 'washing';
          else if (ld.status === 'dirty') status = 'dirty';
          // 'clean' → stays available
        } else if (lastRetTs && lastRetTs >= recStart) {
          status = 'dirty'; // came back during the recording era, not yet processed
        }
      }
      out.push({ no, status, holder, registered: masterSet.has(no), lastEvent: last });
    }
    out.sort((a, b) => {
      const na = parseInt(a.no, 10), nb = parseInt(b.no, 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return String(a.no).localeCompare(String(b.no));
    });
    return out;
  }

  // Every deposit/refund tied to a towel number, MOST RECENT first (by date) — the
  // full record behind a tag (guest, room, amount, date, staff, lost flag).
  towelHistory(no) {
    const want = normTowelNo(no);
    if (!want) return [];
    const out = [];
    for (const e of this.state.ledger) {
      if (!isTowelItem(e.itemName)) continue;
      if (e.kind === 'exchange') {
        if (!towelTokens(e.towelNo).includes(want) && !towelTokens(e.oldTowelNo).includes(want)) continue;
        out.push({ seq: e.seq, ts: e.ts, kind: 'exchange', guest: e.guest, room: e.room, amount: 0, direction: 0, staff: e.staff, towelLost: false, oldTowelNo: e.oldTowelNo, towelNo: e.towelNo });
        continue;
      }
      if (e.kind !== 'deposit' && e.kind !== 'refund') continue;
      if (!towelTokens(entryTowelNo(e)).includes(want)) continue;
      out.push({ seq: e.seq, ts: e.ts, kind: e.kind, guest: e.guest, room: e.room, amount: e.amount, direction: e.direction, staff: e.staff, towelLost: !!e.towelLost });
    }
    return out.sort((a, b) => -byTsThenSeq(a, b)); // newest first
  }
  // Headline counts for the dashboard card. `inService` excludes written-off towels.
  towelSummary() {
    const s = this.towelStatus();
    const c = { available: 0, out: 0, lost: 0, writeoff: 0, dirty: 0, washing: 0, unregistered: 0 };
    for (const t of s) {
      c[t.status] = (c[t.status] || 0) + 1;
      if (!t.registered && t.status !== 'writeoff') c.unregistered += 1;
    }
    c.inService = c.available + c.out + c.lost + c.dirty + c.washing;
    return c;
  }

  // ----------------------------------------------- dirty-towel / laundry tracking
  get towelRecording() { return this.state.config.towelRecording || { enabled: false, startedAt: null, hours: 24 }; }
  // Set (and enable) the recording period: an anchor start + a length in hours (≥1).
  // Turning this on activates dirty-towel tracking; returns from `startedAt` onward
  // become Dirty until washed & marked Clean.
  setTowelRecording({ startedAt, hours }) {
    const h = Math.max(1, Math.round(Number(hours) || 24));
    const start = startedAt || nowISO();
    this.state.config.towelRecording = { enabled: true, startedAt: start, hours: h };
    this._audit('towel.recording', `Towel recording period set · ${h}h cycle from ${start}`, { startedAt: start, hours: h });
    this.save();
    return this.towelRecording;
  }
  // Move towel(s) through the laundry cycle: 'dirty' (add), 'washing' (sent to
  // laundry), 'clean' (back to available — leaves the dirty list). Inventory-only.
  // status: 'dirty' (add / revert back to dirty), 'washing' (sent to laundry),
  // 'clean' (washed → available, counts in analytics), 'remove' (off the list →
  // available, a correction — NOT counted as cleaned).
  setLaundryStatus(nos, status, { by } = {}) {
    if (!['dirty', 'washing', 'clean', 'remove'].includes(status)) return [];
    const list = Array.isArray(nos) ? nos : [nos];
    const actor = by || (this.session ? this.session.name : 'system');
    const done = [];
    for (const raw of list) {
      const no = normTowelNo(raw);
      if (!no) continue;
      this.state.laundryLog.push({ id: uid('lnd'), no, status, ts: nowISO(), by: actor });
      done.push(no);
    }
    if (done.length) {
      const verb = { washing: 'sent to laundry (being washed)', clean: 'marked clean', dirty: 'marked dirty', remove: 'removed from the laundry list' }[status];
      this._audit('towel.laundry', `${done.length} towel${done.length > 1 ? 's' : ''} ${verb}`, { count: done.length, status, sample: done.slice(0, 50) });
      this.save();
    }
    return done;
  }
  // The recording window [start, end) containing `atISO` (defaults to now), tiled
  // from the configured anchor. Returns null when recording is off. (For analytics.)
  currentRecordingPeriod(atISO) {
    const rec = this.towelRecording;
    if (!rec.enabled || !rec.startedAt) return null;
    const ms = rec.hours * 3600 * 1000;
    const anchor = Date.parse(rec.startedAt);
    const now = Date.parse(atISO || nowISO());
    if (!isFinite(anchor) || !isFinite(now) || !(ms > 0)) return null;
    const k = now >= anchor ? Math.floor((now - anchor) / ms) : 0;
    const startN = now >= anchor ? anchor + k * ms : anchor;
    return { start: new Date(startN).toISOString(), end: new Date(startN + ms).toISOString(), hours: rec.hours, index: k };
  }

  // Timestamps (one per physical towel) of laundry-relevant events since recording
  // started: `dirty` = a towel came back (refund/exchange) or was added dirty,
  // `wash` = sent to laundry, `clean` = marked clean. Foundation for period reports.
  _laundryEvents() {
    // Floor at the tracker baseline (same as the live dirty list). Dirty INFLOW is
    // guest returns only (refund/exchange) — manual add / back-to-dirty are NOT
    // inflow, so reverting a towel never inflates the analytics.
    const recStart = this.towelBaseline() || '';
    const dirty = [], wash = [], clean = [];
    for (const e of this.state.ledger) {
      if (!isTowelItem(e.itemName) || e.ts < recStart) continue;
      if (e.kind === 'refund' && !e.towelLost) for (const t of towelTokens(entryTowelNo(e))) dirty.push(e.ts);
      else if (e.kind === 'exchange') for (const t of towelTokens(e.oldTowelNo)) dirty.push(e.ts);
    }
    for (const a of (this.state.laundryLog || [])) {
      if (a.ts < recStart) continue;
      if (a.status === 'washing') wash.push(a.ts);
      else if (a.status === 'clean') clean.push(a.ts);
    }
    return { dirty, wash, clean };
  }

  // Per-period laundry report (oldest→newest), `count` windows back from the current
  // one. granularity: 'day' = one recording cycle, 'week' = 7 cycles, 'month' = 30.
  // Each row: { index, start, end, dirtyIn, sentToWash, cleaned }.
  laundryPeriodReport(granularity = 'day', count = 30) {
    const rec = this.towelRecording;
    if (!rec.enabled || !rec.startedAt) return [];
    const mult = granularity === 'week' ? 7 : granularity === 'month' ? 30 : 1;
    const ms = rec.hours * mult * 3600 * 1000;
    const anchor = Date.parse(rec.startedAt);
    const now = Date.parse(nowISO());
    if (!isFinite(anchor) || !(ms > 0)) return [];
    const curIdx = now >= anchor ? Math.floor((now - anchor) / ms) : 0;
    const ev = this._laundryEvents();
    const inWin = (arr, s, e) => { let n = 0; for (const ts of arr) { const t = Date.parse(ts); if (t >= s && t < e) n++; } return n; };
    const rows = [];
    for (let i = Math.max(0, curIdx - count + 1); i <= curIdx; i++) {
      const s = anchor + i * ms, e = s + ms;
      rows.push({ index: i, start: new Date(s).toISOString(), end: new Date(e).toISOString(), dirtyIn: inWin(ev.dirty, s, e), sentToWash: inWin(ev.wash, s, e), cleaned: inWin(ev.clean, s, e) });
    }
    return rows;
  }

  // Current period vs the previous one, for the analytics comparison.
  laundryCompare(granularity = 'day') {
    const rows = this.laundryPeriodReport(granularity, 2);
    return { granularity, current: rows[rows.length - 1] || null, previous: rows.length >= 2 ? rows[rows.length - 2] : null };
  }

  // -------------------------------------------------- travelista (2nd system)
  // Shape-fix on load/import, exactly like the towel arrays above: a backup
  // written before this system existed has no `travelista` key, and must open
  // without error on every device.
  get travelista() { return this.state.travelista; }
  _normalizeTravelista() {
    const d = defaultTravelista();
    const t = this.state.travelista && typeof this.state.travelista === 'object' ? this.state.travelista : {};
    t.config = Object.assign(d.config, t.config || {});
    if (!Array.isArray(t.destinations)) t.destinations = [];
    if (!Array.isArray(t.bookers)) t.bookers = [];
    if (!Array.isArray(t.entries)) t.entries = [];
    t.enabled = !!t.enabled || t.entries.length > 0;
    this.state.travelista = t;
    return t;
  }
  // The Travelista chain is verified the same way as the ledger — same hash
  // discipline, its own genesis, so a break in one never masks the other.
  verifyTravelistaIntegrity() {
    let prev = GENESIS;
    let brokenAtSeq = null;
    for (const e of (this.state.travelista && this.state.travelista.entries) || []) {
      const { hash, ...rest } = e;
      if (rest.prevHash !== prev) { brokenAtSeq = e.seq; break; }
      if (sha256(stableStringify(rest)) !== hash) { brokenAtSeq = e.seq; break; }
      prev = hash;
    }
    this.travelistaIntegrity = { ok: brokenAtSeq == null, brokenAtSeq };
    return this.travelistaIntegrity;
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

  // --------------------------------------------------------------- staff roster
  // Manager-managed front-desk accounts. Each staff signs in with their OWN PIN.
  addStaff({ name, pin }) {
    if (!Array.isArray(this.state.staff)) this.state.staff = [];
    const s = { id: uid('staff'), name: String(name || '').trim(), pin: Store.hashPin(pin), active: true, createdAt: nowISO() };
    this.state.staff.push(s);
    this._audit('staff.add', `Added staff "${s.name}"`, { id: s.id, name: s.name });
    this.save();
    return s;
  }
  setStaffPin(id, newPin) {
    const s = (this.state.staff || []).find((x) => x.id === id);
    if (!s) return false;
    s.pin = Store.hashPin(newPin);
    this._audit('staff.pin_change', `Changed PIN for staff "${s.name}"`, { id, name: s.name });
    this.save();
    return true;
  }
  removeStaff(id) {
    const arr = this.state.staff || [];
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [s] = arr.splice(i, 1);
    this._audit('staff.remove', `Removed staff "${s.name}"`, { id, name: s.name });
    this.save();
    return true;
  }

  // --------------------------------------------------------------- admin roster
  // Elevated "Admin" accounts — each signs in (Admin tier) with their own PIN and
  // can do everything the manager tier can (Settings, voids, towel inventory, …).
  adminList() { return (this.state.admins || []).filter((a) => a.active !== false); }
  // True if `pin` belongs to the baked manager credential OR any Admin account.
  // Used by the admin-approval gate so an admin can authorise from a staff desk.
  verifyAdminPin(pin) {
    if (Store.verifyPin(pin, this.state.config.managerPin)) return true;
    return this.adminList().some((a) => Store.verifyPin(pin, a.pin));
  }
  addAdmin({ name, pin }) {
    if (!Array.isArray(this.state.admins)) this.state.admins = [];
    const a = { id: uid('admin'), name: String(name || '').trim(), pin: Store.hashPin(pin), active: true, createdAt: nowISO() };
    this.state.admins.push(a);
    this._audit('admin.add', `Added admin "${a.name}"`, { id: a.id, name: a.name });
    this.save();
    return a;
  }
  // Add an admin whose credential is ALREADY hashed. Used to seed a named admin
  // from code without the plaintext ever entering the repository — the repo is
  // public, so a password committed there is a published password. The stored
  // value is the same salted form addAdmin() produces, so login is unchanged and
  // the person can set their own credential afterwards.
  addAdminHashed({ id, name, pinHash }) {
    if (!Array.isArray(this.state.admins)) this.state.admins = [];
    const nm = String(name || '').trim();
    if (!nm || !pinHash) return null;
    if (this.state.admins.some((a) => a.id === id || a.name.toLowerCase() === nm.toLowerCase())) return null;
    const a = { id: id || uid('admin'), name: nm, pin: pinHash, active: true, createdAt: nowISO() };
    this.state.admins.push(a);
    this._audit('admin.add', `Added admin "${a.name}"`, { id: a.id, name: a.name, seeded: true });
    this.save();
    return a;
  }
  setAdminPin(id, newPin) {
    const a = (this.state.admins || []).find((x) => x.id === id);
    if (!a) return false;
    a.pin = Store.hashPin(newPin);
    this._audit('admin.pin_change', `Changed PIN for admin "${a.name}"`, { id, name: a.name });
    this.save();
    return true;
  }
  removeAdmin(id) {
    const arr = this.state.admins || [];
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [a] = arr.splice(i, 1);
    this._audit('admin.remove', `Removed admin "${a.name}"`, { id, name: a.name });
    this.save();
    return true;
  }

  // ------------------------------------------------------------------ merging
  // Union a remote state INTO this device's, losing nothing from either side.
  //
  // WHY THIS EXISTS: the backup is ONE WHOLE FILE, so two devices that both write
  // overwrite each other. And because the adoption gate (rightly) refuses to drop
  // local records, neither can ever adopt the other — they ping-pong the repo
  // forever while each holds transactions the other has never seen. That is not a
  // hypothetical: it happened here, and 25 real transactions sat on a single
  // browser until they were merged back by hand. Overwriting is the bug; merging
  // is the fix, and it is what makes it safe for EVERY device to hold a token.
  //
  // Two devices always share an identical, identically-hashed PREFIX (they grew
  // from the same backup) and differ only in their tails. So: keep the prefix
  // byte-for-byte, order both tails by time, renumber ONLY the tail, remap any
  // reference that pointed into the renumbered range, and re-chain from the
  // prefix's last hash. Nothing is edited and nothing is dropped — the append-only
  // guarantee holds; entries are only re-sequenced.
  //
  // Returns a summary of what came in, or null when there was nothing to do.
  // Fails SAFE: if any rebuilt chain does not verify, local state is untouched.
  mergeRemote(remote) {
    if (!remote || !Array.isArray(remote.ledger)) return null;
    const localIds = new Set(this.state.ledger.map((e) => e.id));
    const newLedger = remote.ledger.filter((e) => e && !localIds.has(e.id));
    const rtv = ((remote.travelista || {}).entries) || [];
    const tvIds = new Set((this.travelista.entries || []).map((e) => e.id));
    const newTv = rtv.filter((e) => e && !tvIds.has(e.id));
    const rAudit = Array.isArray(remote.audit) ? remote.audit : [];
    const audIds = new Set((this.state.audit || []).map((e) => e.id));
    const newAudit = rAudit.filter((e) => e && !audIds.has(e.id));
    if (!newLedger.length && !newTv.length && !newAudit.length) return null; // we already hold it all

    // TRUST, THEN MERGE — in that order. Merging re-hashes every entry it moves,
    // which means a corrupt or forged remote entry would come out the other side
    // looking perfectly valid: the merge would LAUNDER it. So the remote's own
    // chain must verify on its own terms first. The ledger is the money, so a
    // broken ledger chain refuses the whole merge; a broken side-chain only skips
    // itself rather than blocking real records from coming home.
    if (!Store.chainOk(remote.ledger)) {
      console.error('mergeRemote refused — the remote ledger fails its own integrity check');
      return null;
    }
    const tvTrusted = Store.chainOk(rtv);
    const auditTrusted = Store.chainOk(rAudit);
    if (!tvTrusted) newTv.length = 0;
    if (!auditTrusted) newAudit.length = 0;
    if (!newLedger.length && !newTv.length && !newAudit.length) return null;

    // LINEAGE GUARD — narrow, and deliberately so.
    //
    // Merging is normally between two records grown from a COMMON backup, so a
    // shared prefix exists. No shared entry at all means one of two very different
    // things, and treating them alike breaks one case or the other:
    //
    //   • DANGEROUS — the incoming records are BOOTSTRAP/imported rows (staffRole
    //     'system'). A device that provisioned itself offline from the CSV holds
    //     16k rows describing the SAME real transactions under different ids;
    //     unioning those would silently double the hostel's money. Refuse — and
    //     main.js hands such a device the repo's record wholesale instead.
    //
    //   • LEGITIMATE — two desks at a BRAND-NEW building both started empty and
    //     each recorded genuinely different transactions. They share no prefix
    //     only because there was nothing to share. Refusing here would strand them
    //     permanently, each keeping just its own takings — the very fault this
    //     whole merge exists to prevent.
    const bootstrapOnly = newLedger.length > 0
      && newLedger.every((e) => !e.staffRole || e.staffRole === 'system');
    const allowUnrelated = !bootstrapOnly;

    // Snapshot first: a merge that cannot be verified must change nothing.
    const backup = JSON.stringify(this.state);
    try {
      const ledger = this._mergeChain(this.state.ledger, remote.ledger, newLedger, true, allowUnrelated);
      if (ledger === null) throw new Error('ledger merge failed verification');
      const tv = newTv.length ? this._mergeChain(this.travelista.entries || [], rtv, newTv, false, true) : (this.travelista.entries || []);
      if (tv === null) throw new Error('travelista merge failed verification');
      const audit = newAudit.length ? this._mergeChain(this.state.audit || [], rAudit, newAudit, false, true) : (this.state.audit || []);
      if (audit === null) throw new Error('audit merge failed verification');

      // Everything outside the chains is unioned by identity — never dropped.
      const uni = (mine, theirs, key) => {
        const out = (mine || []).slice();
        const seen = new Set(out.map(key));
        for (const it of (theirs || [])) if (!seen.has(key(it))) { seen.add(key(it)); out.push(it); }
        return out;
      };
      const rt = remote.travelista || {};
      this.state.ledger = ledger;
      this.state.audit = audit;
      this.state.itemTypes = uni(this.state.itemTypes, remote.itemTypes, (i) => i.id);
      this.state.staff = uni(this.state.staff, remote.staff, (i) => i.id);
      this.state.admins = uni(this.state.admins, remote.admins, (i) => i.id);
      this.state.shifts = uni(this.state.shifts, remote.shifts, (i) => i.id);
      this.state.towels = uni(this.state.towels, remote.towels, (i) => i.no);
      this.state.towelLog = uni(this.state.towelLog, remote.towelLog, (i) => i.id);
      this.state.laundryLog = uni(this.state.laundryLog, remote.laundryLog, (i) => i.id);
      this.state.travelista.entries = tv;
      this.state.travelista.destinations = uni(this.state.travelista.destinations, rt.destinations, (i) => i.id);
      this.state.travelista.bookers = uni(this.state.travelista.bookers, rt.bookers, (i) => i.name);
      this.verifyIntegrity();
      this.verifyAuditIntegrity();
      this.verifyTravelistaIntegrity();
      if (!this.integrity.ok || !this.auditIntegrity.ok || !this.travelistaIntegrity.ok) throw new Error('post-merge verification failed');
    } catch (err) {
      this.state = JSON.parse(backup); // put everything back exactly as it was
      this.verifyIntegrity(); this.verifyAuditIntegrity(); this.verifyTravelistaIntegrity();
      console.error('mergeRemote aborted — local state restored', err);
      return null;
    }
    const summary = { ledger: newLedger.length, travelista: newTv.length, audit: newAudit.length };
    this._audit('sync.merge',
      `Merged ${summary.ledger} record${summary.ledger === 1 ? '' : 's'} from another device` +
      (summary.travelista ? ` + ${summary.travelista} travelista` : ''),
      summary);
    this.save();
    return summary;
  }

  // Rebuild one hash-chained list as the union of ours and theirs.
  // `remapSeq` fixes references that pointed at an entry whose number moved —
  // resolved through entry IDS, because the same seq means different things on
  // two devices. Returns the new array, or null if it fails to verify.
  _mergeChain(mine, theirs, incoming, remapSeq, allowUnrelated) {
    let n = 0; // the identical, identically-hashed prefix both devices share
    while (n < Math.min(mine.length, theirs.length)
      && mine[n].id === theirs[n].id && mine[n].hash === theirs[n].hash) n++;
    if (n === 0 && mine.length > 0 && theirs.length > 0 && !allowUnrelated) {
      console.error('merge refused — no shared history and the incoming records are bootstrap data');
      return null;
    }
    const mineBySeq = new Map(mine.map((e) => [e.seq, e.id]));
    const theirsBySeq = new Map(theirs.map((e) => [e.seq, e.id]));
    const incomingIds = new Set(incoming.map((e) => e.id));
    const tail = mine.slice(n).map((e) => ({ e, map: mineBySeq }))
      .concat(theirs.slice(n).filter((e) => incomingIds.has(e.id)).map((e) => ({ e, map: theirsBySeq })))
      .sort((a, b) => (a.e.ts < b.e.ts ? -1 : a.e.ts > b.e.ts ? 1 : a.e.seq - b.e.seq));
    const newSeqById = new Map();
    tail.forEach((t, i) => newSeqById.set(t.e.id, n + i + 1));
    const out = mine.slice(0, n);
    let prev = n ? mine[n - 1].hash : GENESIS;
    for (const { e, map } of tail) {
      const { hash, ...rest } = e;
      rest.seq = newSeqById.get(e.id);
      rest.prevHash = prev;
      if (remapSeq) {
        for (const k of ['refundsSeq', 'exchangesSeq']) {
          const v = rest[k];
          if (v == null || v <= n) continue; // points into the untouched prefix
          const targetId = map.get(v);
          const ns = targetId != null ? newSeqById.get(targetId) : null;
          if (ns != null) rest[k] = ns;
        }
      }
      // `rest` was destructured WITHOUT `hash`, so this hashes exactly the same
      // shape _append() hashes — the entry minus its own hash.
      const h = sha256(stableStringify(rest));
      rest.hash = h;
      out.push(rest);
      prev = h;
    }
    // verify what we just built
    let p = GENESIS;
    for (const e of out) {
      const { hash, ...rest } = e;
      if (rest.prevHash !== p) return null;
      if (sha256(stableStringify(rest)) !== hash) return null;
      p = hash;
    }
    return out;
  }

  // ------------------------------------------------------------- export/import
  exportData() {
    return {
      meta: {
        app: 'Frendz Front Desk Transaction Tracker',
        build: APP_BUILD,
        writtenBy: this.session ? this.session.name : 'system',
        exportedAt: nowISO(),
        version: this.state.version,
        coh: this.coh(),
        entries: this.state.ledger.length,
        auditEvents: this.state.audit.length,
        integrity: this.verifyIntegrity(),
        auditIntegrity: this.verifyAuditIntegrity(),
        // Second system — carried in the same payload so one backup restores both.
        travelistaEntries: ((this.state.travelista || {}).entries || []).length,
        travelistaIntegrity: this.verifyTravelistaIntegrity(),
      },
      state: this.state,
    };
  }
  importData(payload) {
    const s = payload && payload.state ? payload.state : payload;
    if (!s || !Array.isArray(s.ledger)) throw new Error('Invalid backup file.');
    this.state = Object.assign(defaultState(this.loc), s);
    this.state.config = Object.assign(defaultState(this.loc).config, s.config || {});
    if (!Array.isArray(this.state.audit)) this.state.audit = [];
    if (!Array.isArray(this.state.towels)) this.state.towels = [];
    if (!Array.isArray(this.state.towelLog)) this.state.towelLog = [];
    if (!Array.isArray(this.state.admins)) this.state.admins = [];
    if (!Array.isArray(this.state.laundryLog)) this.state.laundryLog = [];
    if (!this.state.config.towelTracker) this.state.config.towelTracker = { enabled: false, startedAt: null };
    if (!this.state.config.towelRecording) this.state.config.towelRecording = { enabled: false, startedAt: null, hours: 24 };
    this._normalizeTravelista();
    this.verifyIntegrity();
    this.verifyAuditIntegrity();
    this.verifyTravelistaIntegrity();
    this._audit('data.import', `Imported backup (${this.state.ledger.length} ledger entries)`, { entries: this.state.ledger.length });
    this.save();
  }
}

// Is a fetched remote backup safe to ADOPT over our local state?
//
// The old sync gate compared `auditEvents` counts — but that number counts logins and
// backup commits, not just records. A device with more logins yet an OLDER ledger
// therefore refused a genuine record update, then re-pushed its stale ledger and wiped
// whatever the remote had added — e.g. a <system error revision> correction that kept
// reverting no matter how many times it was pushed.
//
// This gate is LEDGER-based and loss-safe: adopt only when the remote already contains
// every ledger entry we hold (so nothing local is lost) AND is strictly ahead — it has
// records we don't (a pushed correction/txn), or an identical ledger with newer
// non-ledger changes (config/towels/shifts). If our ledger holds an entry the remote
// lacks (we're ahead, or the two branches diverged), we DON'T adopt — we keep our
// records and let our own backup push carry them out. This makes an authoritative
// correction propagate to every device instead of losing a last-write-wins race.
// TRAVELISTA: the second system's records live in the SAME backup payload, so
// they need the same loss-safety. Without this, two devices with an identical
// towel ledger would fall through to the audit-count tiebreak and the one with
// more logins would silently overwrite the other's bookings — the exact class of
// fault that lost refunds before. Both chains must be covered for adoption.
export function remoteAdoptable(remoteLedger, remoteAudit, localLedger, localAudit, remoteTv, localTv) {
  const rL = remoteLedger || [], lL = localLedger || [];
  const rIds = new Set(rL.map((e) => e && e.id));
  for (const e of lL) if (!rIds.has(e && e.id)) return false; // remote would drop a local record → never clobber ourselves
  const rT = remoteTv || [], lT = localTv || [];
  const rtIds = new Set(rT.map((e) => e && e.id));
  for (const e of lT) if (!rtIds.has(e && e.id)) return false; // same guarantee for travelista bookings/payouts
  if (rL.length > lL.length) return true;                     // remote has records we lack (e.g. a pushed correction) → adopt
  if (rT.length > lT.length) return true;                     // remote has travelista records we lack → adopt
  return (remoteAudit || 0) > (localAudit || 0);              // same records; adopt only for newer non-ledger changes
}

export const store = new Store();
export { seedItemTypes };
export { round2, GENESIS };
