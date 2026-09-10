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
    for (const raw of sorted) {
      const voided = tv.isReversed(raw.id);
      // Show what the booking CURRENTLY stands at: the original with any admin
      // correction applied. The original row is never edited — the correction is
      // a separate, visible entry — but the sheet must read as corrected.
      const e = tv.effective(raw);
      n += voided ? 0 : 1;
      const strike = voided ? 'text-decoration:line-through;opacity:.5' : '';
      tb.appendChild(el('tr', {}, [
        el('td', {}, el('span', { class: 'seq', text: voided ? '—' : String(n) })),
        el('td', { style: strike, text: fmtYMD(e.departureDate) }),
        el('td', { style: strike }, [
          el('strong', { text: e.guest || '—' }),
          e.amended ? el('span', { class: 'tag exg', style: 'margin-left:6px', text: 'corrected' }) : null,
        ]),
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
          : el('div', { class: 'flex gap', style: 'justify-content:flex-end' }, [
            el('button', { class: 'btn ghost sm', text: 'Amend', title: 'Correct this booking (admin)', onClick: () => amendBooking(raw, paint) }),
            el('button', { class: 'btn ghost sm', text: 'Void', onClick: () => voidBooking(raw, paint) }),
          ])),
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

// ADMIN: correct a booking that was entered wrongly. The original is not edited
// — a correction is appended that supersedes it — so the record keeps both what
// was first entered and the fact it was put right. Any money difference moves the
// cash box by exactly that difference.
function amendBooking(raw, done) {
  const cur = tv.effective(raw);
  const guest = el('input', { class: 'input', value: cur.guest || '', autocomplete: 'off' });
  const dest = el('select', { class: 'input' });
  for (const d of tv.activeDestinations()) dest.appendChild(el('option', { value: d.id, text: d.name }));
  if (cur.destinationId) dest.value = cur.destinationId;
  const pax = el('input', { class: 'input', type: 'number', min: '1', value: String(cur.pax ?? 1) });
  const total = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: String(cur.total) });
  const comm = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: String(cur.commission) });
  const by = el('select', { class: 'input' });
  by.appendChild(el('option', { value: '', text: '— unchanged —' }));
  for (const b of tv.bookers()) by.appendChild(el('option', { value: b.name, text: b.name }));
  if (tv.bookers().some((b) => b.name === cur.bookedBy)) by.value = cur.bookedBy;
  const remarks = el('input', { class: 'input', value: cur.remarks || '', autocomplete: 'off' });
  const reason = el('input', { class: 'input', placeholder: 'Why is this being corrected? (required)', autocomplete: 'off' });
  const delta = el('div', { class: 'hint' });
  const paintDelta = () => {
    const t = parseFloat(total.value || '0') || 0;
    const d = Math.round((t - cur.total) * 100) / 100;
    delta.innerHTML = d === 0 ? 'Total unchanged — the cash box does not move.'
      : `Cash box moves <b>${d > 0 ? '+' : '−'}₱${pesoPlain(Math.abs(d))}</b> to match.`;
  };
  total.addEventListener('input', paintDelta); paintDelta();

  openModal({
    title: `Correct booking #${raw.seq}`,
    sub: `${cur.guest || '—'} · ${cur.destination} · ₱${pesoPlain(cur.total)}`,
    wide: true,
    body: el('div', {}, [
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Guest name' }), guest]),
        el('div', { class: 'field' }, [el('label', { text: 'Destination' }), dest]),
      ]),
      el('div', { class: 'row3' }, [
        el('div', { class: 'field' }, [el('label', { text: 'No. of pax' }), pax]),
        el('div', { class: 'field' }, [el('label', { text: 'Total (₱)' }), total]),
        el('div', { class: 'field' }, [el('label', { text: 'Commission (₱)' }), comm]),
      ]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Booked by' }), by]),
        el('div', { class: 'field' }, [el('label', { text: 'Remarks' }), remarks]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Reason' }), reason]),
      delta,
      el('div', { class: 'pill-warn mt', html: 'The original booking is <strong>not erased</strong>. A correction is added that supersedes it, so the record shows both — and the sheet reads as corrected.' }),
    ]),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Save correction (admin)', kind: 'primary', onClick: (close) => {
        if (!reason.value.trim()) return toast('A reason is required', 'warn');
        if (!guest.value.trim()) return toast('Enter the guest name', 'warn');
        const t = parseFloat(total.value || '0');
        const c = parseFloat(comm.value || '0');
        if (!(t > 0)) return toast('Total must be greater than 0', 'warn');
        if (c > t) return toast('Commission cannot be more than the total', 'warn');
        managerGate(() => {
          const r = tv.amendBooking(raw.seq, {
            guest: guest.value, destinationId: dest.value, pax: pax.value,
            total: t, commission: c,
            bookedBy: by.value || cur.bookedBy, remarks: remarks.value,
          }, reason.value.trim());
          toast(r ? `Booking #${raw.seq} corrected` : 'Nothing was changed', r ? 'ok' : 'warn');
          close(); done();
        }, { reason: `Approve correcting travelista booking #${raw.seq}` });
      } },
    ],
  });
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
