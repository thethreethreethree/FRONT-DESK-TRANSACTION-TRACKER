// views/tv-bookings.js — the booking sheet, one reporting period at a time.
// Deliberately laid out in the spreadsheet's own column order and with its
// totals row, so anyone who knows the sheet can read this without relearning it.
import { el, peso, pesoPlain, toast, fmtDateTime } from '../util.js';
import { tv, periodFromKey, fmtYMD } from '../travelista.js';
import { store } from '../store.js';
import { pageHead, managerGate, openModal } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const periods = tv.periods();
  const args = ctx.args || {};
  let periodKey = args.periodKey || (periods[0] ? periods[0].key : tv.currentPeriodKey());
  let search = '';

  root.appendChild(pageHead('Booking sheet', 'Every travelista booking, by reporting period',
    el('button', { class: 'btn primary', html: '＋&nbsp; New booking', onClick: () => ctx.navigate('tv-booking') })));

  // ---- filters ----
  const periodSel = el('select', { class: 'input' });
  const known = periods.slice();
  if (!known.some((p) => p.key === periodKey)) {
    const p = periodFromKey(periodKey);
    if (p) known.unshift(p);
  }
  for (const p of known) periodSel.appendChild(el('option', { value: p.key, text: p.label }));
  periodSel.value = periodKey;
  periodSel.addEventListener('change', () => { periodKey = periodSel.value; paint(); });

  const searchI = el('input', { class: 'input search', placeholder: 'Search guest, destination, booker…', autocomplete: 'off' });
  searchI.addEventListener('input', () => { search = searchI.value.trim().toLowerCase(); paint(); });

  root.appendChild(el('div', { class: 'filters' }, [
    periodSel, searchI,
    el('button', { class: 'btn', html: '⬇&nbsp; Export CSV', onClick: () => exportCSV(periodKey) }),
  ]));

  const host = el('div');
  root.appendChild(host);

  function paint() {
    while (host.firstChild) host.removeChild(host.firstChild);
    const inP = tv.inPeriod(periodKey);
    const per = periodFromKey(periodKey);
    const rows = tv.entries.filter((e) => e.kind === 'booking' && inP(e)).filter((e) => {
      if (!search) return true;
      return `${e.guest} ${e.destination} ${e.bookedBy} ${e.remarks}`.toLowerCase().includes(search);
    });
    const t = tv.totals(inP);

    // headline strip — the same four numbers the sheet puts at the top
    host.appendChild(el('div', { class: 'grid cols-3 mt' }, [
      statCard('Total', peso(t.collected), `${t.bookings} booking${t.bookings === 1 ? '' : 's'} · ${t.pax} pax`),
      statCard('Travelista', peso(t.share), 'operator\'s share of the fares'),
      statCard('Commission', peso(t.commission), 'the hostel\'s earnings'),
    ]));

    const card = el('div', { class: 'card mt-lg' }, [
      el('div', { class: 'card-h' }, [
        el('h3', { text: per ? per.label : periodKey }),
        el('span', { class: 'sub', text: per ? `${fmtYMD(per.start)} → ${fmtYMD(per.end)}` : '' }),
      ]),
    ]);

    if (!rows.length) {
      card.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🚐' }),
        el('p', { text: search ? 'No bookings match that search.' : 'No bookings in this period yet.' })]));
      host.appendChild(card);
      return;
    }

    const tbl = el('table', { class: 'tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'NO.' }), el('th', { text: 'Departure' }), el('th', { text: 'Guest name' }),
      el('th', { text: 'Destination' }), el('th', { class: 'num', text: 'Pax' }), el('th', { class: 'num', text: 'Fare' }),
      el('th', { class: 'num', text: 'Total' }), el('th', { text: 'Booked by' }),
      el('th', { class: 'num', text: 'Travelista' }), el('th', { class: 'num', text: 'Commission' }),
      el('th', { text: 'Remarks' }), el('th', { text: '' }),
    ])));
    const tb = el('tbody');
    // Sheet order: by departure date, then by the order they were recorded.
    const sorted = rows.slice().sort((a, b) => (a.departureDate < b.departureDate ? -1 : a.departureDate > b.departureDate ? 1 : a.seq - b.seq));
    let n = 0;
    for (const e of sorted) {
      const voided = tv.isReversed(e.id);
      n += voided ? 0 : 1;
      const strike = voided ? 'text-decoration:line-through;opacity:.5' : '';
      tb.appendChild(el('tr', {}, [
        el('td', {}, el('span', { class: 'seq', text: voided ? '—' : String(n) })),
        el('td', { style: strike, text: fmtYMD(e.departureDate) }),
        el('td', { style: strike }, el('strong', { text: e.guest || '—' })),
        el('td', { style: strike, text: e.destination || '—' }),
        el('td', { class: 'num', style: strike, text: String(e.pax ?? '') }),
        el('td', { class: 'num', style: strike, text: pesoPlain(e.fare) }),
        el('td', { class: 'num', style: strike + ';font-weight:700', text: pesoPlain(e.total) }),
        el('td', { style: strike, text: e.bookedBy || '—' }),
        el('td', { class: 'num', style: strike, text: pesoPlain(e.travelistaShare) }),
        el('td', { class: 'num amt-in', style: strike, text: pesoPlain(e.commission) }),
        el('td', { style: strike, text: e.remarks || '' }),
        el('td', { class: 'right' }, voided
          ? el('span', { class: 'tag rev', text: 'void' })
          : el('button', { class: 'btn ghost sm', text: 'Void', onClick: () => voidBooking(e, paint) })),
      ]));
    }
    // the sheet's totals row
    tb.appendChild(el('tr', { style: 'background:var(--paper-2, #faf7f1);font-weight:700' }, [
      el('td', { text: '' }), el('td', { text: '' }), el('td', { text: 'TOTAL' }), el('td', { text: '' }),
      el('td', { class: 'num', text: String(t.pax) }), el('td', { text: '' }),
      el('td', { class: 'num', text: pesoPlain(t.collected) }), el('td', { text: '' }),
      el('td', { class: 'num', text: pesoPlain(t.share) }),
      el('td', { class: 'num', text: pesoPlain(t.commission) }),
      el('td', { text: '' }), el('td', { text: '' }),
    ]));
    tbl.appendChild(tb);
    card.appendChild(el('div', { class: 'table-wrap' }, tbl));
    host.appendChild(card);

    // payouts filed against the same period, so the period's cash story is complete
    const pays = tv.entries.filter((e) => e.kind === 'payout' && inP(e));
    if (pays.length) {
      const pc = el('div', { class: 'card mt-lg' }, [el('div', { class: 'card-h' }, [
        el('h3', { text: 'Payouts in this period' }),
        el('span', { class: 'sub', text: `₱${pesoPlain(t.paidOut)} paid out` })])]);
      const pt = el('table', { class: 'tbl' });
      pt.appendChild(el('thead', {}, el('tr', {}, ['When', 'Type', 'Paid to', 'Method', 'Note', 'Amount'].map((h, i) =>
        el('th', { class: i === 5 ? 'num' : '', text: h })))));
      const ptb = el('tbody');
      for (const p of pays.slice().reverse()) {
        const voided = tv.isReversed(p.id);
        const strike = voided ? 'text-decoration:line-through;opacity:.5' : '';
        ptb.appendChild(el('tr', {}, [
          el('td', { style: strike, text: fmtDateTime(p.ts) }),
          el('td', {}, el('span', { class: 'tag ref', text: p.payoutType || 'payout' })),
          el('td', { style: strike, text: p.payee || '—' }),
          el('td', { style: strike, text: p.method || '—' }),
          el('td', { style: strike, text: p.remarks || '' }),
          el('td', { class: 'num amt-out', style: strike, text: '−' + pesoPlain(p.amount) }),
        ]));
      }
      pt.appendChild(ptb);
      pc.appendChild(el('div', { class: 'table-wrap' }, pt));
      host.appendChild(pc);
    }
  }

  paint();
  return root;
}

function statCard(k, v, meta) {
  return el('div', { class: 'card' }, el('div', { class: 'stat' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', text: v }),
    el('span', { class: 'meta', text: meta }),
  ]));
}

// A booking is never edited or deleted — an admin appends its inverse, with a
// reason, and the original stays on the record struck through.
function voidBooking(e, done) {
  const reason = el('input', { class: 'input', placeholder: 'Why is this being voided? (required)', autocomplete: 'off' });
  openModal({
    title: `Void booking #${e.seq}?`,
    sub: `${e.guest || '—'} · ${e.destination} · ₱${pesoPlain(e.total)}`,
    body: el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Reason' }), reason]),
      el('div', { class: 'pill-warn', html: 'The booking stays visible and struck through, with a matching reversal appended. Cash and commission are backed out of every total.' }),
    ]),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Void (admin)', kind: 'out', onClick: (close) => {
        if (!reason.value.trim()) return toast('A reason is required', 'warn');
        managerGate(() => {
          const r = tv.reverse(e.id, reason.value.trim());
          toast(r ? `Booking #${e.seq} voided` : 'Could not void that entry', r ? 'ok' : 'err');
          close(); done();
        }, { reason: `Approve voiding travelista booking #${e.seq}` });
      } },
    ],
  });
}

function exportCSV(periodKey) {
  const csv = tv.toCSV(tv.inPeriod(periodKey));
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `travelista-${periodKey}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('CSV exported', 'ok');
}
