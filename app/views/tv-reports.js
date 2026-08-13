// views/tv-reports.js — what the sheet can't easily answer: how each period
// compares, who is booking the business, and which routes actually earn.
import { el, peso, pesoPlain } from '../util.js';
import { tv, periodFromKey, fmtYMD } from '../travelista.js';
import { pageHead } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const periods = tv.periods();

  root.appendChild(pageHead('Reports', 'Periods, bookers and routes', null));

  if (!tv.entries.length) {
    root.appendChild(el('div', { class: 'card' }, el('div', { class: 'empty' }, [
      el('div', { class: 'ic', text: '📊' }), el('p', { text: 'No bookings recorded yet.' })])));
    return root;
  }

  // ---- scope: all time, or one period ----
  let scope = 'all';
  const scopeSel = el('select', { class: 'input' });
  scopeSel.appendChild(el('option', { value: 'all', text: 'All time' }));
  for (const p of periods) scopeSel.appendChild(el('option', { value: p.key, text: p.label }));
  scopeSel.addEventListener('change', () => { scope = scopeSel.value; paint(); });
  root.appendChild(el('div', { class: 'filters' }, [scopeSel]));

  const host = el('div');
  root.appendChild(host);

  function paint() {
    while (host.firstChild) host.removeChild(host.firstChild);
    const filter = scope === 'all' ? () => true : tv.inPeriod(scope);
    const t = tv.totals(filter);

    host.appendChild(el('div', { class: 'grid cols-3 mt' }, [
      stat('Total collected', peso(t.collected), `${t.bookings} booking${t.bookings === 1 ? '' : 's'} · ${t.pax} pax`),
      stat('Travelista share', peso(t.share), `remitted ₱${pesoPlain(t.paidTravelista)}`),
      stat('Hostel commission', peso(t.commission), t.collected ? `${((t.commission / t.collected) * 100).toFixed(1)}% of takings` : ''),
    ]));

    // ---- period-by-period ----
    if (scope === 'all' && periods.length) {
      const card = el('div', { class: 'card mt-lg' }, [el('div', { class: 'card-h' }, [
        el('h3', { text: 'By period' }), el('span', { class: 'sub', text: tv.config.periodMode === 'month' ? 'monthly' : 'half-month (1–15 / 16–end)' })])]);
      const tbl = el('table', { class: 'tbl' });
      tbl.appendChild(el('thead', {}, el('tr', {}, ['Period', 'Dates', 'Bookings', 'Pax', 'Total', 'Travelista', 'Commission', 'Paid out'].map((h, i) =>
        el('th', { class: i >= 2 ? 'num' : '', text: h })))));
      const tb = el('tbody');
      for (const p of periods) {
        const pt = tv.totals(tv.inPeriod(p.key));
        tb.appendChild(el('tr', {}, [
          el('td', {}, el('button', { class: 'btn ghost sm', text: p.label, onClick: () => ctx.navigate('tv-bookings', { periodKey: p.key }) })),
          el('td', { class: 'muted', text: `${fmtYMD(p.start)} → ${fmtYMD(p.end)}` }),
          el('td', { class: 'num', text: String(pt.bookings) }),
          el('td', { class: 'num', text: String(pt.pax) }),
          el('td', { class: 'num', style: 'font-weight:700', text: pesoPlain(pt.collected) }),
          el('td', { class: 'num', text: pesoPlain(pt.share) }),
          el('td', { class: 'num amt-in', text: pesoPlain(pt.commission) }),
          el('td', { class: 'num amt-out', text: pt.paidOut ? '−' + pesoPlain(pt.paidOut) : '—' }),
        ]));
      }
      tbl.appendChild(tb);
      card.appendChild(el('div', { class: 'table-wrap' }, tbl));
      host.appendChild(card);
    }

    const two = el('div', { class: 'grid cols-2 mt-lg' });
    two.appendChild(breakdown('By booker', 'who brought the business in', tv.byBooker(filter), t.collected));
    two.appendChild(breakdown('By destination', 'which routes earn', tv.byDestination(filter), t.collected));
    host.appendChild(two);
  }

  paint();
  return root;
}

function breakdown(title, sub, rows, grand) {
  const card = el('div', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h3', { text: title }), el('span', { class: 'sub', text: sub })])]);
  if (!rows.length) {
    card.appendChild(el('div', { class: 'empty' }, el('p', { text: 'Nothing here yet.' })));
    return card;
  }
  const tbl = el('table', { class: 'tbl' });
  tbl.appendChild(el('thead', {}, el('tr', {}, ['', 'Bookings', 'Pax', 'Total', 'Commission', 'Share'].map((h, i) =>
    el('th', { class: i >= 1 ? 'num' : '', text: h })))));
  const tb = el('tbody');
  for (const r of rows) {
    tb.appendChild(el('tr', {}, [
      el('td', {}, el('strong', { text: r.name })),
      el('td', { class: 'num', text: String(r.bookings) }),
      el('td', { class: 'num', text: String(r.pax) }),
      el('td', { class: 'num', style: 'font-weight:700', text: pesoPlain(r.total) }),
      el('td', { class: 'num amt-in', text: pesoPlain(r.commission) }),
      el('td', { class: 'num muted', text: grand ? `${((r.total / grand) * 100).toFixed(0)}%` : '—' }),
    ]));
  }
  tbl.appendChild(tb);
  card.appendChild(el('div', { class: 'table-wrap' }, tbl));
  return card;
}

function stat(k, v, meta) {
  return el('div', { class: 'card' }, el('div', { class: 'stat' }, [
    el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }), el('span', { class: 'meta', text: meta }),
  ]));
}
