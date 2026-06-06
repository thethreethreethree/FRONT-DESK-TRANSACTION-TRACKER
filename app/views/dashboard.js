// views/dashboard.js — live COH, today's flow, item breakdown, quick actions.
import { el, peso, pesoPlain, fmtTime, fmtDateTime, businessDate, entryTowelNo } from '../util.js';
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
  if (t.adjustments) formulaParts.push(el('span', { html: `${t.adjustments >= 0 ? '+' : '−'} Adjustment <b>₱${pesoPlain(Math.abs(t.adjustments))}</b>` }));
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

  // ---- towel tracker ----
  root.appendChild(towelCard(ctx));

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
          el('div', { class: 'muted', style: 'font-size:.76rem;margin-top:2px', text: `${e.itemName} ×${e.qty ?? 1}${entryTowelNo(e) ? ` · towel ${entryTowelNo(e)}` : ''} · ${e.staff} · ${fmtTime(e.ts)}` }),
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

// Towel tracker summary for the dashboard: headline counts + who currently has a
// towel out (guest/room/time/staff). Prompts setup when the tracker is off.
function towelCard(ctx) {
  const card = el('div', { class: 'card mt-lg' }, [
    el('div', { class: 'card-h' }, [
      el('h3', { text: '🧺 Towel tracker' }),
      el('button', { class: 'btn ghost sm', text: 'Open tracker →', onClick: () => ctx.navigate('towels') }),
    ]),
  ]);
  if (!store.towelTracker.enabled) {
    card.appendChild(el('div', { class: 'flex between aic wrap gap' }, [
      el('p', { class: 'muted', style: 'margin:0', text: 'Track each physical towel — available, out with a guest, or lost. Set up your inventory to begin.' }),
      el('button', { class: 'btn primary', text: 'Set up towel tracker', onClick: () => ctx.navigate('towels') }),
    ]));
    return card;
  }

  const s = store.towelSummary();
  const chip = (k, v, color) => el('div', { class: 'stat', style: 'min-width:96px' }, [
    el('span', { class: 'k', text: k }), el('span', { class: 'v', style: `color:${color};font-size:1.5rem`, text: String(v) }),
  ]);
  card.appendChild(el('div', { class: 'flex gap wrap', style: 'margin-bottom:6px' }, [
    chip('Available', s.available, 'var(--in-700)'),
    chip('Out', s.out, 'var(--gold-700)'),
    chip('Lost', s.lost, 'var(--out-700)'),
    chip('In service', s.inService, 'var(--ink)'),
  ]));

  const outRows = store.towelStatus().filter((t) => t.status === 'out').slice(0, 6);
  if (outRows.length) {
    const list = el('div', { class: 'mt' });
    for (const t of outRows) {
      const h = t.holder || {};
      list.appendChild(el('div', { class: 'flex between aic', style: 'padding:8px 2px;border-bottom:1px solid var(--line)' }, [
        el('div', { class: 'flex gap aic', style: 'gap:8px' }, [
          el('span', { class: 'tag towel', text: t.no }),
          el('strong', { text: h.guest || '—' }),
          h.room ? el('span', { class: 'muted', text: `Rm ${h.room}` }) : null,
        ]),
        el('div', { class: 'muted', style: 'font-size:.76rem', text: `${h.staff || '—'} · ${fmtDateTime(h.ts)}` }),
      ]));
    }
    card.appendChild(list);
    if (s.out > outRows.length) card.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;margin-top:8px', text: `+${s.out - outRows.length} more out · open the tracker for the full list.` }));
  } else {
    card.appendChild(el('p', { class: 'muted', style: 'margin:8px 0 0', text: 'No towels currently out.' }));
  }
  if (s.lost) card.appendChild(el('div', { class: 'pill-warn mt', html: `<strong>${s.lost}</strong> lost towel${s.lost === 1 ? '' : 's'} need admin review (Found / Write-off).` }));
  return card;
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
