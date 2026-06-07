// views/passports.js — passports held as deposits. A passport is non-cash (₱0)
// collateral tied to a MEWS reservation #, so it never shows in the cash
// "outstanding" list — it's tracked here. Return one at check-out.
import { el, fmtDateTime, clear, toast } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const held = store.heldPassports();
  root.appendChild(pageHead('Passports held',
    `${held.length} passport${held.length === 1 ? '' : 's'} currently held · no cash value`,
    el('button', { class: 'btn in', html: '＋&nbsp; New passport deposit', onClick: () => ctx.navigate('deposit') })));

  const card = el('div', { class: 'card', style: 'padding:0;overflow:hidden' });
  const filters = el('div', { class: 'filters', style: 'padding:14px 16px 0;margin-bottom:0' });
  const search = el('input', { class: 'input search', placeholder: 'Search guest, room, MEWS # or transaction #…', autocomplete: 'off' });
  filters.append(search);
  card.appendChild(filters);
  const wrap = el('div', { class: 'table-wrap', style: 'border:0' });
  card.appendChild(wrap);

  function paint() {
    const q = search.value.toLowerCase().trim();
    let rows = store.heldPassports();
    if (q) rows = rows.filter((p) => `${p.seq} ${p.guest || ''} ${p.room || ''} ${p.mewsRes || ''}`.toLowerCase().includes(q));
    clear(wrap);
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🛂' }), el('p', { text: q ? 'No passports match.' : 'No passports currently held.' })]));
      return;
    }
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: '#' }), el('th', { text: 'Guest / Room' }), el('th', { text: 'MEWS res #' }),
      el('th', { text: 'Held since' }), el('th', { text: 'Taken by' }), el('th', { class: 'num', text: '' }),
    ])));
    const tb = el('tbody');
    for (const p of rows) {
      tb.append(el('tr', {}, [
        el('td', {}, el('span', { class: 'seq', text: '#' + p.seq })),
        el('td', {}, [el('strong', { text: p.guest || '—' }), p.room ? el('span', { class: 'muted', text: ' · ' + p.room }) : null]),
        el('td', {}, p.mewsRes ? el('span', { class: 'tag mews', text: p.mewsRes }) : el('span', { class: 'muted', text: '—' })),
        el('td', { text: fmtDateTime(p.ts) }),
        el('td', { text: p.staff || '—' }),
        el('td', { class: 'num' }, el('button', {
          class: 'btn out sm', text: '↩ Return',
          onClick: () => confirmDialog({
            title: 'Return this passport?',
            sub: `Hand back ${p.guest || p.room || 'the guest'}'s passport${p.mewsRes ? ` (MEWS ${p.mewsRes})` : ''}. It will be removed from the held list. No cash is involved.`,
            confirmLabel: 'Return passport', kind: 'out',
            onConfirm: () => { store.returnPassport(p.seq); toast('Passport returned', 'ok'); paint(); },
          }),
        })),
      ]));
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  }
  search.addEventListener('input', paint);
  paint();
  root.appendChild(card);
  return root;
}
