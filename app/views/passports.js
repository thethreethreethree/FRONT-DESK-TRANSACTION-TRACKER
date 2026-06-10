// views/passports.js — passports held as deposits. A passport is non-cash (₱0)
// collateral tied to a MEWS reservation #, so it never shows in the cash
// "outstanding" list — it's tracked here. Return one at check-out.
import { el, peso, fmtDateTime, clear, toast } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog, openModal } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const held = store.heldPassports();
  const totalValue = held.reduce((s, p) => s + (p.value || 0), 0);
  root.appendChild(pageHead('Passports held',
    `${held.length} passport${held.length === 1 ? '' : 's'} held in lieu of cash · ${peso(totalValue)} deposit value`,
    el('button', { class: 'btn in', html: '＋&nbsp; New deposit', onClick: () => ctx.navigate('deposit') })));

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
      el('th', { text: '#' }), el('th', { text: 'Guest / Room' }), el('th', { text: 'For (item)' }),
      el('th', { class: 'num', text: 'Value' }), el('th', { text: 'MEWS res #' }),
      el('th', { text: 'Held since' }), el('th', { text: 'Taken by' }), el('th', { class: 'num', text: '' }),
    ])));
    const tb = el('tbody');
    for (const p of rows) {
      tb.append(el('tr', {}, [
        el('td', {}, el('span', { class: 'seq', text: '#' + p.seq })),
        el('td', {}, [el('strong', { text: p.guest || '—' }), p.room ? el('span', { class: 'muted', text: ' · ' + p.room }) : null]),
        el('td', {}, [el('span', { text: p.itemName || '—' }), p.towelNo ? el('span', { class: 'tag towel', style: 'margin-left:6px', text: p.towelNo }) : null]),
        el('td', { class: 'num', text: p.value ? peso(p.value) : '—' }),
        el('td', {}, p.mewsRes ? el('span', { class: 'tag mews', text: p.mewsRes }) : el('span', { class: 'muted', text: '—' })),
        el('td', { text: fmtDateTime(p.ts) }),
        el('td', { text: p.staff || '—' }),
        el('td', { class: 'num' }, el('div', { class: 'flex gap', style: 'justify-content:flex-end' }, [
          el('button', {
            class: 'btn sm', html: '💵&nbsp; To cash', title: 'Guest pays the deposit in cash; passport returned',
            onClick: () => {
              const amt = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: p.value || 0, style: 'max-width:200px' });
              openModal({
                title: 'Convert passport to cash',
                sub: `${p.guest || p.room || 'The guest'} pays the deposit in cash and gets their passport back`,
                body: el('div', {}, [
                  el('p', { class: 'muted', style: 'margin-top:0', html: `The <strong>${p.itemName || 'item'}${p.towelNo ? ' #' + p.towelNo : ''}</strong> stays out — now backed by cash instead of the passport. The passport is returned and a new cash deposit is recorded (Cash On Hand rises).` }),
                  el('div', { class: 'field' }, [el('label', { text: 'Cash deposit amount (₱)' }), amt]),
                ]),
                actions: [
                  { label: 'Cancel', kind: 'ghost' },
                  { label: 'Convert to cash', kind: 'primary', onClick: (close) => {
                    const v = parseFloat(amt.value || '');
                    if (!(v > 0)) { toast('Enter a cash amount', 'warn'); return; }
                    const r = store.convertPassportToCash(p.seq, { amount: v });
                    if (r) toast(`Converted to cash · COH now ${peso(store.coh())}`, 'ok'); else toast('Could not convert', 'err');
                    close(); paint();
                  } },
                ],
              });
            },
          }),
          el('button', {
            class: 'btn out sm', text: '↩ Return',
            onClick: () => confirmDialog({
              title: 'Return passport & item?',
              sub: `Hand back ${p.guest || p.room || 'the guest'}'s passport${p.mewsRes ? ` (MEWS ${p.mewsRes})` : ''} and close the ${p.itemName || 'item'}${p.towelNo ? ' #' + p.towelNo : ''} deposit. No cash is involved.`,
              confirmLabel: 'Return', kind: 'out',
              onConfirm: () => { store.returnPassport(p.seq); toast('Passport & item returned', 'ok'); paint(); },
            }),
          }),
        ])),
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
