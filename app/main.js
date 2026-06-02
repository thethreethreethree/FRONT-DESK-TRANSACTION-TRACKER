// main.js — bootstrap, lock screens (setup/login), shell, nav, router.
import { el, $, clear, peso, pesoPlain, toast, fmtDateTime } from './util.js';
import { store } from './store.js';
import { pageHead, confirmDialog, managerGate, openModal } from './components.js';
import * as gh from './github.js';
import { parseSheet, importSheet } from './csv-import.js';
import * as dashboard from './views/dashboard.js';
import * as deposit from './views/deposit.js';
import * as refund from './views/refund.js';
import * as outstanding from './views/outstanding.js';
import * as ledger from './views/ledger.js';
import * as activity from './views/activity.js';

const LOGO_LIGHT = 'brand_assets/logo-el-nido.png'; // black wordmark → invert for dark bg

const VIEWS = {
  dashboard: { label: 'Dashboard', icon: '▦', render: dashboard.render },
  deposit: { label: 'New Deposit', icon: '＋', render: deposit.render },
  refund: { label: 'New Refund', icon: '↩', render: refund.render },
  outstanding: { label: 'Outstanding', icon: '🧾', render: outstanding.render },
  ledger: { label: 'Ledger', icon: '📜', render: ledger.render },
  shifts: { label: 'Shifts', icon: '🕑', render: renderShifts },
  activity: { label: 'Activity Log', icon: '🪵', mgr: true, render: activity.render },
  settings: { label: 'Settings', icon: '⚙', mgr: true, render: renderSettings },
};
const AUTO_REFRESH = new Set(['dashboard']);

let current = 'dashboard';
const app = document.getElementById('app');

async function mount() {
  if (!store.state) splashLoading('Loading…');
  await store.load();
  await ensureProvisioned();
  route();
}

// Route from the in-memory state (no storage read).
function route() {
  if (!store.session) return renderLogin();
  renderShell();
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
  // An instance already holding official records has a beginning float or an
  // adjustment entry — don't auto-replace it (would clobber any manual entries).
  const looksOfficial = store.beginningBalance() > 0 || store.ledger.some((e) => e.kind === 'adjustment');
  if (!fresh && (onCurrent || looksOfficial)) return;
  // Fresh device → provision; legacy demo/empty instance → upgrade to the records.
  splashLoading(fresh ? 'Loading hostel records…' : 'Updating to the latest records…');
  store.state.config.setupComplete = true;
  store.state.config.requireStaffPin = false;
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
    el('button', { type: 'button', text: '🔑 Manager', onClick: (ev) => setRole('manager', ev) }),
  ]);
  function setRole(r, ev) { role = r; toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active')); ev.currentTarget.classList.add('active'); syncPin(); }
  function syncPin() {
    const need = role === 'manager' || store.config.requireStaffPin;
    pinField.style.display = need ? '' : 'none';
  }

  const doLogin = () => {
    const ok = store.login(role, pin.value, name.value.trim() || (role === 'manager' ? 'Manager' : 'Staff'));
    if (!ok) { toast('Incorrect PIN', 'err'); pin.value = ''; pin.focus(); return; }
    current = 'dashboard';
    renderShell();
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
    el('button', { class: 'btn ghost sm block mt', text: 'Forgot Manager PIN?', onClick: openPinRecovery }),
  ]);
  app.appendChild(el('div', { class: 'lockwrap' }, card));
  syncPin();
  setTimeout(() => name.focus(), 60);
}

// Serverless recovery: lets someone at the device set a NEW Manager PIN without
// losing data. It's deliberately recorded in the Activity Log (auth.pin_reset),
// so the action is recoverable but never silent/anonymous.
function openPinRecovery() {
  const p1 = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'New Manager PIN (4-6 digits)', autocomplete: 'off' });
  const p2 = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'Confirm new PIN', autocomplete: 'off' });
  const body = el('div', {}, [
    el('div', { class: 'pill-warn', html: 'This app has no server, so the Manager PIN is reset here on the device. Your ledger and history are <strong>kept</strong>. This reset is logged to the <strong>Activity Log</strong>.' }),
    el('div', { class: 'field mt' }, [el('label', { text: 'New Manager PIN' }), p1]),
    el('div', { class: 'field' }, [el('label', { text: 'Confirm' }), p2]),
  ]);
  openModal({
    title: 'Reset Manager PIN', sub: 'Set a new manager PIN for this device.', body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Reset PIN', kind: 'primary', onClick: (close) => {
        if ((p1.value || '').length < 4) return toast('PIN must be at least 4 digits', 'warn');
        if (p1.value !== p2.value) return toast('PINs do not match', 'warn');
        store.changePin('manager', p1.value, { recovery: true });
        toast('Manager PIN reset — sign in with the new PIN', 'ok');
        close();
      } },
    ],
  });
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
  const side = el('aside', { class: 'sidebar' });
  side.appendChild(el('div', { class: 'brand' }, [
    el('img', { class: 'logo', src: LOGO_LIGHT, alt: 'Frendz', style: 'filter:brightness(0) invert(1)' }),
  ]));
  const nav = el('nav', { class: 'nav' });
  const order = ['dashboard', 'deposit', 'refund', 'outstanding', 'ledger', 'shifts'];
  for (const id of order) addNav(nav, id);
  nav.appendChild(el('div', { class: 'nav-sep' }));
  nav.appendChild(el('div', { class: 'mgr-only', text: 'Manager' }));
  addNav(nav, 'activity');
  addNav(nav, 'settings');
  side.appendChild(nav);

  const s = store.session;
  side.appendChild(el('div', { class: 'side-foot' }, [
    el('div', { class: 'who', text: s ? s.name : '' }),
    el('div', { text: s && s.role === 'manager' ? 'Manager' : 'Staff' }),
    el('button', { text: 'Sign out', onClick: () => { store.logout(); renderLogin(); } }),
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

function navigate(id) {
  if (VIEWS[id].mgr && !store.isManager()) {
    managerGate(() => { current = id; renderShell(); }, { reason: 'Settings is manager-only.' });
    return;
  }
  current = id;
  // update active states without full reshell to keep it snappy
  $('.sidebar') ? renderShell() : renderShell();
}

function renderCurrent() {
  const main = document.getElementById('main-view');
  if (!main) return;
  clear(main);
  const ctx = { navigate, store };
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
        gh.autoBackup(`shift ${s.label} ${s.businessDate} close`); // fire-and-forget; no-op unless enabled
        renderShell();
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
        managerGate(() => {
          store.setBeginningBalance(parseFloat(input.value || '0') || 0, { source: 'manual' });
          toast(`Beginning balance set · COH now ${peso(store.coh())}`, 'ok');
          renderShell();
        }, { reason: 'Approve changing the beginning balance' });
      } }),
    ]),
    cohLine,
    el('div', { class: 'hint mt', text: `Net flow from ${store.ledger.length.toLocaleString()} ledger entries: ${net >= 0 ? '+' : ''}${peso(net)} · current COH ${peso(coh)}` }),
    el('hr', { class: 'hr' }),
    el('p', { class: 'muted', style: 'margin:0', html: 'Tie COH to the live sheet\'s figure. This books <strong>one labelled reconciliation entry</strong> (a visible cash-in/out adjustment in the ledger) — the opening float and individual transactions are untouched.' }),
    el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
      el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Reconcile COH to (₱)' }), target]),
      el('button', { class: 'btn', text: 'Reconcile', onClick: () => {
        const t = parseFloat(target.value || ''); if (!isFinite(t)) return toast('Enter a target COH', 'warn');
        managerGate(() => {
          const e = store.reconcileCOH(t, { source: 'manual' });
          toast(e ? `Reconciled · COH now ${peso(store.coh())}` : 'COH already matches', 'ok');
          renderShell();
        }, { reason: `Approve reconciling COH to ₱${pesoPlain(t)}` });
      } }),
    ]),
  ]);
}

function renderGitHubCard() {
  const g = store.config.github || {};
  const owner = el('input', { class: 'input', placeholder: 'github username / org', value: g.owner || '' });
  const repo = el('input', { class: 'input', placeholder: 'repository name', value: g.repo || '' });
  const branch = el('input', { class: 'input', placeholder: 'main', value: g.branch || 'main' });
  const path = el('input', { class: 'input', placeholder: 'data/ledger-backup.json', value: g.path || 'data/ledger-backup.json' });
  const token = el('input', { class: 'input', type: 'password', placeholder: gh.hasToken() ? '•••••••• (saved — leave blank to keep)' : 'fine-grained PAT (Contents: read & write)', autocomplete: 'off' });
  const auto = el('input', { type: 'checkbox' });
  auto.checked = !!g.autoOnClose;

  const status = el('div', { class: 'muted', style: 'font-size:.82rem;margin-top:10px' },
    g.lastBackupAt ? `Last backup: ${fmtDateTime(g.lastBackupAt)}` : 'No GitHub backup yet.');

  const saveCfg = () => {
    store.setConfig({ github: {
      owner: owner.value.trim(), repo: repo.value.trim(),
      branch: branch.value.trim() || 'main', path: path.value.trim() || 'data/ledger-backup.json',
      autoOnClose: auto.checked, enabled: g.enabled || false,
      lastBackupAt: g.lastBackupAt, lastBackupSha: g.lastBackupSha,
    } });
    if (token.value.trim()) { gh.setToken(token.value.trim()); token.value = ''; token.placeholder = '•••••••• (saved — leave blank to keep)'; }
  };

  const card = el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { html: '☁ GitHub backup' }), el('span', { class: 'sub', text: 'Git history = off-device audit trail' })]),
    el('div', { class: 'pill-warn', html: 'Use a <strong>fine-grained Personal Access Token</strong> scoped to <em>only this repo</em> with <strong>Contents: Read and write</strong>. The token is stored locally on this device only — never in exports. Best on a private repo.' }),
    el('div', { class: 'row2 mt' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Owner' }), owner]),
      el('div', { class: 'field' }, [el('label', { text: 'Repository' }), repo]),
    ]),
    el('div', { class: 'row2' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Branch' }), branch]),
      el('div', { class: 'field' }, [el('label', { text: 'File path' }), path]),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Access token' }), token]),
    el('label', { class: 'flex aic gap', style: 'font-size:.88rem;cursor:pointer;margin-bottom:6px' }, [auto, 'Auto-backup every time a shift is closed']),
    el('div', { class: 'flex gap wrap mt' }, [
      el('button', { class: 'btn', text: 'Test connection', onClick: async (ev) => {
        saveCfg(); const b = ev.currentTarget; b.disabled = true; b.textContent = 'Testing…';
        try { const name = await gh.testConnection(); toast('Connected to ' + name + ' ✓', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
        b.disabled = false; b.textContent = 'Test connection';
      } }),
      el('button', { class: 'btn', text: 'Save settings', onClick: () => { saveCfg(); store._audit('settings.github.update', `Updated GitHub backup target ${store.config.github.owner}/${store.config.github.repo}`, { owner: store.config.github.owner, repo: store.config.github.repo, autoOnClose: store.config.github.autoOnClose }); toast('GitHub settings saved', 'ok'); } }),
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
  const newM = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'New Manager PIN (4-6 digits)', autocomplete: 'off' });
  const newS = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'New Staff PIN (blank = remove)', autocomplete: 'off' });
  const req = el('input', { type: 'checkbox' });
  req.checked = !!store.config.requireStaffPin;
  return el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Security · PINs' }), el('span', { class: 'sub', text: 'changes are recorded in the Activity Log' })]),
    el('div', { class: 'row2' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Change Manager PIN' }), newM,
        el('button', { class: 'btn sm mt', text: 'Update Manager PIN', onClick: () => {
          if ((newM.value || '').length < 4) return toast('Manager PIN must be at least 4 digits', 'warn');
          store.changePin('manager', newM.value); newM.value = ''; toast('Manager PIN updated', 'ok');
        } }),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Change Staff PIN' }), newS,
        el('label', { class: 'flex aic gap', style: 'font-size:.84rem;cursor:pointer;margin-top:8px' }, [req, 'Require staff PIN at login']),
        el('button', { class: 'btn sm mt', text: 'Update staff access', onClick: () => {
          store.changePin('staff', newS.value || null);
          store.setConfig({ requireStaffPin: req.checked });
          newS.value = ''; toast('Staff access updated', 'ok');
        } }),
      ]),
    ]),
  ]);
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
const OFFICIAL_COH = 58800;
// Bump this whenever the committed records / COH change. A device whose stored
// `officialDataVersion` differs auto-loads the latest records on next open
// (see ensureProvisioned). Lets "apply the new data" propagate without a reset.
const OFFICIAL_DATA_VERSION = '2026-06-02-coh58800';
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

// boot
mount();
window.addEventListener('error', (e) => console.error('global', e.error));
