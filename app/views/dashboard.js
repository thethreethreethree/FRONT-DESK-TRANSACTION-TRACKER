// views/dashboard.js — live COH, today's flow, item breakdown, quick actions.
import { el, peso, pesoPlain, fmtTime, businessDate } from '../util.js';
import { store } from '../store.js';
import { pageHead } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const today = businessDate();
  const coh = store.coh();
  const t = store.totals();
  const todayT = store.totals((e) => e.businessDate === today);
  const outstanding = store.outstandingByGuest();
  const items = store.byItem();
  // Use the cached integrity status (computed on load and after each mutation).
  // Re-hashing the whole chain on every dashboard render would be wasteful with
  // a large ledger; appends preserve the chain, so the cached value is accurate.
  const integ = store.integrity;
  const shift = store.currentOpenShift();

  root.appendChild(pageHead(
    `Good ${greeting()}, ${store.session ? store.session.name : ''}`,
    `Front desk overview · ${new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })}`,
    el('div', { class: 'flex gap aic' }, [
      el('span', { class: `integrity ${integ.ok ? 'ok' : 'bad'}` }, [
        el('span', { class: 'dot' }),
        integ.ok ? 'Ledger verified' : `Integrity broken @ #${integ.brokenAtSeq}`,
      ]),
    ]),
  ));

  // ---- COH hero + side stats ----
  const heroRow = el('div', { class: 'grid coh-row' });

  const begin = store.beginningBalance();
  const formulaParts = [];
  if (begin) formulaParts.push(el('span', { html: `Beginning <b>₱${pesoPlain(begin)}</b>` }));
  formulaParts.push(el('span', { html: `${begin ? '+ ' : ''}Deposits <b>₱${pesoPlain(t.deposits)}</b>` }));
  formulaParts.push(el('span', { html: `− Refunds <b>₱${pesoPlain(t.refunds)}</b>` }));
  formulaParts.push(el('span', { html: `= <b>₱${pesoPlain(coh)}</b>` }));
  const hero = el('div', { class: 'coh-hero' }, [
    el('div', { class: 'label', text: 'Cash On Hand' }),
    el('div', { class: 'amount', html: `<span class="cur">₱</span>${pesoPlain(coh)}` }),
    el('div', { class: 'lockline' }, ['🔒 Auto-calculated · cannot be edited']),
    el('div', { class: 'formula' }, formulaParts),
  ]);
  heroRow.appendChild(hero);

  heroRow.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'stat' }, [
      el('span', { class: 'k', text: 'Deposits today' }),
      el('span', { class: 'v in', text: peso(todayT.deposits) }),
      el('span', { class: 'meta', text: 'cash received in' }),
    ]),
    el('hr', { class: 'hr' }),
    el('div', { class: 'stat' }, [
      el('span', { class: 'k', text: 'Refunds today' }),
      el('span', { class: 'v out', text: peso(todayT.refunds) }),
      el('span', { class: 'meta', text: 'cash paid out' }),
    ]),
  ]));

  heroRow.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'stat' }, [
      el('span', { class: 'k', text: 'Held for guests' }),
      el('span', { class: 'v', text: String(outstanding.length) }),
      el('span', { class: 'meta', text: 'guests with active deposits' }),
    ]),
    el('hr', { class: 'hr' }),
    shift
      ? el('div', {}, [
        el('span', { class: 'k', style: 'font-size:.76rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600', text: 'Current shift' }),
        el('div', { class: 'flex between aic mt' }, [
          el('span', { class: 'tag shift', text: `${shift.label} · ${shift.businessDate}` }),
          el('button', { class: 'btn sm', text: 'Close shift', onClick: () => ctx.navigate('shifts') }),
        ]),
      ])
      : el('div', { class: 'muted', text: 'No open shift — starts on first entry.' }),
  ]));

  root.appendChild(heroRow);

  // ---- quick actions ----
  const quick = el('div', { class: 'card mt-lg' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Quick actions' })]),
    el('div', { class: 'quick' }, [
      el('button', {
        class: 'btn in', onClick: () => ctx.navigate('deposit'),
      }, [el('span', { class: 'ic', text: '＋' }), el('span', { text: 'New Deposit' }), el('span', { class: 'sub', text: 'guest borrows an item' })]),
      el('button', {
        class: 'btn out', onClick: () => ctx.navigate('refund'),
      }, [el('span', { class: 'ic', text: '↩' }), el('span', { text: 'New Refund' }), el('span', { class: 'sub', text: 'guest returns / checks out' })]),
    ]),
  ]);
  root.appendChild(quick);

  // ---- item breakdown + recent activity ----
  const twoCol = el('div', { class: 'grid cols-2 mt-lg' });

  // held by item
  const itemCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Currently held by item' }), el('span', { class: 'sub', text: 'net deposits outstanding' })]),
  ]);
  if (items.length) {
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Item' }), el('th', { class: 'num', text: 'Held' }),
    ])));
    const tb = el('tbody');
    for (const it of items) {
      tb.appendChild(el('tr', {}, [
        el('td', { text: it.name }),
        el('td', { class: 'num amt-in', text: peso(it.held) }),
      ]));
    }
    tbl.appendChild(tb);
    itemCard.appendChild(el('div', { class: 'table-wrap' }, tbl));
  } else {
    itemCard.appendChild(emptyState('🧺', 'No deposits held yet.'));
  }
  twoCol.appendChild(itemCard);

  // recent activity
  const recent = store.ledger.slice(-7).reverse();
  const actCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [
      el('h3', { text: 'Recent activity' }),
      el('button', { class: 'btn ghost sm', text: 'View ledger →', onClick: () => ctx.navigate('ledger') }),
    ]),
  ]);
  if (recent.length) {
    const list = el('div');
    for (const e of recent) {
      const reversed = store.isReversed(e.id);
      list.appendChild(el('div', { class: 'flex between aic', style: 'padding:9px 2px;border-bottom:1px solid var(--line)' }, [
        el('div', {}, [
          el('div', { class: 'flex gap aic', style: 'gap:8px' }, [
            el('span', { class: `tag ${e.kind === 'deposit' ? 'dep' : e.kind === 'refund' ? 'ref' : 'rev'}`, text: e.kind }),
            el('strong', { text: e.guest || '—' }),
            e.room ? el('span', { class: 'muted', text: `Rm ${e.room}` }) : null,
          ]),
          el('div', { class: 'muted', style: 'font-size:.76rem;margin-top:2px', text: `${e.itemName} ×${e.qty ?? 1} · ${e.staff} · ${fmtTime(e.ts)}` }),
        ]),
        el('div', { class: e.direction > 0 ? 'amt-in' : 'amt-out', style: reversed ? 'text-decoration:line-through;opacity:.5' : '', text: `${e.direction > 0 ? '+' : '−'}${pesoPlain(e.amount)}` }),
      ]));
    }
    actCard.appendChild(list);
  } else {
    actCard.appendChild(emptyState('📋', 'No transactions yet. Add your first deposit.'));
  }
  twoCol.appendChild(actCard);

  root.appendChild(twoCol);
  return root;
}

function emptyState(icon, msg) {
  return el('div', { class: 'empty' }, [el('div', { class: 'ic', text: icon }), el('p', { text: msg })]);
}
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}
