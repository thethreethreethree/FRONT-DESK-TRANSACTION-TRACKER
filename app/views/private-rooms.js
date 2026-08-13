// views/private-rooms.js — items out on a private room. No cash and no passport
// was taken, so these never appear in the cash "outstanding" list (they're ₱0) —
// they're tracked here, and closed with "Guest checked out" when the item comes
// back. Nothing on this page moves money: COH is identical before and after.
import { el, peso, pesoPlain, fmtDateTime, clear, toast } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const held = store.heldPrivateRooms();
  const value = held.reduce((s, p) => s + (p.value || 0), 0);

  root.appendChild(pageHead('Private rooms',
    `${held.length} item${held.length === 1 ? '' : 's'} out on a private room · ${peso(value)} of stock, no cash held`,
    el('button', { class: 'btn in', html: '＋&nbsp; New deposit', onClick: () => ctx.navigate('deposit') })));

  const card = el('div', { class: 'card', style: 'padding:0;overflow:hidden' });
  const filters = el('div', { class: 'filters', style: 'padding:14px 16px 0;margin-bottom:0' });
  const search = el('input', { class: 'input search', placeholder: 'Search guest, room, towel # or transaction #…', autocomplete: 'off' });
  filters.append(search);
  card.appendChild(filters);
  const wrap = el('div', { class: 'table-wrap', style: 'border:0' });
  card.appendChild(wrap);

  function paint() {
    const q = search.value.toLowerCase().trim();
    let rows = store.heldPrivateRooms();
    if (q) rows = rows.filter((p) => `${p.seq} ${p.guest || ''} ${p.room || ''} ${p.towelNo || ''}`.toLowerCase().includes(q));
    clear(wrap);
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'ic', text: '🏠' }),
        el('p', { text: q ? 'No private-room holds match.' : 'Nothing is out on a private room.' }),
      ]));
      return;
    }
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: '#' }), el('th', { text: 'Room' }), el('th', { text: 'Guest' }),
      el('th', { text: 'Item' }), el('th', { class: 'num', text: 'Value' }),
      el('th', { text: 'Out since' }), el('th', { text: 'Given by' }), el('th', { class: 'num', text: '' }),
    ])));
    const tb = el('tbody');
    for (const p of rows) {
      tb.append(el('tr', {}, [
        el('td', {}, el('span', { class: 'seq', text: '#' + p.seq })),
        el('td', {}, p.room ? el('strong', { text: p.room }) : el('span', { class: 'muted', text: '—' })),
        el('td', { text: p.guest || '—' }),
        el('td', {}, [
          el('span', { text: `${p.itemName || '—'}${p.qty > 1 ? ' ×' + p.qty : ''}` }),
          p.towelNo ? el('span', { class: 'tag towel', style: 'margin-left:6px', text: p.towelNo }) : null,
        ]),
        el('td', { class: 'num muted', text: p.value ? pesoPlain(p.value) : '—' }),
        el('td', { text: fmtDateTime(p.ts) }),
        el('td', { text: p.staff || '—' }),
        el('td', { class: 'num' }, el('button', {
          class: 'btn out sm', html: '✓&nbsp; Guest checked out',
          title: 'Item returned — close this private-room hold',
          onClick: () => confirmDialog({
            title: 'Guest checked out?',
            sub: `Closes the private-room hold for ${p.guest || 'the guest'}${p.room ? ` in room ${p.room}` : ''} and marks the ${p.itemName || 'item'}${p.towelNo ? ' #' + p.towelNo : ''} returned. No cash is involved — Cash On Hand does not change.`,
            confirmLabel: 'Checked out', kind: 'out',
            onConfirm: () => {
              const r = store.checkoutPrivateRoom(p.seq);
              toast(r ? `Checked out · ${p.itemName || 'item'}${p.towelNo ? ' #' + p.towelNo : ''} returned · COH unchanged (${peso(store.coh())})` : 'That hold is already closed', r ? 'ok' : 'warn');
              paint();
            },
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

  root.appendChild(el('div', { class: 'pill mt-lg', html: 'A private-room hold takes <strong>no cash and no passport</strong> — it only records that the item is out. Both the hand-over and the check-out are ₱0, so nothing here ever changes Cash On Hand. The towel still shows as <strong>out</strong> in the tracker until the guest is checked out.' }));
  return root;
}
