// views/outstanding.js — who still holds a deposit (the COH liability), itemised,
// plus a reconciliation that always ties back to COH and flags mismatches.
import { el, peso, pesoPlain, clear } from '../util.js';
import { store } from '../store.js';
import { pageHead } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const data = store.outstandingByGuest();
  const over = store.overReturnedByGuest();
  const rec = store.reconciliation();

  root.appendChild(pageHead(
    'Outstanding deposits',
    `${rec.positives} guests currently hold deposits`,
    el('span', { class: `integrity ${rec.held - rec.over === rec.coh ? 'ok' : 'bad'}` }, [el('span', { class: 'dot' }), `Reconciles to COH ${peso(store.coh())}`]),
  ));

  // reconciliation strip
  root.appendChild(el('div', { class: 'card', style: 'margin-bottom:18px' }, [
    el('div', { class: 'flex between aic wrap gap' }, [
      reconCell('Held by guests', peso(rec.held), 'var(--in-700)'),
      el('div', { class: 'muted', style: 'font-size:1.4rem', text: '−' }),
      reconCell('Needs attention', peso(rec.over), 'var(--out-700)', `${rec.negatives} over-returned`),
      el('div', { class: 'muted', style: 'font-size:1.4rem', text: '=' }),
      reconCell('Cash On Hand', peso(rec.coh), 'var(--ink)', 'locked & derived'),
    ]),
  ]));

  // needs attention (over-returned / unmatched)
  if (over.length) {
    const att = el('div', { class: 'card', style: 'margin-bottom:18px;border-color:var(--out)' }, [
      el('div', { class: 'card-h' }, [
        el('h3', { html: '⚠️ Needs attention', style: 'color:var(--out-700)' }),
        el('span', { class: 'sub', text: 'refunded more than deposited — likely a name/room mismatch or a pre-system deposit' }),
      ]),
    ]);
    const list = el('div', { class: 'grid cols-2' });
    for (const g of over) {
      list.appendChild(el('div', { class: 'guest-card', style: 'border-color:var(--out)' }, [
        el('div', {}, [
          el('div', { class: 'g-name', text: g.guest || '(no name)' }),
          el('div', { class: 'g-room', text: g.room ? `Room ${g.room}` : '—' }),
          el('div', { class: 'g-items', text: Object.entries(g.items).filter(([, v]) => Math.abs(v) > 0.005).map(([k, v]) => `${k}: ₱${pesoPlain(v)}`).join('  ·  ') }),
        ]),
        el('div', { class: 'g-held', style: 'color:var(--out-700)', text: peso(g.held) }),
      ]));
    }
    att.appendChild(list);
    root.appendChild(att);
  }

  // search + positives grid
  const search = el('input', { class: 'input', placeholder: 'Search guest or room…', style: 'max-width:320px;margin-bottom:16px', autocomplete: 'off' });
  root.appendChild(search);
  const grid = el('div', { class: 'grid cols-2' });
  root.appendChild(grid);

  function paint() {
    clear(grid);
    const q = search.value.toLowerCase().trim();
    const filtered = data.filter((g) => !q || g.guest.toLowerCase().includes(q) || g.room.toLowerCase().includes(q));
    if (!filtered.length) {
      grid.appendChild(el('div', { class: 'card' }, el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '✓' }), el('p', { text: 'No outstanding deposits — everything is balanced.' })])));
      return;
    }
    for (const g of filtered) {
      const items = Object.entries(g.items).filter(([, v]) => Math.abs(v) > 0.005);
      grid.appendChild(el('div', { class: 'guest-card' }, [
        el('div', {}, [
          el('div', { class: 'g-name', text: g.guest || '(no name)' }),
          el('div', { class: 'g-room', text: g.room ? `Room ${g.room}` : '—' }),
          el('div', { class: 'g-items', text: items.map(([k, v]) => `${k}: ₱${pesoPlain(v)}`).join('  ·  ') }),
        ]),
        el('div', { class: 'right' }, [
          el('div', { class: 'g-held', text: peso(g.held) }),
          el('button', { class: 'btn out sm mt', text: 'Refund →', onClick: () => ctx.navigate('refund') }),
        ]),
      ]));
    }
  }
  search.addEventListener('input', paint);
  paint();
  return root;
}

function reconCell(label, value, color, sub) {
  return el('div', { class: 'stat', style: 'min-width:150px' }, [
    el('span', { class: 'k', text: label }),
    el('span', { class: 'v', style: `color:${color};font-size:1.5rem`, text: value }),
    sub ? el('span', { class: 'meta', text: sub }) : null,
  ]);
}
