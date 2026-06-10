// views/towels.js — the Towel Tracker. A physical-towel inventory layered on top
// of the cash ledger: each towel is Available, Out (with a guest), Lost, or written
// off. State is a live projection of Towel deposits/refunds (store.towelStatus()),
// so it always agrees with the ledger; admin actions resolve lost towels.
import { el, peso, pesoPlain, fmtDateTime, clear, toast, nowISO } from '../util.js';
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
  dirty: { cls: 'dirty', label: 'dirty' },
  washing: { cls: 'exg', label: 'being washed' },
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
  const recOn = store.towelRecording.enabled;
  const lostStats = store.lostTowelStats();
  root.appendChild(el('div', { class: 'card', style: 'margin-bottom:18px' }, [
    el('div', { class: 'flex between aic wrap gap' }, [
      stat('Available', summary.available, 'var(--in-700)', 'clean & on the shelf'),
      stat('Out', summary.out, 'var(--gold-700)', 'with guests'),
      recOn ? stat('Dirty', summary.dirty, '#b45309', 'returned, to wash') : null,
      recOn ? stat('Being washed', summary.washing, '#5b4bcf', 'at the laundry') : null,
      stat('Lost', summary.lost, 'var(--out-700)', `₱${pesoPlain(lostStats.value)} forfeited`),
      stat('Written off', summary.writeoff, 'var(--muted)', 'retired'),
      stat('In service', summary.inService, 'var(--ink)', 'total held'),
    ]),
  ]));

  // ---- laundry analytics + CSV (everyone, once recording is on) ----
  if (recOn) root.appendChild(renderAnalytics(ctx));

  // ---- manage inventory + dirty-towel recording (admin only) ----
  if (store.isManager()) root.appendChild(renderManage(ctx, summary));
  if (store.isManager()) root.appendChild(renderRecording(ctx));

  // ---- status table (everyone can view) ----
  root.appendChild(renderTable(ctx));
  return root;
}

// Period-over-period change label (▲/▼ % vs the previous period).
function laundryDelta(cur, prev) {
  if (prev == null) return { text: '', color: 'var(--muted)' };
  if (prev === 0) return { text: cur === 0 ? 'no change' : 'new', color: 'var(--muted)' };
  const d = cur - prev;
  if (d === 0) return { text: 'no change', color: 'var(--muted)' };
  return { text: `${d > 0 ? '▲' : '▼'} ${Math.abs(Math.round((d / prev) * 100))}% vs prev`, color: d > 0 ? '#b45309' : 'var(--in-700)' };
}
const csvField = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function downloadCSV(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function exportLaundryCSV(granularity) {
  const count = granularity === 'day' ? 30 : 12;
  const rows = store.laundryPeriodReport(granularity, count);
  if (!rows.length) { toast('No records yet for this period', 'warn'); return; }
  const lines = [['Period start', 'Period end', 'Dirty in', 'Sent to laundry', 'Cleaned'].join(',')];
  for (const r of rows) lines.push([csvField(fmtDateTime(r.start)), csvField(fmtDateTime(r.end)), r.dirtyIn, r.sentToWash, r.cleaned].join(','));
  const stamp = new Date(Date.parse(nowISO())).toISOString().slice(0, 10);
  downloadCSV(`towel-laundry-${granularity}-${stamp}.csv`, lines.join('\n'));
  toast(`Exported ${rows.length} ${granularity} record${rows.length === 1 ? '' : 's'}`, 'ok');
}

// Laundry analytics: current period vs previous for Day / Week / Month, plus CSV export.
function renderAnalytics(ctx) {
  const rec = store.towelRecording;
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Laundry analytics' }), el('span', { class: 'sub', text: `day = ${rec.hours}h cycle · week = 7 · month = 30` })]),
  ]);
  const panel = (label, sub, g) => {
    const c = store.laundryCompare(g);
    const cur = c.current || { dirtyIn: 0, sentToWash: 0 };
    const prev = c.previous;
    const dd = laundryDelta(cur.dirtyIn, prev ? prev.dirtyIn : null);
    const dw = laundryDelta(cur.sentToWash, prev ? prev.sentToWash : null);
    const line = (k, v, d) => el('div', { style: 'margin-top:4px' }, [
      el('span', { class: 'muted', text: k + ' ' }), el('strong', { text: String(v) }),
      d.text ? el('span', { style: `margin-left:6px;font-size:.78rem;color:${d.color}`, text: d.text }) : null,
    ]);
    return el('div', { style: 'min-width:200px;flex:1' }, [
      el('div', { class: 'k', style: 'font-size:.76rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700', text: label }),
      el('div', { class: 'muted', style: 'font-size:.76rem;margin-bottom:4px', text: sub }),
      line('Dirty in', cur.dirtyIn, dd),
      line('Sent to laundry', cur.sentToWash, dw),
    ]);
  };
  card.appendChild(el('div', { class: 'flex gap wrap', style: 'gap:28px' }, [
    panel('Today', 'vs previous day', 'day'),
    panel('This week', 'vs previous week', 'week'),
    panel('This month', 'vs previous month', 'month'),
  ]));
  card.appendChild(el('hr', { class: 'hr' }));
  card.appendChild(el('div', { class: 'flex gap wrap aic' }, [
    el('span', { class: 'muted', style: 'font-size:.84rem', text: 'Export records to CSV:' }),
    el('button', { class: 'btn sm', html: '⬇ Day', onClick: () => exportLaundryCSV('day') }),
    el('button', { class: 'btn sm', html: '⬇ Week', onClick: () => exportLaundryCSV('week') }),
    el('button', { class: 'btn sm', html: '⬇ Month', onClick: () => exportLaundryCSV('month') }),
  ]));
  return card;
}

// ISO → value for <input type=datetime-local> (local "YYYY-MM-DDTHH:mm").
function toLocalInput(iso) {
  const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Admin tool: set the dirty-towel recording period (cycle anchor + length in hours).
// Enabling it turns on dirty-towel tracking; returns from the start onward become Dirty.
function renderRecording(ctx) {
  const rec = store.towelRecording;
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Dirty-towel recording' }), el('span', { class: 'sub', text: 'manager only' })]),
    el('p', { class: 'muted', style: 'margin-top:0', html: 'Turn this on to track <strong>dirty towels</strong>. From the cycle start, every towel a guest returns (refund or exchange) becomes <strong>Dirty</strong> and is held out of the Available pool until it\'s washed and marked Clean. The period length sets the day-to-day record cycle (any number of hours).' }),
  ]);
  if (rec.enabled) {
    const p = store.currentRecordingPeriod();
    card.appendChild(el('div', { class: 'pill', html: `Recording is <strong>ON</strong> · ${rec.hours}h cycle${p ? ` · current period <strong>${fmtDateTime(p.start)}</strong> → <strong>${fmtDateTime(p.end)}</strong>` : ''}` }));
  }
  const startInput = el('input', { class: 'input', type: 'datetime-local', value: toLocalInput(rec.startedAt || nowISO()) });
  const hoursInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: String(rec.hours || 24), style: 'max-width:140px' });
  card.appendChild(el('div', { class: 'flex gap mt', style: 'align-items:flex-end;flex-wrap:wrap' }, [
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Cycle start (date & time)' }), startInput]),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Period length (hours)' }), hoursInput, el('div', { class: 'hint', text: '24 = daily · 168 = weekly · any value allowed' })]),
    el('button', {
      class: 'btn primary', text: rec.enabled ? 'Update period' : 'Enable recording',
      onClick: () => managerGate(() => {
        const h = parseInt(hoursInput.value || '24', 10);
        if (!(h >= 1)) return toast('Period must be at least 1 hour', 'warn');
        const startISO = startInput.value ? new Date(startInput.value).toISOString() : nowISO();
        store.setTowelRecording({ startedAt: startISO, hours: h });
        toast(`Recording period set · ${h}h`, 'ok');
        ctx.navigate('towels');
      }, { reason: 'Setting the towel recording period is a manager action.' }),
    }),
  ]));
  return card;
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
  // The Laundry tab only appears once dirty-towel recording is enabled.
  const tabs = TABS.slice();
  if (store.towelRecording.enabled) tabs.splice(1, 0, { key: 'laundry', label: 'Laundry', set: ['dirty', 'washing'], empty: 'No dirty towels.' });

  const tabBar = el('div', { class: 'towel-tabs' });
  const tabBtns = {};
  for (const t of tabs) {
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

  // Refresh both tab counts and the table (used after an action changes state).
  function sync() {
    const all = store.towelStatus();
    for (const t of tabs) {
      tabBtns[t.key].classList.toggle('active', t.key === mode);
      tabBtns[t.key].querySelector('.tab-count').textContent = String(all.filter((x) => t.set.includes(x.status)).length);
    }
    if (mode === 'laundry') paintLaundry(all);
    else paint(all);
  }

  // ---- Laundry management: checkbox list + select-all + bulk move + add-dirty ----
  function paintLaundry(all) {
    const q = search.value.toLowerCase().trim();
    let rows = (all || store.towelStatus()).filter((t) => t.status === 'dirty' || t.status === 'washing');
    if (q) rows = rows.filter((t) => { const le = t.lastEvent || {}; return `${t.no} ${le.guest || ''} ${le.room || ''}`.toLowerCase().includes(q); });
    rows.sort((a, b) => (a.status === b.status ? 0 : a.status === 'dirty' ? -1 : 1));
    clear(wrap);

    const selected = new Set();
    const bar = el('div', { class: 'flex between aic wrap gap', style: 'padding:12px 16px;border-bottom:1px solid var(--line)' });
    const selAll = el('input', { type: 'checkbox', title: 'Select all' });
    const count = el('span', { class: 'muted', style: 'font-size:.84rem' });
    const dirtyBtn = el('button', { class: 'btn sm', html: '↩ Back to dirty', disabled: true, title: 'Revert to dirty (admin)' });
    const washBtn = el('button', { class: 'btn sm', text: '🧺 Send to laundry', disabled: true });
    const cleanBtn = el('button', { class: 'btn primary sm', text: '✓ Mark clean', disabled: true });
    const removeBtn = el('button', { class: 'btn ghost sm', text: '✕ Remove', disabled: true, title: 'Take off the list (back to available)' });
    const btns = [dirtyBtn, washBtn, cleanBtn, removeBtn];
    function refreshBar() {
      count.textContent = selected.size ? `${selected.size} selected` : `${rows.length} towel${rows.length === 1 ? '' : 's'}`;
      btns.forEach((b) => { b.disabled = selected.size === 0; });
    }
    // Apply a laundry status to the selection. `admin` gates the action behind a PIN.
    const apply = (status, { admin } = {}) => {
      const nos = [...selected];
      if (!nos.length) return;
      const run = () => {
        store.setLaundryStatus(nos, status);
        const verb = { washing: 'sent to laundry', clean: 'marked clean', dirty: 'moved back to dirty', remove: 'removed from the list' }[status];
        toast(`${nos.length} towel${nos.length === 1 ? '' : 's'} ${verb}`, 'ok');
        sync();
      };
      if (admin) managerGate(run, { reason: 'Reverting towels back to dirty is a manager action.' });
      else run();
    };
    dirtyBtn.addEventListener('click', () => apply('dirty', { admin: true }));
    washBtn.addEventListener('click', () => apply('washing'));
    cleanBtn.addEventListener('click', () => apply('clean'));
    removeBtn.addEventListener('click', () => apply('remove'));
    bar.append(
      el('label', { class: 'flex aic gap', style: 'cursor:pointer;font-size:.86rem;font-weight:600' }, [selAll, 'Select all']),
      count,
      el('div', { class: 'flex gap wrap', style: 'margin-left:auto' }, btns),
    );
    wrap.appendChild(bar);

    // Manually add a towel to the dirty list (e.g. one returned without going through refund).
    const addInput = el('input', { class: 'input', placeholder: 'Add dirty towel # — e.g. 12 or 12, 13', style: 'max-width:260px;font-family:var(--font-mono)' });
    wrap.appendChild(el('div', { class: 'flex gap aic', style: 'padding:10px 16px;border-bottom:1px solid var(--line)' }, [
      addInput,
      el('button', {
        class: 'btn sm', text: '+ Add to dirty',
        onClick: () => { const nos = parseTowelInput(addInput.value); if (!nos.length) return toast('Enter a towel number', 'warn'); store.setLaundryStatus(nos, 'dirty'); toast(`${nos.length} towel${nos.length === 1 ? '' : 's'} added to dirty`, 'ok'); sync(); },
      }),
    ]));

    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🧺' }), el('p', { text: q ? 'No dirty towels match.' : 'No dirty towels — all caught up.' })]));
      return;
    }
    const boxes = [];
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: '' }), el('th', { text: 'Towel #' }), el('th', { text: 'Status' }), el('th', { text: 'Last guest' }), el('th', { text: 'Since' }), el('th', { class: 'num', text: '' }),
    ])));
    const tb = el('tbody');
    for (const t of rows.slice(0, 800)) {
      const m = STATUS_META[t.status] || { cls: 'rev', label: t.status };
      const le = t.lastEvent || {};
      const box = el('input', { type: 'checkbox', onChange: (e) => { if (e.target.checked) selected.add(t.no); else selected.delete(t.no); selAll.checked = selected.size === rows.length; refreshBar(); } });
      boxes.push(box);
      tb.append(el('tr', {}, [
        el('td', {}, box),
        el('td', {}, el('span', { class: 'tag towel', style: 'cursor:pointer', title: 'History', onClick: () => openTowelHistory(t.no), text: t.no })),
        el('td', {}, el('span', { class: 'tag ' + m.cls, text: m.label })),
        el('td', {}, le.guest ? [el('span', { class: 'muted', text: `${le.guest}${le.room ? ' · ' + le.room : ''}` })] : el('span', { class: 'muted', text: '—' })),
        el('td', { text: le.ts ? fmtDateTime(le.ts) : '—' }),
        el('td', { class: 'num' }, el('div', { class: 'flex gap', style: 'justify-content:flex-end' }, t.status === 'dirty'
          ? [
            el('button', { class: 'btn ghost sm', text: 'Wash', onClick: () => { store.setLaundryStatus([t.no], 'washing'); sync(); } }),
            el('button', { class: 'btn ghost sm', text: 'Remove', onClick: () => { store.setLaundryStatus([t.no], 'remove'); toast(`Towel #${t.no} removed from the list`, 'ok'); sync(); } }),
          ]
          : [
            el('button', { class: 'btn ghost sm', text: 'Clean', onClick: () => { store.setLaundryStatus([t.no], 'clean'); sync(); } }),
            el('button', { class: 'btn ghost sm', text: '↩ Dirty', title: 'Back to dirty (admin)', onClick: () => managerGate(() => { store.setLaundryStatus([t.no], 'dirty'); toast(`Towel #${t.no} back to dirty`, 'ok'); sync(); }, { reason: 'Reverting a towel back to dirty is a manager action.' }) }),
            el('button', { class: 'btn ghost sm', text: 'Remove', onClick: () => { store.setLaundryStatus([t.no], 'remove'); toast(`Towel #${t.no} removed from the list`, 'ok'); sync(); } }),
          ])),
      ]));
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
    selAll.addEventListener('change', () => { selected.clear(); if (selAll.checked) rows.forEach((t) => selected.add(t.no)); boxes.forEach((b) => { b.checked = selAll.checked; }); refreshBar(); });
    refreshBar();
  }

  function paint(all) {
    const tab = tabs.find((t) => t.key === mode) || tabs[0];
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
      const h = t.holder;       // current holder (only when out)
      const le = t.lastEvent;   // most recent activity, even if returned/available
      // When out → current guest (bold). Otherwise show the last person who had it
      // ("last: …"), so an available towel still shows its most recent link.
      const guestCell = h
        ? [el('strong', { text: h.guest || '—' }), h.room ? el('span', { class: 'muted', text: ' · ' + h.room }) : null]
        : (le ? [el('span', { class: 'muted', text: `last: ${le.guest || '—'}${le.room ? ' · ' + le.room : ''}` })] : el('span', { class: 'muted', text: '—' }));
      const when = h ? h.ts : (le ? le.ts : null);
      const who = h ? h.staff : (le ? le.staff : null);
      tb.append(el('tr', {}, [
        el('td', {}, [el('span', { class: 'tag towel', style: 'cursor:pointer', title: 'View this towel\'s deposit/refund history', onClick: () => openTowelHistory(t.no), text: t.no }), t.registered ? null : el('span', { class: 'tag rev', style: 'margin-left:6px', text: 'unregistered' })]),
        el('td', {}, el('span', { class: 'tag ' + m.cls, text: m.label })),
        el('td', {}, guestCell),
        el('td', { text: when ? fmtDateTime(when) : '—' }),
        el('td', { text: who || '—' }),
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
  // Current state up top so the most-recent status is obvious without scrolling.
  const cur = store.towelStatus().find((s) => s.no === no);
  if (cur) {
    const m = STATUS_META[cur.status] || { cls: 'rev', label: cur.status };
    const h = cur.holder;
    body.appendChild(el('div', { class: 'pill', style: 'margin-bottom:14px' }, [
      el('span', { text: 'Currently ' }), el('span', { class: 'tag ' + m.cls, text: m.label }),
      h ? el('span', { text: ` · ${h.guest || '—'}${h.room ? ' · Room ' + h.room : ''} · since ${fmtDateTime(h.ts)}` }) : null,
    ]));
  }
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
      const isExg = h.kind === 'exchange';
      const label = isExg ? 'exchange' : h.kind === 'deposit' ? 'deposit' : (h.towelLost ? 'lost' : 'refund');
      const cls = isExg ? 'exg' : h.kind === 'deposit' ? 'dep' : (h.towelLost ? 'rev' : 'ref');
      tb.append(el('tr', {}, [
        el('td', { text: fmtDateTime(h.ts) }),
        el('td', {}, [el('span', { class: 'tag ' + cls, text: label }), isExg ? el('span', { class: 'muted', style: 'margin-left:6px;font-size:.78rem', text: `#${h.oldTowelNo || '—'} → #${h.towelNo || '—'}` }) : null]),
        el('td', {}, [el('strong', { text: h.guest || '—' }), h.room ? el('span', { class: 'muted', text: ' · ' + h.room }) : null]),
        isExg ? el('td', { class: 'num muted', text: '—' }) : el('td', { class: 'num ' + (h.direction > 0 ? 'amt-in' : 'amt-out'), text: `${h.direction > 0 ? '+' : '−'}${pesoPlain(h.amount)}` }),
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
