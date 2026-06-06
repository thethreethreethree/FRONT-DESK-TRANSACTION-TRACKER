// views/towels.js — the Towel Tracker. A physical-towel inventory layered on top
// of the cash ledger: each towel is Available, Out (with a guest), Lost, or written
// off. State is a live projection of Towel deposits/refunds (store.towelStatus()),
// so it always agrees with the ledger; admin actions resolve lost towels.
import { el, peso, pesoPlain, fmtDateTime, clear, toast } from '../util.js';
import { store } from '../store.js';
import { pageHead, managerGate, confirmDialog, openModal } from '../components.js';

// Parse "1-300", "1,2,5", or a mixed/newline list into individual towel numbers.
function parseTowelInput(str) {
  const nos = new Set();
  for (const part of String(str || '').split(/[\n,]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*[-–]\s*(\d+)$/); // a range like 1-300
    if (m) {
      let a = +m[1], b = +m[2];
      if (a > b) { const t = a; a = b; b = t; }
      if (b - a > 5000) b = a + 5000; // safety cap
      for (let i = a; i <= b; i++) nos.add(String(i));
    } else nos.add(p.toUpperCase());
  }
  return [...nos];
}

const STATUS_META = {
  available: { cls: 'dep', label: 'available' },
  out: { cls: 'shift', label: 'out' },
  lost: { cls: 'ref', label: 'lost' },
  writeoff: { cls: 'rev', label: 'written off' },
};

export function render(ctx) {
  const root = el('div');

  if (!store.towelTracker.enabled) {
    root.appendChild(pageHead('Towel Tracker', 'Track every physical towel — available, out with a guest, or lost', null));
    root.appendChild(store.isManager() ? renderSetup(ctx) : el('div', { class: 'card' }, el('div', { class: 'empty' }, [
      el('div', { class: 'ic', text: '🧺' }), el('p', { text: 'The towel tracker hasn\'t been set up yet. Ask an admin to enter the inventory.' }),
    ])));
    return root;
  }

  const summary = store.towelSummary();
  root.appendChild(pageHead('Towel Tracker',
    `${summary.inService} towels in service · tracking since ${fmtDateTime(store.towelBaseline())}`, null));

  // ---- summary stats ----
  const stat = (k, v, color, meta) => el('div', { class: 'stat', style: 'min-width:120px' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', style: `color:${color};font-size:1.7rem`, text: String(v) }),
    meta ? el('span', { class: 'meta', text: meta }) : null,
  ]);
  root.appendChild(el('div', { class: 'card', style: 'margin-bottom:18px' }, [
    el('div', { class: 'flex between aic wrap gap' }, [
      stat('Available', summary.available, 'var(--in-700)', 'on the shelf'),
      stat('Out', summary.out, 'var(--gold-700)', 'with guests'),
      stat('Lost', summary.lost, 'var(--out-700)', 'awaiting admin'),
      stat('Written off', summary.writeoff, 'var(--muted)', 'retired'),
      stat('In service', summary.inService, 'var(--ink)', 'available + out + lost'),
    ]),
  ]));

  // ---- manage inventory (admin only) ----
  if (store.isManager()) root.appendChild(renderManage(ctx, summary));

  // ---- status table (everyone can view) ----
  root.appendChild(renderTable(ctx));
  return root;
}

function renderSetup(ctx) {
  const card = el('div', { class: 'card elev', style: 'max-width:680px' });
  card.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: 'Set up the towel inventory' })]));
  card.appendChild(el('p', { class: 'muted', style: 'margin-top:0', html: 'Enter the towels you physically have now — they all start as <strong>Available</strong>. From this moment on, every Towel deposit marks its number <strong>Out</strong> (with the guest, room, time and staff), every refund brings it back, and a lost towel gets flagged for your review.' }));
  card.appendChild(el('div', { class: 'pill', html: 'This is a <strong>clean start</strong>. Past transactions stay in the ledger as the financial record, but they don\'t seed towel status — historical refunds never recorded a towel number, so who-has-what can\'t be reconstructed reliably.' }));
  const input = el('textarea', { class: 'input', rows: '3', placeholder: 'e.g. 1-300   (or: 1, 2, 5, B-01)', style: 'font-family:var(--font-mono)' });
  card.appendChild(el('div', { class: 'field mt' }, [el('label', { text: 'Starting towel numbers' }), input, el('div', { class: 'hint', text: 'Enter a range like 1-300, a comma list, or both. You can add more later.' })]));
  card.appendChild(el('button', {
    class: 'btn primary lg block mt', text: 'Enable tracker & add towels',
    onClick: () => managerGate(() => {
      const nos = parseTowelInput(input.value);
      store.enableTowelTracker();
      const added = store.addTowels(nos);
      toast(`Towel tracker enabled · ${added.length} towel${added.length === 1 ? '' : 's'} added`, 'ok');
      ctx.navigate('towels');
    }, { reason: 'Enabling the towel tracker is a manager action.' }),
  }));
  return card;
}

function renderManage(ctx, summary) {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Manage inventory' }), el('span', { class: 'sub', text: 'manager only' })]),
  ]);
  if (summary.unregistered) {
    card.appendChild(el('div', { class: 'pill-warn', html: `<strong>${summary.unregistered}</strong> towel number${summary.unregistered === 1 ? ' is' : 's are'} in use but not in your inventory list. Add them below so your counts are complete.` }));
  }
  const input = el('input', { class: 'input', placeholder: 'Add towels — e.g. 301-320 or 5, 6', style: 'font-family:var(--font-mono)' });
  card.appendChild(el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
    el('div', { class: 'field', style: 'flex:1;margin:0' }, [el('label', { text: 'Add towel numbers' }), input]),
    el('button', {
      class: 'btn primary', text: 'Add',
      onClick: () => managerGate(() => {
        const nos = parseTowelInput(input.value);
        if (!nos.length) return toast('Enter at least one towel number', 'warn');
        const added = store.addTowels(nos);
        toast(added.length ? `${added.length} towel${added.length === 1 ? '' : 's'} added` : 'Those towels are already in inventory', added.length ? 'ok' : 'warn');
        ctx.navigate('towels');
      }, { reason: 'Adding towels is a manager action.' }),
    }),
  ]));

  // Reset — clears the test/old inventory so the team can start fresh. Cash ledger
  // is never touched; only the towel-inventory layer is wiped and returned to setup.
  card.appendChild(el('hr', { class: 'hr' }));
  card.appendChild(el('div', { class: 'flex between aic wrap gap' }, [
    el('div', {}, [
      el('strong', { text: 'Reset towel tracker' }),
      el('div', { class: 'muted', style: 'font-size:.82rem', text: 'Clears the inventory and the retired/missing records, then returns to setup. The cash ledger is not affected.' }),
    ]),
    el('button', {
      class: 'btn out', text: 'Reset…',
      onClick: () => confirmDialog({
        title: 'Reset towel tracker?',
        sub: 'Clears every towel in the inventory and the retired & missing records, then returns the tracker to setup so you can start fresh. This does NOT touch the cash ledger, and cannot be undone.',
        confirmLabel: 'Reset tracker', kind: 'out',
        onConfirm: () => { store.resetTowelTracker(); toast('Towel tracker reset — start fresh', 'ok'); ctx.navigate('towels'); },
      }),
    }),
  ]));
  return card;
}

// Two records on one page: "In circulation" (available + out) is the default;
// "Retired & missing" (written off + lost) is the archive — out of the system, so
// it stays tucked behind its own tab rather than cluttering the live list.
const TABS = [
  { key: 'active', label: 'In circulation', set: ['available', 'out'], empty: 'No towels in circulation.' },
  { key: 'archive', label: 'Retired & missing', set: ['writeoff', 'lost'], empty: 'No retired or missing towels.' },
];

function renderTable(ctx) {
  const card = el('div', { class: 'card', style: 'padding:0;overflow:hidden' });
  let mode = 'active';

  const tabBar = el('div', { class: 'towel-tabs' });
  const tabBtns = {};
  for (const t of TABS) {
    const b = el('button', { class: 'towel-tab', onClick: () => { mode = t.key; sync(); } }, [
      el('span', { text: t.label }), el('span', { class: 'tab-count', text: '0' }),
    ]);
    tabBtns[t.key] = b;
    tabBar.appendChild(b);
  }
  card.appendChild(tabBar);

  const filters = el('div', { class: 'filters', style: 'padding:12px 16px 0;margin-bottom:0' });
  const search = el('input', { class: 'input search', placeholder: 'Search towel #, guest or room…', autocomplete: 'off' });
  filters.append(search);
  card.appendChild(filters);

  const wrap = el('div', { class: 'table-wrap', style: 'border:0' });
  card.appendChild(wrap);

  // Refresh both tab counts and the table (used after an admin action changes state).
  function sync() {
    const all = store.towelStatus();
    for (const t of TABS) {
      tabBtns[t.key].classList.toggle('active', t.key === mode);
      tabBtns[t.key].querySelector('.tab-count').textContent = String(all.filter((x) => t.set.includes(x.status)).length);
    }
    paint(all);
  }

  function paint(all) {
    const tab = TABS.find((t) => t.key === mode) || TABS[0];
    const q = search.value.toLowerCase().trim();
    let rows = (all || store.towelStatus()).filter((t) => tab.set.includes(t.status));
    if (q) rows = rows.filter((t) => { const h = t.holder || {}; return `${t.no} ${h.guest || ''} ${h.room || ''}`.toLowerCase().includes(q); });

    clear(wrap);
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: mode === 'archive' ? '🗄' : '🧺' }), el('p', { text: q ? 'No towels match.' : tab.empty })]));
      return;
    }
    const CAP = 600;
    const shown = rows.slice(0, CAP);
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Towel #' }), el('th', { text: 'Status' }), el('th', { text: 'Guest / Room' }),
      el('th', { text: 'Since' }), el('th', { text: 'Issued by' }), el('th', { class: 'num', text: '' }),
    ])));
    const tb = el('tbody');
    for (const t of shown) {
      const m = STATUS_META[t.status] || { cls: 'rev', label: t.status };
      const h = t.holder;
      tb.append(el('tr', {}, [
        el('td', {}, [el('span', { class: 'tag towel', style: 'cursor:pointer', title: 'View this towel\'s deposit/refund history', onClick: () => openTowelHistory(t.no), text: t.no }), t.registered ? null : el('span', { class: 'tag rev', style: 'margin-left:6px', text: 'unregistered' })]),
        el('td', {}, el('span', { class: 'tag ' + m.cls, text: m.label })),
        el('td', {}, h ? [el('strong', { text: h.guest || '—' }), h.room ? el('span', { class: 'muted', text: ' · ' + h.room }) : null] : el('span', { class: 'muted', text: '—' })),
        el('td', { text: h ? fmtDateTime(h.ts) : '—' }),
        el('td', { text: h ? (h.staff || '—') : '—' }),
        el('td', { class: 'num' }, actionCell(t, ctx, sync)),
      ]));
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
    if (rows.length > shown.length) {
      wrap.appendChild(el('div', { class: 'muted', style: 'padding:12px 16px;text-align:center;font-size:.82rem;border-top:1px solid var(--line)', text: `Showing ${shown.length} of ${rows.length}. Use search to narrow down.` }));
    }
  }
  search.addEventListener('input', () => paint());
  sync();
  return card;
}

function actionCell(t, ctx, refresh) {
  if (!store.isManager()) return null; // inventory changes are admin-only
  if (t.status === 'lost') {
    return el('div', { class: 'flex gap', style: 'justify-content:flex-end' }, [
      el('button', { class: 'btn ghost sm', text: 'Found', onClick: () => resolve(t.no, 'found', ctx, refresh) }),
      el('button', { class: 'btn ghost sm', text: 'Write off', onClick: () => resolve(t.no, 'writeoff', ctx, refresh) }),
    ]);
  }
  if (t.status === 'writeoff') {
    return el('button', { class: 'btn ghost sm', text: 'Restore', onClick: () => resolve(t.no, 'restore', ctx, refresh) });
  }
  if (t.status === 'available' && t.registered) {
    return el('button', { class: 'btn ghost sm', text: 'Write off', onClick: () => resolve(t.no, 'writeoff', ctx, refresh) });
  }
  return null;
}

// The full record behind a towel number: every deposit & refund tied to it.
function openTowelHistory(no) {
  const hist = store.towelHistory(no);
  const body = el('div', {});
  if (!hist.length) {
    body.appendChild(el('p', { class: 'muted', text: 'No deposit or refund records reference this towel number yet.' }));
  } else {
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'When' }), el('th', { text: 'Type' }), el('th', { text: 'Guest / Room' }),
      el('th', { class: 'num', text: 'Amount' }), el('th', { text: 'Staff' }),
    ])));
    const tb = el('tbody');
    for (const h of hist) {
      const label = h.kind === 'deposit' ? 'deposit' : (h.towelLost ? 'lost' : 'refund');
      const cls = h.kind === 'deposit' ? 'dep' : (h.towelLost ? 'rev' : 'ref');
      tb.append(el('tr', {}, [
        el('td', { text: fmtDateTime(h.ts) }),
        el('td', {}, el('span', { class: 'tag ' + cls, text: label })),
        el('td', {}, [el('strong', { text: h.guest || '—' }), h.room ? el('span', { class: 'muted', text: ' · ' + h.room }) : null]),
        el('td', { class: 'num ' + (h.direction > 0 ? 'amt-in' : 'amt-out'), text: `${h.direction > 0 ? '+' : '−'}${pesoPlain(h.amount)}` }),
        el('td', { text: h.staff || '—' }),
      ]));
    }
    tbl.appendChild(tb);
    body.appendChild(el('div', { class: 'table-wrap' }, tbl));
  }
  openModal({ title: `Towel #${no} — history`, sub: 'Every deposit & refund tied to this towel number', body, wide: true, actions: [{ label: 'Close', kind: 'ghost' }] });
}

function resolve(no, action, ctx, refresh) {
  const labels = {
    found: { title: `Mark towel #${no} found?`, sub: 'Returns it to the available inventory.', confirm: 'Mark found', kind: 'primary' },
    writeoff: { title: `Write off towel #${no}?`, sub: 'Retires it from service (lost for good / damaged). It stops counting toward your inventory.', confirm: 'Write off', kind: 'out' },
    restore: { title: `Restore towel #${no}?`, sub: 'Returns a written-off towel to the available inventory.', confirm: 'Restore', kind: 'primary' },
  }[action];
  confirmDialog({
    title: labels.title, sub: labels.sub, confirmLabel: labels.confirm, kind: labels.kind,
    onConfirm: () => managerGate(() => {
      store.resolveTowel(no, action);
      toast(`Towel #${no} updated`, 'ok');
      refresh();
    }, { reason: 'Resolving towels is a manager action.' }),
  });
}
