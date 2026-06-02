// views/ledger.js — the immutable transaction record. Searchable/filterable.
// No edit/delete. Managers may VOID (which appends a reversal).
import { el, peso, pesoPlain, fmtDateTime, clear, toast, escapeHtml } from '../util.js';
import { store } from '../store.js';
import { pageHead, managerGate, openModal } from '../components.js';

export function render(ctx) {
  const root = el('div');
  root.appendChild(pageHead('Ledger', 'Every transaction, permanently recorded · COH = ' + peso(store.coh()), null));

  const filters = el('div', { class: 'filters' });
  const search = el('input', { class: 'input search', placeholder: 'Search guest, room, note, staff…', autocomplete: 'off' });
  const typeSel = el('select', {}, [
    el('option', { value: '', text: 'All types' }),
    el('option', { value: 'deposit', text: 'Deposits' }),
    el('option', { value: 'refund', text: 'Refunds' }),
    el('option', { value: 'reversal', text: 'Voids' }),
  ]);
  const shiftSel = el('select', {}, [
    el('option', { value: '', text: 'All shifts' }),
    el('option', { value: 'AM', text: 'AM' }), el('option', { value: 'PM', text: 'PM' }), el('option', { value: 'GY', text: 'GY' }),
  ]);
  const dateInput = el('input', { class: 'input', type: 'date' });
  filters.append(search, typeSel, shiftSel, dateInput,
    el('button', { class: 'btn ghost sm', text: 'Clear', onClick: () => { search.value = ''; typeSel.value = ''; shiftSel.value = ''; dateInput.value = ''; paint(); } }));
  root.appendChild(filters);

  const card = el('div', { class: 'card', style: 'padding:0;overflow:hidden' });
  const wrap = el('div', { class: 'table-wrap', style: 'border:0' });
  card.appendChild(wrap);
  root.appendChild(card);

  const RENDER_CAP = 500; // keep the DOM light; filters narrow the rest

  function paint() {
    // Which entries have been voided — O(1) lookups instead of O(n) per row.
    const reversedIds = new Set();
    for (const e of store.ledger) if (e.reversesId) reversedIds.add(e.reversesId);
    const q = search.value.toLowerCase().trim();
    let rows = store.ledger.slice().reverse();
    rows = rows.filter((e) => {
      if (typeSel.value && e.kind !== typeSel.value) return false;
      if (shiftSel.value && e.shiftLabel !== shiftSel.value) return false;
      if (dateInput.value && e.businessDate !== dateInput.value) return false;
      if (q) {
        const hay = `${e.guest} ${e.room} ${e.note} ${e.staff} ${e.itemName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    clear(wrap);
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🔍' }), el('p', { text: 'No matching transactions.' })]));
      return;
    }
    const total = rows.length;
    const shown = rows.slice(0, RENDER_CAP);
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: '#' }), el('th', { text: 'When' }), el('th', { text: 'Type' }),
      el('th', { text: 'Item' }), el('th', { text: 'Guest / Room' }), el('th', { text: 'Staff' }),
      el('th', { class: 'num', text: 'Amount' }), el('th', { class: 'num', text: '' }),
    ])));
    const tb = el('tbody');
    for (const e of shown) {
      const reversed = reversedIds.has(e.id);
      const tr = el('tr', { class: (reversed ? 'voided ' : '') + (e.kind === 'reversal' ? 'is-reversal' : '') });
      tr.append(
        el('td', {}, el('span', { class: 'seq', text: '#' + e.seq })),
        el('td', { text: fmtDateTime(e.ts) }),
        el('td', {}, el('span', { class: `tag ${e.kind === 'deposit' ? 'dep' : e.kind === 'refund' ? 'ref' : e.kind === 'adjustment' ? 'shift' : 'rev'}`, text: e.kind })),
        el('td', { text: `${e.itemName || '—'}${e.qty ? ' ×' + e.qty : ''}` }),
        el('td', {}, [el('strong', { text: e.guest || '—' }), e.room ? el('span', { class: 'muted', text: ' · ' + e.room }) : null]),
        el('td', {}, [el('span', { text: e.staff }), e.staffRole === 'manager' ? el('span', { class: 'tag role', style: 'margin-left:6px', text: 'mgr' }) : null]),
        el('td', { class: 'num ' + (e.direction > 0 ? 'amt-in' : 'amt-out'), text: `${e.direction > 0 ? '+' : '−'}${pesoPlain(e.amount)}` }),
        el('td', { class: 'num' }, actionCell(e, reversed, paint)),
      );
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
    if (total > shown.length) {
      wrap.appendChild(el('div', { class: 'muted', style: 'padding:12px 16px;text-align:center;font-size:.82rem;border-top:1px solid var(--line)',
        text: `Showing the latest ${shown.length.toLocaleString()} of ${total.toLocaleString()} matching transactions. Use search or the date filter to narrow down.` }));
    }
  }

  [search, typeSel, shiftSel, dateInput].forEach((c) => c.addEventListener('input', paint));
  paint();
  return root;
}

function actionCell(e, reversed, paint) {
  if (e.kind === 'reversal') return el('span', { class: 'muted', style: 'font-size:.74rem', text: 'void' });
  if (reversed) return el('span', { class: 'muted', style: 'font-size:.74rem', text: 'voided' });
  return el('button', {
    class: 'btn ghost sm', text: 'Void',
    onClick: () => openVoid(e, paint),
  });
}

function openVoid(e, paint) {
  const reason = el('textarea', { class: 'input', rows: '3', placeholder: 'Why is this being voided? (required)' });
  const body = el('div', {}, [
    el('div', { class: 'pill-warn', html: `This will not delete <strong>#${e.seq}</strong>. It appends a <strong>reversal</strong> that cancels its effect on COH. Both stay in the record forever.` }),
    el('div', { class: 'field mt' }, [el('label', { text: `Voiding: ${escapeHtml(e.kind)} · ${escapeHtml(e.itemName)} · ${escapeHtml(e.guest || e.room || '')} · ${peso(e.amount)}` }), reason]),
  ]);
  openModal({
    title: 'Void transaction',
    sub: 'Manager approval required.',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Void (manager)', kind: 'out',
        onClick: (close) => {
          if (!reason.value.trim()) { toast('A reason is required', 'warn'); return; }
          managerGate(() => {
            const r = store.reverse(e.id, reason.value.trim());
            if (r) { toast(`Voided #${e.seq} · COH now ${peso(store.coh())}`, 'ok'); close(); paint(); }
            else toast('Could not void (already voided?)', 'err');
          }, { reason: 'Approve voiding transaction #' + e.seq });
        },
      },
    ],
  });
}
