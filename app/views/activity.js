// views/activity.js — the staff activity log: who did what, and when.
// Append-only & hash-chained, like the cash ledger. Manager-only.
import { el, fmtDateTime, clear, escapeHtml } from '../util.js';
import { store } from '../store.js';
import { pageHead } from '../components.js';

// action -> { label, tag-class }
const ACTIONS = {
  'deposit.create': ['Deposit', 'dep'],
  'refund.create': ['Refund', 'ref'],
  'txn.void': ['Void', 'rev'],
  'shift.open': ['Shift open', 'shift'],
  'shift.close': ['Shift close', 'shift'],
  'item.create': ['Item added', 'gold'],
  'item.update': ['Item edited', 'gold'],
  'item.retire': ['Item retired', 'gold'],
  'item.restore': ['Item restored', 'gold'],
  'auth.login': ['Sign in', 'role'],
  'auth.logout': ['Sign out', 'role'],
  'auth.pin_change': ['PIN changed', 'role'],
  'auth.pin_reset': ['PIN reset', 'rev'],
  'setup.complete': ['Setup', 'gold'],
  'settings.beginning_balance': ['Beginning balance', 'gold'],
  'coh.reconcile': ['COH reconciled', 'gold'],
  'data.import': ['Import', 'rev'],
  'data.reset': ['Reset', 'rev'],
  'data.demo_loaded': ['Sample data', 'gold'],
  'data.csv_import': ['CSV import', 'gold'],
  'backup.github': ['GitHub backup', 'dep'],
  'backup.export': ['Export backup', 'shift'],
  'settings.github.update': ['GitHub settings', 'gold'],
};
function meta(action) { return ACTIONS[action] || [action, 'rev']; }

export function render(ctx) {
  const root = el('div');
  const integ = store.verifyAuditIntegrity();
  root.appendChild(pageHead(
    'Activity log',
    'Who entered, edited, or removed data — and when. Permanent & tamper-evident.',
    el('span', { class: `integrity ${integ.ok ? 'ok' : 'bad'}` }, [
      el('span', { class: 'dot' }),
      integ.ok ? 'Log verified' : `Log integrity broken @ #${integ.brokenAtSeq}`,
    ]),
  ));

  // filters
  const filters = el('div', { class: 'filters' });
  const search = el('input', { class: 'input search', placeholder: 'Search action, person, detail…', autocomplete: 'off' });
  const actorSel = el('select', {}, [el('option', { value: '', text: 'All people' })]);
  const actors = [...new Set(store.audit.map((e) => e.actor))];
  for (const a of actors) actorSel.appendChild(el('option', { value: a, text: a }));
  const catSel = el('select', {}, [
    el('option', { value: '', text: 'All actions' }),
    el('option', { value: 'deposit.create,refund.create,txn.void,coh.reconcile', text: 'Cash entries' }),
    el('option', { value: 'item.create,item.update,item.retire,item.restore,settings.beginning_balance', text: 'Item & settings' }),
    el('option', { value: 'shift.open,shift.close', text: 'Shifts' }),
    el('option', { value: 'auth.login,auth.logout,auth.pin_change,auth.pin_reset', text: 'Sign-in / PIN' }),
    el('option', { value: 'data.import,data.reset,data.csv_import,data.demo_loaded,backup.github,backup.export', text: 'Data & backup' }),
  ]);
  const dateInput = el('input', { class: 'input', type: 'date' });
  filters.append(search, actorSel, catSel, dateInput,
    el('button', { class: 'btn ghost sm', text: 'Clear', onClick: () => { search.value = ''; actorSel.value = ''; catSel.value = ''; dateInput.value = ''; paint(); } }));
  root.appendChild(filters);

  const card = el('div', { class: 'card', style: 'padding:0;overflow:hidden' });
  const wrap = el('div', { class: 'table-wrap', style: 'border:0' });
  card.appendChild(wrap);
  root.appendChild(card);

  function paint() {
    const q = search.value.toLowerCase().trim();
    const cats = catSel.value ? catSel.value.split(',') : null;
    let rows = store.audit.slice().reverse();
    rows = rows.filter((e) => {
      if (actorSel.value && e.actor !== actorSel.value) return false;
      if (cats && !cats.includes(e.action)) return false;
      if (dateInput.value && (e.ts || '').slice(0, 10) !== dateInput.value) return false;
      if (q) {
        const hay = `${e.actor} ${e.action} ${e.what} ${JSON.stringify(e.details || {})}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    clear(wrap);
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🪵' }), el('p', { text: 'No activity matches.' })]));
      return;
    }
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: '#' }), el('th', { text: 'When' }), el('th', { text: 'Who' }),
      el('th', { text: 'Action' }), el('th', { text: 'What' }),
    ])));
    const tb = el('tbody');
    for (const e of rows) {
      const [label, cls] = meta(e.action);
      tb.appendChild(el('tr', {}, [
        el('td', {}, el('span', { class: 'seq', text: '#' + e.seq })),
        el('td', { text: fmtDateTime(e.ts) }),
        el('td', {}, [
          el('strong', { text: e.actor }),
          e.role === 'manager' ? el('span', { class: 'tag role', style: 'margin-left:6px', text: 'mgr' }) : null,
        ]),
        el('td', {}, el('span', { class: `tag ${cls === 'gold' ? 'shift' : cls}`, text: label })),
        el('td', {}, detailCell(e)),
      ]));
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  }

  [search, actorSel, catSel, dateInput].forEach((c) => c.addEventListener('input', paint));
  paint();
  return root;
}

function detailCell(e) {
  const wrap = el('div', {}, [el('div', { text: e.what })]);
  const d = e.details || {};
  // show before -> after for item edits
  if (d.before && d.after) {
    const changes = [];
    for (const k of Object.keys(d.after)) {
      if (JSON.stringify(d.before[k]) !== JSON.stringify(d.after[k])) {
        changes.push(`${k}: ${fmtVal(d.before[k])} → ${fmtVal(d.after[k])}`);
      }
    }
    if (changes.length) wrap.appendChild(el('div', { class: 'muted', style: 'font-size:.76rem;margin-top:2px', text: changes.join(' · ') }));
  } else if (d.reason) {
    wrap.appendChild(el('div', { class: 'muted', style: 'font-size:.76rem;margin-top:2px', text: 'Reason: ' + d.reason }));
  }
  return wrap;
}
function fmtVal(v) { return v === true ? 'on' : v === false ? 'off' : String(v); }
