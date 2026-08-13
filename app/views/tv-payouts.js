// views/tv-payouts.js — money leaving the travelista cash box.
//
// Two different withdrawals, deliberately distinguished:
//   • travelista — remitting the operator their share. Reduces what we OWE.
//   • commission — the hostel taking out its own earned commission.
// Both reduce cash on hand; only the first settles a debt. Keeping them apart is
// what lets "owed to travelista" stay a true figure instead of a guess.
import { el, peso, pesoPlain, toast, fmtDateTime } from '../util.js';
import { tv, periodFromKey } from '../travelista.js';
import { store } from '../store.js';
import { pageHead, managerGate, openModal } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const rec = tv.reconciliation();

  root.appendChild(pageHead('Remit & payouts', 'Pay the travelista their share, or draw out the hostel commission', null));

  root.appendChild(el('div', { class: 'grid cols-3' }, [
    stat('In the cash box', peso(rec.cash), 'collected − paid out'),
    stat('Owed to travelista', peso(rec.payable), 'their share, not yet remitted'),
    stat('Commission held', peso(rec.commissionHeld), 'hostel earnings still in the box'),
  ]));

  // ---- the payout form ----
  const card = el('div', { class: 'card elev mt-lg', style: 'max-width:680px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Record a payout' })]),
  ]);

  let type = 'travelista';
  const typeToggle = el('div', { class: 'role-toggle' }, [
    el('button', { type: 'button', class: 'active', html: '🚐&nbsp; To travelista', onClick: (ev) => setType('travelista', ev) }),
    el('button', { type: 'button', html: '🏨&nbsp; Hostel commission', onClick: (ev) => setType('commission', ev) }),
    el('button', { type: 'button', html: '⋯&nbsp; Other', onClick: (ev) => setType('other', ev) }),
  ]);
  function setType(t, ev) {
    type = t;
    typeToggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    ev.currentTarget.classList.add('active');
    sync();
  }

  const amountI = el('input', { class: 'input big', type: 'number', min: '0', step: '0.01', placeholder: '0.00' });
  const payeeI = el('input', { class: 'input', placeholder: 'who received it', autocomplete: 'off' });
  const methodI = el('input', { class: 'input', placeholder: 'cash / GCash / bank', autocomplete: 'off' });
  const noteI = el('input', { class: 'input', placeholder: 'optional', autocomplete: 'off' });

  const periodSel = el('select', { class: 'input' });
  const periods = tv.periods();
  const curKey = tv.currentPeriodKey();
  if (!periods.some((p) => p.key === curKey)) {
    const p = periodFromKey(curKey);
    if (p) periods.unshift(p);
  }
  for (const p of periods) periodSel.appendChild(el('option', { value: p.key, text: p.label }));
  periodSel.value = curKey;

  const guide = el('div', { class: 'hint' });
  const warn = el('div', { class: 'pill-warn', style: 'display:none' });
  function outstandingFor(t) {
    return t === 'travelista' ? rec.payable : t === 'commission' ? rec.commissionHeld : rec.cash;
  }
  function sync() {
    const cap = outstandingFor(type);
    guide.innerHTML = type === 'travelista'
      ? `Owed to the travelista right now: <strong>₱${pesoPlain(rec.payable)}</strong>`
      : type === 'commission'
        ? `Commission sitting in the box: <strong>₱${pesoPlain(rec.commissionHeld)}</strong>`
        : `Cash in the box: <strong>₱${pesoPlain(rec.cash)}</strong>`;
    const v = parseFloat(amountI.value || '0') || 0;
    const over = v > cap + 0.005;
    warn.style.display = over ? '' : 'none';
    if (over) {
      warn.innerHTML = `<strong>More than the balance.</strong> This pays out ₱${pesoPlain(v)} against ₱${pesoPlain(cap)} available — allowed, but it will show as a negative balance until it's explained.`;
    }
    payeeI.placeholder = type === 'travelista' ? 'travelista / operator name' : type === 'commission' ? 'hostel' : 'who received it';
  }
  amountI.addEventListener('input', sync);

  const fillBtn = el('button', { class: 'btn sm', text: 'Pay the full balance', onClick: () => {
    amountI.value = String(outstandingFor(type)); sync();
  } });

  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Payout type' }), typeToggle, guide]));
  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Amount (₱)' }), amountI,
    el('div', { class: 'flex gap mt' }, [fillBtn])]));
  card.appendChild(el('div', { class: 'row3' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Paid to' }), payeeI]),
    el('div', { class: 'field' }, [el('label', { text: 'Method' }), methodI]),
    el('div', { class: 'field' }, [el('label', { text: 'Against period' }), periodSel]),
  ]));
  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Note' }), noteI]));
  card.appendChild(warn);
  card.appendChild(el('button', { class: 'btn out lg block mt-lg', html: '↗&nbsp; Record payout', onClick: () => {
    const v = parseFloat(amountI.value || '0');
    if (!(v > 0)) return toast('Enter an amount', 'warn');
    if (!payeeI.value.trim()) return toast('Enter who received it', 'warn');
    // Cash leaving the box is admin-approved, same as a front-desk void.
    managerGate(() => {
      const e = tv.addPayout({ amount: v, payoutType: type, payee: payeeI.value, method: methodI.value, note: noteI.value, periodKey: periodSel.value });
      toast(e ? `Payout #${e.seq} recorded · cash box now ${peso(tv.cash())}` : 'Could not record that payout', e ? 'ok' : 'err');
      ctx.navigate('tv-payouts');
    }, { reason: `Approve paying out ${peso(v)} from the travelista cash box` });
  } }));
  root.appendChild(card);

  // ---- history ----
  const pays = tv.entries.filter((e) => e.kind === 'payout').reverse();
  const hist = el('div', { class: 'card mt-lg' }, [el('div', { class: 'card-h' }, [el('h3', { text: 'Payout history' })])]);
  if (pays.length) {
    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, ['#', 'When', 'Type', 'Paid to', 'Method', 'Period', 'By', 'Amount', ''].map((h, i) =>
      el('th', { class: i === 7 ? 'num' : '', text: h })))));
    const tb = el('tbody');
    for (const p of pays) {
      const voided = tv.isReversed(p.id);
      const strike = voided ? 'text-decoration:line-through;opacity:.5' : '';
      const per = periodFromKey(p.periodKey);
      tb.appendChild(el('tr', {}, [
        el('td', {}, el('span', { class: 'seq', text: String(p.seq) })),
        el('td', { style: strike, text: fmtDateTime(p.ts) }),
        el('td', {}, el('span', { class: 'tag ref', text: p.payoutType || 'payout' })),
        el('td', { style: strike, text: p.payee || '—' }),
        el('td', { style: strike, text: p.method || '—' }),
        el('td', { style: strike, text: per ? per.label : (p.periodKey || '—') }),
        el('td', { style: strike, text: p.staff }),
        el('td', { class: 'num amt-out', style: strike, text: '−' + pesoPlain(p.amount) }),
        el('td', { class: 'right' }, voided
          ? el('span', { class: 'tag rev', text: 'void' })
          : el('button', { class: 'btn ghost sm', text: 'Void', onClick: () => voidPayout(p, () => ctx.navigate('tv-payouts')) })),
      ]));
    }
    tbl.appendChild(tb);
    hist.appendChild(el('div', { class: 'table-wrap' }, tbl));
  } else {
    hist.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '↗' }), el('p', { text: 'Nothing paid out yet — everything collected is still in the box.' })]));
  }
  root.appendChild(hist);

  sync();
  return root;
}

function stat(k, v, meta) {
  return el('div', { class: 'card' }, el('div', { class: 'stat' }, [
    el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }), el('span', { class: 'meta', text: meta }),
  ]));
}

function voidPayout(p, done) {
  const reason = el('input', { class: 'input', placeholder: 'Why is this being voided? (required)', autocomplete: 'off' });
  openModal({
    title: `Void payout #${p.seq}?`,
    sub: `${p.payoutType} · ${p.payee || '—'} · ₱${pesoPlain(p.amount)}`,
    body: el('div', { class: 'field' }, [el('label', { text: 'Reason' }), reason]),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Void (admin)', kind: 'out', onClick: (close) => {
        if (!reason.value.trim()) return toast('A reason is required', 'warn');
        managerGate(() => {
          const r = tv.reverse(p.id, reason.value.trim());
          toast(r ? `Payout #${p.seq} voided` : 'Could not void that payout', r ? 'ok' : 'err');
          close(); done();
        }, { reason: `Approve voiding travelista payout #${p.seq}` });
      } },
    ],
  });
}
