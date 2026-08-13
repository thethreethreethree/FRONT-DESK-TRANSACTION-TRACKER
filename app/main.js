// main.js — bootstrap, lock screens (setup/login), shell, nav, router.
import { el, $, clear, peso, pesoPlain, toast, fmtDateTime } from './util.js';
import { store, remoteAdoptable } from './store.js';
import { pageHead, confirmDialog, managerGate, openModal } from './components.js';
import * as gh from './github.js';
import * as health from './sync-health.js';
import { parseSheet, importSheet } from './csv-import.js';
import { tv, seedStarterOnce } from './travelista.js';
import * as dashboard from './views/dashboard.js';
import * as deposit from './views/deposit.js';
import * as refund from './views/refund.js';
import * as exchange from './views/exchange.js';
import * as outstanding from './views/outstanding.js';
import * as ledger from './views/ledger.js';
import * as towels from './views/towels.js';
import * as passports from './views/passports.js';
import * as privateRooms from './views/private-rooms.js';
import * as activity from './views/activity.js';
import * as tvDashboard from './views/tv-dashboard.js';
import * as tvBooking from './views/tv-booking.js';
import * as tvBookings from './views/tv-bookings.js';
import * as tvPayouts from './views/tv-payouts.js';
import * as tvReports from './views/tv-reports.js';
import * as tvSettings from './views/tv-settings.js';

const LOGO_LIGHT = 'brand_assets/logo-el-nido.png'; // black wordmark → invert for dark bg

// Two systems share this shell: the front desk's towel/deposit tracker and the
// travelista booking tracker. They share the login, the roster, the audit log,
// the backup file and the sync — but NOT their money (see defaultTravelista()
// in store.js). Each view therefore declares which system it belongs to, and
// the sidebar only ever shows one system's tools at a time.
const VIEWS = {
  dashboard: { system: 'towels', label: 'Dashboard', icon: '▦', render: dashboard.render },
  deposit: { system: 'towels', label: 'New Deposit', icon: '＋', render: deposit.render },
  refund: { system: 'towels', label: 'New Refund', icon: '↩', render: refund.render },
  exchange: { system: 'towels', label: 'Towel Exchange', icon: '⇄', render: exchange.render },
  outstanding: { system: 'towels', label: 'Outstanding', icon: '🧾', render: outstanding.render },
  ledger: { system: 'towels', label: 'Ledger', icon: '📜', render: ledger.render },
  passports: { system: 'towels', label: 'Passports', icon: '🛂', render: passports.render },
  privaterooms: { system: 'towels', label: 'Private Rooms', icon: '🏠', render: privateRooms.render },
  towels: { system: 'towels', label: 'Towel Tracker', icon: '🧺', render: towels.render },
  shifts: { system: 'towels', label: 'Shifts', icon: '🕑', render: renderShifts },
  activity: { system: 'towels', label: 'Activity Log', icon: '🪵', mgr: true, render: activity.render },
  settings: { system: 'towels', label: 'Settings', icon: '⚙', mgr: true, render: renderSettings },

  'tv-dashboard': { system: 'travelista', label: 'Dashboard', icon: '▦', render: tvDashboard.render },
  'tv-booking': { system: 'travelista', label: 'New Booking', icon: '＋', render: tvBooking.render },
  'tv-bookings': { system: 'travelista', label: 'Booking Sheet', icon: '📋', render: tvBookings.render },
  'tv-payouts': { system: 'travelista', label: 'Remit & Payouts', icon: '↗', render: tvPayouts.render },
  'tv-reports': { system: 'travelista', label: 'Reports', icon: '📊', render: tvReports.render },
  'tv-activity': { system: 'travelista', label: 'Activity Log', icon: '🪵', mgr: true, render: activity.render },
  'tv-settings': { system: 'travelista', label: 'Settings', icon: '⚙', mgr: true, render: tvSettings.render },
};

const SYSTEMS = {
  towels: {
    id: 'towels', label: 'Towel Management & Tracking', icon: '🧺',
    blurb: 'Guest deposits, refunds, passports and the physical towel inventory.',
    home: 'dashboard',
    order: ['dashboard', 'deposit', 'refund', 'exchange', 'outstanding', 'ledger', 'passports', 'privaterooms', 'towels', 'shifts'],
    admin: ['activity', 'settings'],
  },
  travelista: {
    id: 'travelista', label: 'Travelista Management & Tracking', icon: '🚐',
    blurb: 'Van & boat bookings, the travelista\'s share and the hostel\'s commission.',
    home: 'tv-dashboard',
    order: ['tv-dashboard', 'tv-booking', 'tv-bookings', 'tv-payouts', 'tv-reports'],
    admin: ['tv-activity', 'tv-settings'],
  },
};
const SYSTEM_KEY = 'fdtt_system'; // device-local: which system this device was last using
const AUTO_REFRESH = new Set(['dashboard', 'tv-dashboard']);

let current = 'dashboard';
let currentSystem = null; // null → show the system picker
let navArgs = null; // one-shot payload passed to the next view's render (e.g. { depositSeq })
const app = document.getElementById('app');

async function mount() {
  if (!store.state) splashLoading('Loading…');
  await store.load();
  await syncFromRemote();    // pull the latest off-device records (repo = source of truth)
  await ensureProvisioned(); // only provisions the static baseline if nothing was restored
  ensureAdminSeed();         // seed the initial Admin account once
  ensurePassportItem();      // retire the (mis-)seeded standalone Passport item
  ensureTravelistaSeed();    // lay down the Aug 1-15 sheet once, across all devices
  // Outage/sync watchdog: warn the moment entries stop reaching backup. On reconnect,
  // pull anything we missed and flush our own pending changes straight away.
  health.init({ onReconnect: () => { pollRemote(); clearTimeout(_autoSyncTimer); _autoSyncTimer = setTimeout(runAutoSync, 800); } });
  route();
}

// Passport is a PAYMENT METHOD (Cash | Passport) on a normal item deposit, not its
// own item. An earlier build briefly seeded a standalone "Passport" item — retire it
// once so it no longer shows as a deposit chip. Existing passport deposits are keyed
// by their MEWS #, so retiring the item doesn't affect them.
function ensurePassportItem() {
  if (store.config.passportItemRetired) return;
  const it = store.itemTypes.find((x) => x.name.trim().toLowerCase() === 'passport');
  if (it && it.active) store.updateItem(it.id, { active: false });
  store.setConfig({ passportItemRetired: true });
}

// One-time: lay down the Travelista sheet the system was built from (Aug 1-15,
// 2026), so every device opens with the real opening record instead of an empty
// system. Runs AFTER syncFromRemote, so a device that already received the sheet
// from another device recognises it and doesn't re-add it. Idempotent by a synced
// config flag AND by the seed rows' own fixed ids — see seedStarterOnce().
function ensureTravelistaSeed() {
  try { seedStarterOnce(); }
  catch (e) { console.error('travelista seed', e); } // never block boot on it
}

// One-time: seed the initial Admin account (James). He sets his own PIN after the
// first login (Settings → Security). Idempotent via a config flag, so it never
// resets a PIN he later changed, and it runs across devices via the synced flag.
function ensureAdminSeed() {
  if (store.config.adminSeedV1) return;
  if (!store.adminList().some((a) => a.name.trim().toLowerCase() === 'james')) {
    store.addAdmin({ name: 'James', pin: '5313' });
  }
  store.setConfig({ adminSeedV1: true });
}

// ---- GitHub auto-sync state (used by syncFromRemote AND the subscriber below).
// `_syncSig()` is a count of real mutations that EXCLUDES our own backup commits,
// so a backup's bookkeeping never looks like fresh data — that's what prevents a
// self-triggering backup loop. The audit log is small (it doesn't grow with the
// 16k imported rows), so scanning it per change is cheap.
let _autoSyncTimer = null, _syncing = false, _lastSyncedSig = null;
function _syncSig() {
  const a = store.audit || [];
  let backups = 0; for (const e of a) if (e.action === 'backup.github') backups++;
  return a.length - backups;
}

// Make the GitHub repo the source of truth: pull the latest backup and adopt it
// when this device is fresher-than-the-repo-empty (just cleared / brand new) or
// the repo has recorded more activity than we hold locally. This is what lets a
// device that cleared its cookies — or any other device — open showing the LIVE
// records instead of the static baseline. Fails soft: if no remote backup exists
// (or it can't be reached), we fall through to the normal CSV provisioning.
async function syncFromRemote() {
  let remote = null;
  try { remote = await gh.fetchRemoteState(); } catch (e) { return; }
  if (!remote || !remote.payload || !remote.payload.state) return;
  const meta = remote.payload.meta || {};
  const localFresh = !store.isSetup() || store.ledger.length === 0;
  const rs = remote.payload.state || {};
  const adoptable = remoteAdoptable(rs.ledger, meta.auditEvents, store.ledger, (store.audit || []).length,
    (rs.travelista || {}).entries, ((store.state || {}).travelista || {}).entries);
  if (!(localFresh || adoptable)) return; // local is already current / would lose local records
  splashLoading('Syncing the latest records…');
  try {
    store.importData(remote.payload);
    if (remote.sha) { const g = store.config.github || {}; g.lastBackupSha = remote.sha; store.setConfig({ github: g }); }
    _lastSyncedSig = _syncSig(); // we just PULLED this state — don't immediately push it back
  } catch (e) { console.error('remote sync: could not adopt backup', e); }
}

// Route from the in-memory state (no storage read).
//
// Signing in leads to the SYSTEM PICKER — the two systems are separate jobs and
// the desk should say which one it's doing. A plain page refresh does not: the
// device remembers the system it was on, so reloading mid-shift never costs an
// extra tap or loses the person's place.
function route() {
  if (!store.session) return renderLogin();
  if (!currentSystem) {
    const saved = readSystem();
    if (saved && SYSTEMS[saved]) enterSystem(saved, { render: false });
    else return renderSystemPicker();
  }
  renderShell();
}

function readSystem() {
  try { return localStorage.getItem(SYSTEM_KEY); } catch (e) { return null; }
}
function enterSystem(id, { render = true } = {}) {
  if (!SYSTEMS[id]) return;
  currentSystem = id;
  current = SYSTEMS[id].home;
  try { localStorage.setItem(SYSTEM_KEY, id); } catch (e) { /* private mode */ }
  if (id === 'travelista') tv.ensureSeed(); // rate table + bookers ready on first entry
  if (render) renderShell();
}
function leaveSystem() {
  currentSystem = null;
  try { localStorage.removeItem(SYSTEM_KEY); } catch (e) { /* ignore */ }
  renderSystemPicker();
}

// Brief full-screen splash while loading / auto-provisioning.
function splashLoading(msg) {
  clear(app); app.className = 'app locked';
  app.appendChild(el('div', { class: 'lockwrap' }, el('div', { class: 'lockcard', style: 'text-align:center' }, [
    el('img', { src: LOGO_LIGHT, alt: 'Frendz Hostel El Nido', style: 'height:42px;margin:0 auto 12px;display:block' }),
    el('p', { class: 'muted', text: msg || 'Loading…' }),
  ])));
}

// First-run provisioning. A fresh device is auto-configured with the hostel's
// official records (so it opens showing the real COH) — no "create a PIN" screen.
// Auth is intentionally NOT created here: the manager PIN is kept per-device for
// devices that already have one, and a full auth system is added separately later.
// Staff sign in without a PIN (requireStaffPin stays false); manager-only actions
// stay locked on devices that have no manager PIN.
async function ensureProvisioned() {
  const fresh = !store.isSetup();
  const onCurrent = store.config.officialDataVersion === OFFICIAL_DATA_VERSION;
  // Already on the CURRENT official records → nothing to do.
  if (!fresh && onCurrent) return;
  // OPERATION-READY GUARD: once the hostel has recorded real operational entries,
  // NEVER auto-replace the ledger. Those entries are the source of truth and must
  // survive sign-off, tab close, and any future data-version bump. Imported /
  // bootstrap rows are staffRole 'system'; anything a signed-in staff/manager
  // created (deposits, refunds, manual reconciliations) is staffRole 'staff' /
  // 'manager'. Explicit, destructive re-loads still go through Settings → "Load
  // official data file" / "Reset", which warn before replacing live data.
  const hasUserEntries = store.ledger.some((e) => e.staffRole && e.staffRole !== 'system');
  if (!fresh && hasUserEntries) return;
  // Otherwise (re)load the official records: a fresh device, a legacy/demo
  // instance, or one still on an OLDER version that holds ONLY bootstrap data
  // (safe to refresh to the current baseline + baked manager credential).
  splashLoading(fresh ? 'Loading hostel records…' : 'Updating to the latest records…');
  store.state.config.setupComplete = true;
  store.state.config.requireStaffPin = false;
  // Bake the agreed manager credential (hashed per-device with a random salt) so
  // the manager PIN is the same on every provisioned device. Store.hashPin is a
  // static method on the store's class.
  store.state.config.managerPin = store.constructor.hashPin(OFFICIAL_MANAGER_PIN);
  if (fresh) store._audit('setup.complete', 'Front desk initialised — official records auto-loaded', { auto: true });
  try {
    const res = await fetch(OFFICIAL_CSV, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyOfficialData(await res.text());
  } catch (e) {
    console.error('auto-provision: could not load official records', e);
    store.save(); // set up with an empty ledger; records can be loaded later
  }
}

// Import the official CSV and reconcile COH to the live-sheet figure. Shared by
// first-run provisioning and the manual Settings → "Load official data file".
function applyOfficialData(text) {
  const s = importSheet(store, text, { replace: true });
  store.reconcileCOH(OFFICIAL_COH, { source: 'official data file', reason: `Reconciliation to official sheet COH ₱${pesoPlain(OFFICIAL_COH)} (live-sheet activity beyond this CSV snapshot)` });
  store.state.config.officialDataVersion = OFFICIAL_DATA_VERSION;
  store.save();
  return s;
}

// Note: there is no first-time "create a PIN" setup screen. A fresh device is
// auto-provisioned with the hostel's official records by ensureProvisioned(), and
// authentication is managed separately (see ensureProvisioned / the Access model).

// ---------------------------------------------------------------- Login
function renderLogin() {
  clear(app);
  app.className = 'app locked';
  let role = 'staff';
  const name = el('input', { class: 'input', placeholder: 'Your name / initials (e.g. TC)', autocomplete: 'off' });
  const pin = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'PIN', autocomplete: 'off' });
  const pinField = el('div', { class: 'field' }, [el('label', { text: 'PIN' }), pin]);

  const toggle = el('div', { class: 'role-toggle' }, [
    el('button', { type: 'button', class: 'active', text: '🧑 Staff', onClick: (ev) => setRole('staff', ev) }),
    el('button', { type: 'button', text: '🔑 Admin', onClick: (ev) => setRole('manager', ev) }),
  ]);
  function setRole(r, ev) { role = r; toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active')); ev.currentTarget.classList.add('active'); syncPin(); }
  function syncPin() {
    // Managers always need a PIN; staff need one once any staff account exists
    // (each signs in with their own PIN) or if a shared staff PIN is required.
    const need = role === 'manager' || store.config.requireStaffPin || store.staffList().length > 0;
    pinField.style.display = need ? '' : 'none';
  }

  const doLogin = () => {
    const ok = store.login(role, pin.value, name.value.trim() || (role === 'manager' ? 'Admin' : 'Staff'));
    if (!ok) { toast('Incorrect PIN', 'err'); pin.value = ''; pin.focus(); return; }
    currentSystem = null; // a fresh sign-in always chooses a system
    try { localStorage.removeItem(SYSTEM_KEY); } catch (e) { /* ignore */ }
    renderSystemPicker();
  };
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  const card = el('div', { class: 'lockcard' }, [
    el('div', { class: 'lk-brand' }, [
      el('img', { src: LOGO_LIGHT, alt: 'Frendz Hostel El Nido' }),
      el('h2', { text: 'Front Desk Tracker' }),
      el('p', { text: 'Sign in to continue' }),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Sign in as' }), toggle]),
    el('div', { class: 'field' }, [el('label', { text: 'Name / initials' }), name]),
    pinField,
    el('button', { class: 'btn primary lg block mt', text: 'Sign in →', onClick: doLogin }),
  ]);
  app.appendChild(el('div', { class: 'lockwrap' }, card));
  syncPin();
  setTimeout(() => name.focus(), 60);
}

// ------------------------------------------------------------ System picker
// Shown after every sign-in. Each card carries the system's own live headline
// figure, so the choice is informative rather than just a menu — the person can
// see the drawer and the cash box before they pick where to work.
function renderSystemPicker() {
  clear(app);
  app.className = 'app locked';
  const s = store.session;

  const card = (sys, headline, sub) => el('button', {
    class: 'syscard', type: 'button', onClick: () => enterSystem(sys.id),
  }, [
    el('span', { class: 'ic', text: sys.icon }),
    el('span', { class: 'nm', text: sys.label }),
    el('span', { class: 'bl', text: sys.blurb }),
    el('span', { class: 'fig' }, [
      el('b', { text: headline }),
      el('small', { text: sub }),
    ]),
  ]);

  const tvT = tv.entries.length ? tv.totals() : null;
  const wrap = el('div', { class: 'lockwrap' }, el('div', { class: 'lockcard wide' }, [
    el('div', { class: 'lk-brand' }, [
      el('img', { src: LOGO_LIGHT, alt: 'Frendz Hostel El Nido' }),
      el('h2', { text: `Welcome, ${s ? s.name : ''}` }),
      el('p', { text: 'Which system are you working in?' }),
    ]),
    el('div', { class: 'sysgrid' }, [
      card(SYSTEMS.towels, peso(store.coh()), 'cash on hand · deposits held'),
      card(SYSTEMS.travelista, peso(tv.cash()),
        tvT ? `cash box · ₱${pesoPlain(tvT.commission)} commission earned` : 'cash box · no bookings yet'),
    ]),
    el('button', { class: 'btn ghost block mt', text: 'Sign out', onClick: () => { store.logout(); currentSystem = null; renderLogin(); } }),
  ]));
  app.appendChild(wrap);
}

// ---------------------------------------------------------------- Shell
function renderShell() {
  clear(app);
  app.className = 'app';
  app.appendChild(renderSidebar());
  const main = el('main', { class: 'main', id: 'main-view' });
  app.appendChild(main);
  renderCurrent();
}

function renderSidebar() {
  const sys = SYSTEMS[currentSystem] || SYSTEMS.towels;
  const side = el('aside', { class: 'sidebar' });
  side.appendChild(el('div', { class: 'brand' }, [
    el('img', { class: 'logo', src: LOGO_LIGHT, alt: 'Frendz', style: 'filter:brightness(0) invert(1)' }),
  ]));
  // Which system you're in, and one tap back to the picker. Being explicit about
  // this matters: the two systems have similar-looking money screens, and acting
  // in the wrong one is the mistake worth designing against.
  side.appendChild(el('button', {
    class: 'sysbadge', type: 'button', title: 'Switch system',
    onClick: () => leaveSystem(),
  }, [
    el('span', { class: 'ic', text: sys.icon }),
    el('span', { class: 'nm', text: sys.id === 'towels' ? 'Towel Tracking' : 'Travelista' }),
    el('span', { class: 'sw', text: 'Switch' }),
  ]));

  const nav = el('nav', { class: 'nav' });
  for (const id of sys.order) addNav(nav, id);
  // Manager-only tools (Activity Log, Settings) are hidden entirely from staff —
  // staff have no access to admin features. (navigate() also gates, as a backstop.)
  if (store.isManager()) {
    nav.appendChild(el('div', { class: 'nav-sep' }));
    nav.appendChild(el('div', { class: 'mgr-only', text: 'Admin' }));
    for (const id of sys.admin) addNav(nav, id);
  }
  side.appendChild(nav);

  const s = store.session;
  side.appendChild(el('div', { class: 'side-foot' }, [
    el('div', { class: 'who', text: s ? s.name : '' }),
    el('div', { text: s && s.role === 'manager' ? 'Admin' : 'Staff' }),
    el('button', { text: 'Sign out', onClick: () => { store.logout(); currentSystem = null; renderLogin(); } }),
  ]));
  return side;
}
function addNav(nav, id) {
  const v = VIEWS[id];
  nav.appendChild(el('button', {
    class: 'navbtn' + (current === id ? ' active' : ''),
    dataset: { view: id },
    onClick: () => navigate(id),
  }, [el('span', { class: 'ic', text: v.icon }), el('span', { text: v.label })]));
}

function navigate(id, args) {
  const v = VIEWS[id];
  if (!v) return;
  // Navigating to a view of the other system switches system too — so a deep link
  // or a cross-system button can never leave the sidebar and the page disagreeing.
  if (v.system !== currentSystem) {
    currentSystem = v.system;
    try { localStorage.setItem(SYSTEM_KEY, v.system); } catch (e) { /* ignore */ }
  }
  if (v.mgr && !store.isManager()) {
    managerGate(() => { navArgs = args || null; current = id; renderShell(); }, { reason: 'This area is admin only.' });
    return;
  }
  navArgs = args || null;
  current = id;
  renderShell();
}

function renderCurrent() {
  const main = document.getElementById('main-view');
  if (!main) return;
  const home = (SYSTEMS[currentSystem] || SYSTEMS.towels).home;
  // Backstop: a staff session can never render a manager-only view (e.g. if a
  // manager left `current` on Settings before a staff signed in on this device),
  // and `current` can never be a view belonging to the other system.
  if (!VIEWS[current] || VIEWS[current].system !== currentSystem) current = home;
  if (VIEWS[current].mgr && !store.isManager()) current = home;
  clear(main);
  const args = navArgs; navArgs = null; // consume once, so a re-render doesn't re-trigger it
  const ctx = { navigate, store, args };
  try {
    main.appendChild(VIEWS[current].render(ctx));
  } catch (err) {
    console.error(err);
    main.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Something went wrong rendering this view.' }), el('pre', { class: 'mono', style: 'white-space:pre-wrap;color:var(--danger)', text: String(err && err.stack || err) })]));
  }
}

// live refresh for read-only views
store.subscribe(() => {
  if (!store.session) return;
  if (AUTO_REFRESH.has(current) && document.getElementById('main-view')) renderCurrent();
});

// Auto-sync to GitHub after every change (debounced ~6 s). With a token + repo set
// and "auto-sync" on, the repo always holds the latest, and any device that opens
// (or clears its data) restores it. No-op without a token/repo, so offline use is
// unaffected. Loop-safe: `_syncSig()` ignores the backup's own commit, and a change
// that lands DURING a backup re-schedules one so nothing is missed.
store.subscribe(() => {
  if (!gh.hasToken()) return;
  const g = store.config.github || {};
  if (!g.owner || !g.repo || !g.autoSync) return;
  clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(runAutoSync, 6000);
});
async function runAutoSync() {
  if (_syncing) { clearTimeout(_autoSyncTimer); _autoSyncTimer = setTimeout(runAutoSync, 6000); return; }
  const sigAtStart = _syncSig();
  if (sigAtStart === _lastSyncedSig) return;        // nothing new since the last successful sync
  _syncing = true;
  let ok = false;
  try { ok = await gh.autoBackup('auto-sync'); } finally { _syncing = false; }
  health.recordSync(ok);                            // drives the outage/sync-fault banner
  if (ok) _lastSyncedSig = sigAtStart;              // recorded exactly what we sent
  if (_syncSig() !== _lastSyncedSig) { clearTimeout(_autoSyncTimer); _autoSyncTimer = setTimeout(runAutoSync, 6000); } // changes during the backup
}

// ---- Live pull: keep this device current WITHOUT a manual refresh. -----------
// Front desks run more than one device/tab; pulling only on page-load meant a
// deposit/refund made elsewhere stayed invisible here until a hard refresh — which
// led to re-entering data. We now poll on a short interval AND whenever the tab
// regains focus. To avoid re-downloading the multi-MB ledger every time, we first
// do a CHEAP sha check (gh.remoteFileSha) and only fetch+adopt when it changed.
let _polling = false;
async function pollRemote() {
  if (_polling || _syncing || !store.session) return;
  _polling = true;
  try {
    if (gh.hasToken()) {
      const sha = await gh.remoteFileSha();
      const known = (store.config.github || {}).lastBackupSha;
      if (!sha || sha === known) return; // nothing new since our last sync — cheap exit
    }
    let remote = null;
    try { remote = await gh.fetchRemoteState(); } catch (e) { return; }
    if (!remote || !remote.payload || !remote.payload.state) return;
    // Adopt only when the remote is loss-safe AND strictly ahead by LEDGER content
    // (not audit-count) — this is what stops a stale device from re-pushing over a
    // pushed <system error revision> correction. See store.remoteAdoptable.
    const rs = remote.payload.state || {};
    if (!remoteAdoptable(rs.ledger, (remote.payload.meta || {}).auditEvents, store.ledger, (store.audit || []).length,
      (rs.travelista || {}).entries, ((store.state || {}).travelista || {}).entries)) {
      if (remote.sha) { const g = store.config.github || {}; g.lastBackupSha = remote.sha; store.setConfig({ github: g }); } // record sha; nothing to adopt
      return;
    }
    // Adopt the newer state SILENTLY (suppress the data.import audit so polling
    // doesn't bloat the log or echo a push back), then refresh the view if safe.
    store._suppressAudit = true;
    try { store.importData(remote.payload); } finally { store._suppressAudit = false; }
    if (remote.sha) { const g = store.config.github || {}; g.lastBackupSha = remote.sha; store.setConfig({ github: g }); } // re-read config after import
    _lastSyncedSig = _syncSig();
    health.checkData();  // re-verify integrity + reconciliation on the state we just adopted
    refreshIfSafe();
  } finally { _polling = false; }
}

// Re-render the current view after adopting remote changes — but NEVER clobber a
// form being filled or an input being typed in (that would lose the user's entry).
function refreshIfSafe() {
  if (!store.session) { route(); return; }
  if (!document.getElementById('main-view')) return;
  const FORM_VIEWS = new Set(['deposit', 'refund', 'exchange', 'tv-booking', 'tv-payouts']);
  const ae = document.activeElement;
  const typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '');
  if (FORM_VIEWS.has(current) || typing) return; // data is in memory; reflects on next navigation
  renderCurrent();
}

setInterval(() => { if (document.visibilityState === 'visible') pollRemote(); }, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollRemote(); });
window.addEventListener('focus', pollRemote);

// ============================================================ Shifts view
function renderShifts(ctx) {
  const root = el('div');
  const open = store.currentOpenShift();
  root.appendChild(pageHead('Shifts', 'Open a shift, then close it with a cash count to reconcile.', null));

  // current shift card
  if (open) {
    const counted = el('input', { class: 'input big', type: 'number', min: '0', step: '0.01', placeholder: '0.00' });
    const note = el('input', { class: 'input', placeholder: 'Handover note for next shift (optional)' });
    const expected = store.coh();
    const varLine = el('div', { class: 'muted mt', style: 'font-size:.86rem' });
    counted.addEventListener('input', () => {
      const v = parseFloat(counted.value || '0');
      const diff = Math.round((v - expected) * 100) / 100;
      varLine.innerHTML = `Expected (COH): <strong>${peso(expected)}</strong> · Counted: <strong>${peso(v)}</strong> · ` +
        `Variance: <strong style="color:${Math.abs(diff) < 0.005 ? 'var(--in-700)' : 'var(--out-700)'}">${diff > 0 ? '+' : ''}${pesoPlain(diff)}</strong>` +
        (Math.abs(diff) < 0.005 ? ' ✓ balanced' : (diff > 0 ? ' (over)' : ' (short)'));
    });
    root.appendChild(el('div', { class: 'card elev', style: 'max-width:620px' }, [
      el('div', { class: 'card-h' }, [el('h3', { text: `Current shift · ${open.label}` }), el('span', { class: 'tag shift', text: open.businessDate })]),
      el('p', { class: 'muted', style: 'margin-top:0', text: `Opened by ${open.openedBy} at ${fmtDateTime(open.openedAt)}` }),
      el('div', { class: 'amount-preview', style: 'margin-bottom:16px' }, [
        el('div', {}, [el('div', { class: 'lab', text: 'Expected drawer (= COH)' }), el('div', { class: 'muted', style: 'font-size:.78rem', text: 'deposits − refunds' })]),
        el('div', { class: 'val', text: peso(expected) }),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Count the physical cash drawer (₱)' }), counted]),
      varLine,
      el('div', { class: 'field mt' }, [el('label', { text: 'Handover note' }), note]),
      el('button', { class: 'btn primary lg block mt', text: 'Close shift & reconcile', onClick: () => {
        if (counted.value === '') return toast('Enter the counted cash first', 'warn');
        const s = store.closeShift({ countedCash: parseFloat(counted.value), note: note.value });
        toast(`Shift ${s.label} closed · variance ${pesoPlain(s.variance)}`, Math.abs(s.variance) < 0.005 ? 'ok' : 'warn');
        renderShell(); // the auto-sync subscriber backs this change up if enabled

      } }),
    ]));
  } else {
    root.appendChild(el('div', { class: 'card', style: 'max-width:620px' }, [
      el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🕑' }), el('p', { text: 'No shift is open. A shift opens automatically on the next deposit/refund.' })]),
    ]));
  }

  // history
  const closed = store.shifts.filter((s) => s.status === 'closed').reverse();
  const hist = el('div', { class: 'card mt-lg' }, [el('div', { class: 'card-h' }, [el('h3', { text: 'Shift history' })])]);
  if (closed.length) {
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, ['Date', 'Shift', 'Expected', 'Counted', 'Variance', 'Closed by'].map((h, i) => el('th', { class: i >= 2 && i <= 4 ? 'num' : '', text: h })))));
    const tb = el('tbody');
    for (const s of closed) {
      tb.appendChild(el('tr', {}, [
        el('td', { text: s.businessDate }),
        el('td', {}, el('span', { class: 'tag shift', text: s.label })),
        el('td', { class: 'num', text: pesoPlain(s.expectedCash) }),
        el('td', { class: 'num', text: pesoPlain(s.countedCash) }),
        el('td', { class: 'num', style: `color:${Math.abs(s.variance) < 0.005 ? 'var(--in-700)' : 'var(--out-700)'};font-weight:700`, text: (s.variance > 0 ? '+' : '') + pesoPlain(s.variance) }),
        el('td', { text: s.closedBy }),
      ]));
    }
    tbl.appendChild(tb);
    hist.appendChild(el('div', { class: 'table-wrap' }, tbl));
  } else {
    hist.appendChild(el('div', { class: 'empty' }, el('p', { text: 'No closed shifts yet.' })));
  }
  root.appendChild(hist);
  return root;
}

// ============================================================ Settings view
function renderSettings(ctx) {
  const root = el('div');
  root.appendChild(pageHead('Settings', 'Deposit items, data & integrity. Manager only.', null));

  // items
  const itemCard = el('div', { class: 'card', style: 'max-width:720px' }, [el('div', { class: 'card-h' }, [el('h3', { text: 'Deposit items' }), el('span', { class: 'sub', text: 'configure types & default amounts' })])]);
  const itemsTbl = el('table', { class: 'tbl' });
  itemsTbl.appendChild(el('thead', {}, el('tr', {}, [el('th', { text: 'Item' }), el('th', { class: 'num', text: 'Default ₱' }), el('th', { text: 'Status' }), el('th', { text: '' })])));
  const itb = el('tbody');
  for (const it of store.itemTypes) {
    const amt = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: it.defaultAmount, style: 'width:120px;padding:7px 10px' });
    amt.addEventListener('change', () => { store.updateItem(it.id, { defaultAmount: parseFloat(amt.value || '0') }); toast('Updated ' + it.name, 'ok'); });
    itb.appendChild(el('tr', {}, [
      el('td', {}, el('strong', { text: it.name })),
      el('td', { class: 'num' }, amt),
      el('td', {}, el('span', { class: it.active ? 'tag dep' : 'tag rev', text: it.active ? 'active' : 'retired' })),
      el('td', { class: 'right' }, el('button', { class: 'btn ghost sm', text: it.active ? 'Retire' : 'Restore', onClick: () => { store.updateItem(it.id, { active: !it.active }); renderShell(); } })),
    ]));
  }
  itemsTbl.appendChild(itb);
  itemCard.appendChild(el('div', { class: 'table-wrap' }, itemsTbl));
  // add item
  const nName = el('input', { class: 'input', placeholder: 'New item name' });
  const nAmt = el('input', { class: 'input', type: 'number', min: '0', step: '50', placeholder: 'Default ₱', style: 'max-width:140px' });
  itemCard.appendChild(el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
    el('div', { class: 'field', style: 'flex:1;margin:0' }, [el('label', { text: 'Add item' }), nName]),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: ' ' }), nAmt]),
    el('button', { class: 'btn primary', text: 'Add', onClick: () => {
      if (!nName.value.trim()) return toast('Enter an item name', 'warn');
      store.addItem({ name: nName.value, defaultAmount: parseFloat(nAmt.value || '0') });
      toast('Item added', 'ok'); renderShell();
    } }),
  ]));
  root.appendChild(itemCard);

  // Beginning balance / Cash On Hand setup
  root.appendChild(renderBeginningBalanceCard());

  // GitHub backup
  root.appendChild(renderGitHubCard());

  // local export / import
  root.appendChild(el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Local backup file' })]),
    el('p', { class: 'muted', style: 'margin-top:0', text: 'Download a versioned JSON snapshot, or restore from one (re-verifies integrity on import).' }),
    el('div', { class: 'flex gap wrap' }, [
      el('button', { class: 'btn', html: '⬇ Export backup (.json)', onClick: exportBackup }),
      el('button', { class: 'btn', html: '⬆ Import backup', onClick: importBackup }),
    ]),
  ]));

  // import from the original spreadsheet
  root.appendChild(el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Spreadsheet data' }), el('span', { class: 'sub', text: 'official record + manual CSV' })]),
    el('p', { class: 'muted', style: 'margin-top:0', html: 'The hostel\'s full deposit history ships with the app as the <strong>official data file</strong>. Load it to populate this device, or import a fresh CSV export of the two-sided towel/padlock/hair-dryer sheet.' }),
    el('div', { class: 'flex gap wrap' }, [
      el('button', { class: 'btn primary', html: '🗄 Load official data file', onClick: loadOfficialData }),
      el('button', { class: 'btn', html: '📄 Import CSV spreadsheet', onClick: importCSV }),
    ]),
    el('div', { class: 'hint mt', text: 'Loading the official file replaces the transactions on this device. Your PIN, items and GitHub settings are kept.' }),
  ]));

  // security · PINs
  root.appendChild(renderSecurityCard());

  // admin accounts (elevated tier — each signs in with their own PIN)
  root.appendChild(renderAdminCard());

  // staff accounts (each signs in with their own PIN)
  root.appendChild(renderStaffCard());

  // danger zone
  root.appendChild(el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Danger zone' })]),
    el('div', { class: 'danger-zone flex between aic wrap gap' }, [
      el('div', {}, [el('strong', { text: 'Reset all data' }), el('div', { class: 'muted', style: 'font-size:.82rem', text: 'Erases the ledger, shifts & settings on this device. Export a backup first.' })]),
      el('button', { class: 'btn out', text: 'Reset…', onClick: () => confirmDialog({ title: 'Reset & reload records?', sub: 'Clears local data on this device and reloads the hostel\'s official records fresh. Export a backup first if unsure.', confirmLabel: 'Reset & reload', kind: 'out', onConfirm: async () => { store.reset(); store.session = null; await ensureProvisioned(); route(); } }) }),
    ]),
  ]));
  return root;
}

function renderBeginningBalanceCard() {
  const begin = store.beginningBalance();
  const net = store.netFlow();
  const coh = store.coh();
  const input = el('input', { class: 'input', type: 'number', step: '0.01', value: begin, style: 'max-width:200px' });
  const target = el('input', { class: 'input', type: 'number', step: '0.01', value: coh, placeholder: 'e.g. 58800', style: 'max-width:200px' });
  const cohLine = el('div', { class: 'muted', style: 'font-size:.86rem;margin-top:6px' });
  const paint = () => {
    const b = parseFloat(input.value || '0') || 0;
    const c = Math.round((b + net + Number.EPSILON) * 100) / 100;
    cohLine.innerHTML = `COH = Beginning <b>${peso(b)}</b> + Net flow <b>${net >= 0 ? '+' : ''}${peso(net)}</b> = <b>${peso(c)}</b>`;
  };
  input.addEventListener('input', paint); paint();
  return el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Beginning balance' }), el('span', { class: 'sub', text: 'opening cash float' })]),
    el('p', { class: 'muted', style: 'margin-top:0', html: 'The cash the drawer started with, before any tracked deposit or refund. <strong>Cash On Hand = Beginning balance + Σ deposits − Σ refunds</strong> — every deposit and refund moves COH; the beginning balance is the only typed value.' }),
    el('div', { class: 'flex gap', style: 'align-items:flex-end' }, [
      el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Beginning balance (₱)' }), input]),
      el('button', { class: 'btn primary', text: 'Save', onClick: () => {
        const reason = el('input', { class: 'input', placeholder: 'Why is the opening float changing? (required)', autocomplete: 'off' });
        openModal({
          title: 'Change beginning balance', sub: 'This shifts Cash On Hand — a reason is recorded in the Activity Log.',
          body: el('div', { class: 'field' }, [el('label', { text: `Set opening float to ₱${pesoPlain(parseFloat(input.value || '0') || 0)} — reason` }), reason]),
          actions: [
            { label: 'Cancel', kind: 'ghost' },
            { label: 'Save (manager)', kind: 'primary', onClick: (close) => {
              if (!reason.value.trim()) { toast('A reason is required', 'warn'); return; }
              managerGate(() => {
                store.setBeginningBalance(parseFloat(input.value || '0') || 0, { source: 'manual', reason: reason.value.trim() });
                toast(`Beginning balance set · COH now ${peso(store.coh())}`, 'ok');
                close(); renderShell();
              }, { reason: 'Approve changing the beginning balance' });
            } },
          ],
        });
      } }),
    ]),
    cohLine,
    el('div', { class: 'hint mt', text: `Net flow from ${store.ledger.length.toLocaleString()} ledger entries: ${net >= 0 ? '+' : ''}${peso(net)} · current COH ${peso(coh)}` }),
    el('hr', { class: 'hr' }),
    el('p', { class: 'muted', style: 'margin:0', html: 'Tie COH to the live sheet\'s figure. This books <strong>one labelled, fully-audited reconciliation entry</strong> — the opening float and individual transactions are untouched. A reason, the guest & staff involved, and the related transaction # are <strong>required</strong> for accountability.' }),
    el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
      el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Reconcile COH to (₱)' }), target]),
      el('button', { class: 'btn', text: 'Reconcile…', onClick: () => openReconcileModal(target.value) }),
    ]),
  ]);
}

// COH adjustment with mandatory accountability: reason, guest involved, staff
// involved, and the related transaction #. All recorded on the ledger entry + audit.
function openReconcileModal(prefillTarget) {
  const cur = store.coh();
  const targetI = el('input', { class: 'input', type: 'number', step: '0.01', value: prefillTarget || cur, style: 'max-width:220px' });
  const reasonI = el('textarea', { class: 'input', rows: '2', placeholder: 'Why must COH be adjusted? (required)' });
  const guestI = el('input', { class: 'input', placeholder: 'Guest involved', autocomplete: 'off' });
  const staffI = el('input', { class: 'input', placeholder: 'Staff involved', autocomplete: 'off' });
  const refI = el('input', { class: 'input', placeholder: 'e.g. 16204', autocomplete: 'off' });
  const diffLine = el('div', { class: 'muted', style: 'font-size:.85rem;margin-top:6px' });
  const upd = () => {
    const t = parseFloat(targetI.value || '');
    diffLine.innerHTML = isFinite(t)
      ? `Current COH <b>${peso(cur)}</b> → <b>${peso(t)}</b> · books a <b>${(t - cur) >= 0 ? '+' : '−'}${peso(Math.abs(Math.round((t - cur) * 100) / 100))}</b> adjustment`
      : 'Enter a target COH';
  };
  targetI.addEventListener('input', upd); upd();
  const body = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { text: 'Reconcile COH to (₱)' }), targetI, diffLine]),
    el('div', { class: 'field' }, [el('label', { text: 'Reason (required)' }), reasonI]),
    el('div', { class: 'row2' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Guest involved (required)' }), guestI]),
      el('div', { class: 'field' }, [el('label', { text: 'Staff involved (required)' }), staffI]),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Related transaction # (required)' }), refI, el('div', { class: 'hint', text: 'the ledger # this adjustment relates to' })]),
    el('div', { class: 'pill-warn', html: 'A COH adjustment is a <strong>visible, permanent, audited</strong> ledger entry. Every field is required for accountability.' }),
  ]);
  openModal({
    title: 'Reconcile Cash On Hand', sub: 'Manager approval required · fully audited', body, wide: true,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Reconcile (manager)', kind: 'primary', onClick: (close) => {
        const t = parseFloat(targetI.value || '');
        if (!isFinite(t)) return toast('Enter a target COH', 'warn');
        if (!reasonI.value.trim()) return toast('A reason is required', 'warn');
        if (!guestI.value.trim()) return toast('Enter the guest involved', 'warn');
        if (!staffI.value.trim()) return toast('Enter the staff involved', 'warn');
        if (!refI.value.trim()) return toast('Enter the related transaction #', 'warn');
        managerGate(() => {
          const e = store.reconcileCOH(t, { reason: reasonI.value.trim(), guest: guestI.value.trim(), staffInvolved: staffI.value.trim(), refSeq: refI.value.trim(), source: 'manual' });
          toast(e ? `Reconciled · COH now ${peso(store.coh())}` : 'COH already matches', 'ok');
          close(); renderShell();
        }, { reason: `Approve reconciling COH to ${peso(t)}` });
      } },
    ],
  });
}

function renderGitHubCard() {
  const g = store.config.github || {};
  const owner = el('input', { class: 'input', placeholder: 'github username / org', value: g.owner || '' });
  const repo = el('input', { class: 'input', placeholder: 'repository name', value: g.repo || '' });
  const branch = el('input', { class: 'input', placeholder: 'main', value: g.branch || 'main' });
  const path = el('input', { class: 'input', placeholder: 'data/ledger-backup.json', value: g.path || 'data/ledger-backup.json' });
  const token = el('input', { class: 'input', type: 'password', placeholder: gh.hasToken() ? '•••••••• (saved — leave blank to keep)' : 'fine-grained PAT (Contents: read & write)', autocomplete: 'off' });
  const auto = el('input', { type: 'checkbox' });
  // Migrate the old shift-close flag → the new every-change auto-sync.
  auto.checked = g.autoSync === undefined ? !!g.autoOnClose : !!g.autoSync;

  const status = el('div', { class: 'muted', style: 'font-size:.82rem;margin-top:10px' },
    g.lastBackupAt ? `Last sync: ${fmtDateTime(g.lastBackupAt)}` : 'Not synced yet.');

  const saveCfg = () => {
    store.setConfig({ github: {
      owner: owner.value.trim(), repo: repo.value.trim(),
      branch: branch.value.trim() || 'main', path: path.value.trim() || 'data/ledger-backup.json',
      autoSync: auto.checked, enabled: g.enabled || false,
      lastBackupAt: g.lastBackupAt, lastBackupSha: g.lastBackupSha,
    } });
    if (token.value.trim()) { gh.setToken(token.value.trim()); token.value = ''; token.placeholder = '•••••••• (saved — leave blank to keep)'; }
  };

  const card = el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { html: '☁ GitHub sync (off-device records)' }), el('span', { class: 'sub', text: 'The repo is the source of truth' })]),
    el('div', { class: 'pill', html: 'With a token set and <strong>auto-sync</strong> on, this device saves every change to the repo, and <strong>every device restores the latest on open</strong> — so the records survive clearing site data and stay consistent across devices. (Sync is eventually-consistent: a change can take up to ~1–2 min to reach another device.)' }),
    el('div', { class: 'pill-warn', html: 'Use a <strong>fine-grained Personal Access Token</strong> scoped to <em>only this repo</em> with <strong>Contents: Read and write</strong>. The token is stored locally on this device only — never in exports. <strong>The repo holds the full ledger, so it should be PRIVATE.</strong>' }),
    el('div', { class: 'row2 mt' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Owner' }), owner]),
      el('div', { class: 'field' }, [el('label', { text: 'Repository' }), repo]),
    ]),
    el('div', { class: 'row2' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Branch' }), branch]),
      el('div', { class: 'field' }, [el('label', { text: 'File path' }), path]),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Access token' }), token]),
    el('label', { class: 'flex aic gap', style: 'font-size:.88rem;cursor:pointer;margin-bottom:6px' }, [auto, 'Auto-sync after every change (recommended)']),
    el('div', { class: 'flex gap wrap mt' }, [
      el('button', { class: 'btn', text: 'Test connection', onClick: async (ev) => {
        saveCfg(); const b = ev.currentTarget; b.disabled = true; b.textContent = 'Testing…';
        try { const name = await gh.testConnection(); toast('Connected to ' + name + ' ✓', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
        b.disabled = false; b.textContent = 'Test connection';
      } }),
      el('button', { class: 'btn', text: 'Save settings', onClick: () => { saveCfg(); store._audit('settings.github.update', `Updated GitHub sync target ${store.config.github.owner}/${store.config.github.repo}`, { owner: store.config.github.owner, repo: store.config.github.repo, autoSync: store.config.github.autoSync }); toast('GitHub settings saved', 'ok'); } }),
      el('button', { class: 'btn primary', html: '☁ Back up now', onClick: async (ev) => {
        saveCfg(); const b = ev.currentTarget; b.disabled = true; b.textContent = 'Backing up…';
        try { const url = await gh.backupNow('manual'); toast('Backed up to GitHub ✓', 'ok'); status.innerHTML = `Last backup: ${fmtDateTime(store.config.github.lastBackupAt)} · <a href="${url}" target="_blank" rel="noopener" style="color:var(--gold-700)">view commit</a>`; }
        catch (e) { toast(e.message, 'err'); }
        b.disabled = false; b.innerHTML = '☁ Back up now';
      } }),
    ]),
    status,
  ]);
  return card;
}

function renderSecurityCard() {
  // Change the signed-in person's OWN PIN: a roster admin updates their account;
  // the baked admin credential updates the shared admin PIN. This is how a seeded
  // admin (e.g. James) replaces their initial PIN after first login.
  const s = store.session;
  const ownRoster = !!(s && s.adminId);
  const newM = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'New PIN (4-6 digits)', autocomplete: 'off', style: 'max-width:280px' });
  return el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Security · My Admin PIN' }), el('span', { class: 'sub', text: 'changes are recorded in the Activity Log' })]),
    el('p', { class: 'muted', style: 'margin-top:0', text: ownRoster ? `Change your own (${s.name}) Admin PIN. Other admins are managed in the Admin accounts section below.` : 'Change the shared Admin PIN. Individual admins (with their own PIN) are managed in the Admin accounts section below.' }),
    el('div', { class: 'field', style: 'max-width:280px;margin:0' }, [el('label', { text: 'New Admin PIN' }), newM,
      el('button', { class: 'btn sm mt', text: 'Update my PIN', onClick: () => {
        if ((newM.value || '').length < 4) return toast('PIN must be at least 4 digits', 'warn');
        if (ownRoster) store.setAdminPin(s.adminId, newM.value);
        else store.changePin('manager', newM.value);
        newM.value = ''; toast('Your Admin PIN updated', 'ok');
      } }),
    ]),
  ]);
}

// Admin roster — elevated accounts, each signs in with their own PIN at the Admin
// tier. Only admins can manage the towel inventory and other admin-only tools.
function renderAdminCard() {
  const card = el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Admin accounts' }), el('span', { class: 'sub', text: 'elevated tier · each signs in with their own PIN' })]),
    el('p', { class: 'muted', style: 'margin-top:0', text: 'Admins can change settings, void transactions, and manage the towel inventory. Add an admin and give them a PIN; they sign in with the Admin option and can change their own PIN afterwards.' }),
  ]);
  const roster = store.adminList();
  if (roster.length) {
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [el('th', { text: 'Name' }), el('th', { text: 'Set new PIN' }), el('th', { text: '' })])));
    const tb = el('tbody');
    for (const a of roster) {
      const pinI = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'new PIN', autocomplete: 'off', style: 'width:150px;padding:7px 10px' });
      tb.appendChild(el('tr', {}, [
        el('td', {}, el('strong', { text: a.name })),
        el('td', {}, el('div', { class: 'flex gap aic' }, [pinI, el('button', { class: 'btn ghost sm', text: 'Update', onClick: () => {
          if ((pinI.value || '').length < 4) return toast('PIN must be at least 4 digits', 'warn');
          store.setAdminPin(a.id, pinI.value); pinI.value = ''; toast(`${a.name}'s PIN updated`, 'ok');
        } })])),
        el('td', { class: 'right' }, el('button', { class: 'btn ghost sm', text: 'Remove', onClick: () => {
          confirmDialog({ title: `Remove admin ${a.name}?`, sub: 'They can no longer sign in as an admin. Their past entries stay in the record.', confirmLabel: 'Remove', kind: 'out', onConfirm: () => { store.removeAdmin(a.id); toast(`${a.name} removed`, 'ok'); renderShell(); } });
        } })),
      ]));
    }
    tbl.appendChild(tb);
    card.appendChild(el('div', { class: 'table-wrap' }, tbl));
  } else {
    card.appendChild(el('div', { class: 'hint', text: 'No admin accounts yet — add one below.' }));
  }
  const nName = el('input', { class: 'input', placeholder: 'Admin name' });
  const nPin = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'PIN (4-6 digits)', autocomplete: 'off', style: 'max-width:180px' });
  card.appendChild(el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
    el('div', { class: 'field', style: 'flex:1;margin:0' }, [el('label', { text: 'Add admin' }), nName]),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'PIN' }), nPin]),
    el('button', { class: 'btn primary', text: 'Add admin', onClick: () => {
      const name = nName.value.trim();
      if (!name) return toast('Enter an admin name', 'warn');
      if ((nPin.value || '').length < 4) return toast('PIN must be at least 4 digits', 'warn');
      store.addAdmin({ name, pin: nPin.value }); nName.value = ''; nPin.value = ''; toast(`${name} added as admin`, 'ok'); renderShell();
    } }),
  ]));
  return card;
}

// Staff roster — manager adds front-desk accounts, each with its own PIN.
function renderStaffCard() {
  const card = el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Staff' }), el('span', { class: 'sub', text: 'front-desk accounts · each signs in with their own PIN' })]),
    el('p', { class: 'muted', style: 'margin-top:0', text: 'Add staff and give each a PIN. They sign in with that PIN to record deposits & refunds — they cannot open Settings, the Activity Log, or any manager tool.' }),
  ]);
  const roster = store.staffList();
  if (roster.length) {
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [el('th', { text: 'Name' }), el('th', { text: 'Set new PIN' }), el('th', { text: '' })])));
    const tb = el('tbody');
    for (const s of roster) {
      const pinI = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'new PIN', autocomplete: 'off', style: 'width:150px;padding:7px 10px' });
      tb.appendChild(el('tr', {}, [
        el('td', {}, el('strong', { text: s.name })),
        el('td', {}, el('div', { class: 'flex gap aic' }, [pinI, el('button', { class: 'btn ghost sm', text: 'Update', onClick: () => {
          if ((pinI.value || '').length < 4) return toast('PIN must be at least 4 digits', 'warn');
          store.setStaffPin(s.id, pinI.value); pinI.value = ''; toast(`${s.name}'s PIN updated`, 'ok');
        } })])),
        el('td', { class: 'right' }, el('button', { class: 'btn ghost sm', text: 'Remove', onClick: () => {
          confirmDialog({ title: `Remove ${s.name}?`, sub: 'They can no longer sign in. Their past entries stay in the ledger.', confirmLabel: 'Remove', kind: 'out', onConfirm: () => { store.removeStaff(s.id); toast(`${s.name} removed`, 'ok'); renderShell(); } });
        } })),
      ]));
    }
    tbl.appendChild(tb);
    card.appendChild(el('div', { class: 'table-wrap' }, tbl));
  } else {
    card.appendChild(el('div', { class: 'hint', text: 'No staff yet — add one below.' }));
  }
  const nName = el('input', { class: 'input', placeholder: 'Staff name / initials' });
  const nPin = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'PIN (4-6 digits)', autocomplete: 'off', style: 'max-width:180px' });
  card.appendChild(el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
    el('div', { class: 'field', style: 'flex:1;margin:0' }, [el('label', { text: 'Add staff' }), nName]),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'PIN' }), nPin]),
    el('button', { class: 'btn primary', text: 'Add staff', onClick: () => {
      const name = nName.value.trim();
      if (!name) return toast('Enter a staff name', 'warn');
      if ((nPin.value || '').length < 4) return toast('PIN must be at least 4 digits', 'warn');
      store.addStaff({ name, pin: nPin.value }); nName.value = ''; nPin.value = ''; toast(`${name} added`, 'ok'); renderShell();
    } }),
  ]));
  return card;
}

function exportBackup() {
  const data = store.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `frendz-ledger-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  store._audit('backup.export', 'Exported local backup file', { entries: store.ledger.length });
  toast('Backup exported', 'ok');
}
const OFFICIAL_CSV = 'data/deposit-towel-full.csv';
// The hostel's current reconciled Cash On Hand from the live sheet (Beginning
// ₱47,100 + net flow). The CSV is an older snapshot, so after import we book a
// single labelled reconciliation entry so COH ties to this official figure.
// Updated 2026-06-02 from "DEPOSIT - Copy of TOWEL_2" (sheet now runs Feb 1 →
// Jun 2): TOTAL deposits ₱10,420,842 − refunds ₱10,425,142 = net −₱4,300, so
// Beginning ₱47,100 + net = COH ₱42,800 (ties out on the sheet's own TOTAL row).
const OFFICIAL_COH = 42800;
// Manager credential baked into provisioning so the agreed PIN works on every
// device (set in ensureProvisioned; the manager signs in as "Darren" with it).
// SECURITY: this is a plaintext PIN in a (public) repo — treat it as KNOWN, not
// secret. It's an interim gate until the real auth system lands.
const OFFICIAL_MANAGER_PIN = '1012';
// Bump this whenever the committed records / COH / manager PIN change. A device
// whose stored `officialDataVersion` differs reloads the records (and re-applies
// the baked credential) on next open — so updates propagate without a manual reset.
const OFFICIAL_DATA_VERSION = '2026-06-03-coh42800-mgr';
async function loadOfficialData() {
  let text;
  try {
    const res = await fetch(OFFICIAL_CSV, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    text = await res.text();
  } catch (e) {
    toast('Could not load the official data file (data/deposit-towel-full.csv)', 'err');
    return;
  }
  let summary;
  try { summary = parseSheet(text).summary; }
  catch (e) { toast('The official data file could not be parsed', 'err'); return; }
  if (!summary.count) { toast('The official data file has no transactions', 'warn'); return; }
  const adj = Math.round((OFFICIAL_COH - summary.coh + Number.EPSILON) * 100) / 100;
  const body = el('div', {}, [
    el('p', { class: 'muted', style: 'margin-top:0', text: `The hostel's official record holds ${summary.count.toLocaleString()} transactions (${summary.depCount.toLocaleString()} deposits, ${summary.refCount.toLocaleString()} refunds).` }),
    el('div', { class: 'amount-preview' }, [
      el('div', {}, [el('div', { class: 'lab', text: 'Cash On Hand (official)' }), el('div', { class: 'muted', style: 'font-size:.78rem', html: `${summary.beginningBalance ? 'Beginning ₱' + pesoPlain(summary.beginningBalance) + ' + ' : ''}Deposits ₱${pesoPlain(summary.deposits)} − Refunds ₱${pesoPlain(summary.refunds)}${adj ? ` ${adj >= 0 ? '+' : '−'} Adjustment ₱${pesoPlain(Math.abs(adj))}` : ''}` })]),
      el('div', { class: 'val', text: peso(OFFICIAL_COH) }),
    ]),
    adj ? el('div', { class: 'hint mt', text: `A reconciliation adjustment of ${adj >= 0 ? '+' : '−'}₱${pesoPlain(Math.abs(adj))} is booked so COH ties to the official sheet figure (live-sheet activity beyond this CSV snapshot). It appears as one labelled entry in the ledger.` }) : null,
    el('div', { class: 'pill-warn mt', html: 'This <strong>replaces</strong> the transactions on this device with the official record. Your PIN, items, GitHub settings and activity log are kept. Export a backup first if unsure.' }),
  ]);
  openModal({
    title: 'Load official data file', sub: OFFICIAL_CSV, body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Load & replace', kind: 'primary', onClick: (close) => {
        const s = importSheet(store, text, { replace: true });
        store.reconcileCOH(OFFICIAL_COH, { source: 'official data file', reason: `Reconciliation to official sheet COH ₱${pesoPlain(OFFICIAL_COH)} (live-sheet activity beyond this CSV snapshot)` });
        toast(`Loaded ${s.count.toLocaleString()} entries · COH ${peso(store.coh())}`, 'ok');
        close(); current = 'dashboard'; renderShell();
      } },
    ],
  });
}

function importCSV() {
  const inp = el('input', { type: 'file', accept: '.csv,text/csv' });
  inp.addEventListener('change', () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      let summary;
      try { summary = parseSheet(r.result).summary; }
      catch (e) { toast('Could not read that CSV', 'err'); return; }
      if (!summary.count) { toast('No transactions found in that file', 'warn'); return; }
      const body = el('div', {}, [
        el('p', { class: 'muted', style: 'margin-top:0', text: `Found ${summary.count} transactions in the file.` }),
        el('div', { class: 'amount-preview' }, [
          el('div', {}, [el('div', { class: 'lab', text: 'Computed Cash On Hand' }), el('div', { class: 'muted', style: 'font-size:.78rem', html: `${summary.beginningBalance ? 'Beginning ₱' + pesoPlain(summary.beginningBalance) + ' + ' : ''}Deposits ₱${pesoPlain(summary.deposits)} − Refunds ₱${pesoPlain(summary.refunds)}` })]),
          el('div', { class: 'val', text: peso(summary.coh) }),
        ]),
        el('div', { class: 'pill-warn mt', html: 'This <strong>replaces</strong> current transactions with the spreadsheet data. Items, settings and the activity log are kept. Export a backup first if unsure.' }),
      ]);
      openModal({
        title: 'Import spreadsheet', sub: f.name, body,
        actions: [
          { label: 'Cancel', kind: 'ghost' },
          { label: 'Replace & import', kind: 'primary', onClick: (close) => {
            const s = importSheet(store, r.result, { replace: true });
            toast(`Imported ${s.count} entries · COH ${peso(s.coh)}`, 'ok');
            close(); current = 'dashboard'; renderShell();
          } },
        ],
      });
    };
    r.readAsText(f);
  });
  inp.click();
}

function importBackup() {
  const inp = el('input', { type: 'file', accept: 'application/json' });
  inp.addEventListener('change', () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { store.importData(JSON.parse(r.result)); toast('Backup imported', 'ok'); renderShell(); }
      catch (e) { toast('Invalid backup file', 'err'); }
    };
    r.readAsText(f);
  });
  inp.click();
}

// Persistence safety net: every store.save() already starts an IndexedDB write
// immediately, but flush the coalesced write queue when the tab is hidden/closed
// so the very last action can't be lost on a fast close. (pagehide fires on
// close/navigate; visibilitychange covers mobile/background; both are best-effort.)
window.addEventListener('pagehide', () => { store.flush(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flush(); });

// boot
mount();
window.addEventListener('error', (e) => console.error('global', e.error));
