// views/tv-settings.js — Travelista setup (admin): the rate table, the booker
// roster, the opening cash float, the reporting period, and sheet import/export.
import { el, peso, pesoPlain, toast } from '../util.js';
import { tv, STARTER_SHEET, importRows, parseTravelistaCSV, fmtYMD } from '../travelista.js';
import { store } from '../store.js';
import { pageHead, confirmDialog, managerGate, openModal } from '../components.js';

export function render(ctx) {
  tv.ensureSeed();
  const root = el('div');
  root.appendChild(pageHead('Travelista settings', 'Rates, bookers, cash box & sheet data. Admin only.', null));

  root.appendChild(ratesCard(ctx));
  root.appendChild(bookersCard(ctx));
  root.appendChild(cashCard(ctx));
  root.appendChild(dataCard(ctx));
  return root;
}

// ---------------------------------------------------------------- rate table
// Fares and commission per destination. This is what makes the booking form a
// two-tap job instead of four typed numbers — and what stops arithmetic slips.
function ratesCard(ctx) {
  const card = el('div', { class: 'card', style: 'max-width:860px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Destinations & rates' }), el('span', { class: 'sub', text: 'fare and commission per route' })]),
    el('p', { class: 'muted', style: 'margin-top:0', html: '<strong>Per pax</strong> multiplies by the number of passengers; <strong>flat</strong> charges once for the whole vehicle (a private van costs the same for 5 or 8 people). The travelista\'s share is always <strong>total − commission</strong>.' }),
  ]);

  const tbl = el('table', { class: 'tbl' });
  tbl.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Destination' }), el('th', { class: 'num', text: 'Fare ₱' }), el('th', { text: 'Fare basis' }),
    el('th', { class: 'num', text: 'Commission ₱' }), el('th', { text: 'Commission basis' }),
    el('th', { text: 'Status' }), el('th', { text: '' }),
  ])));
  const tb = el('tbody');
  for (const d of tv.destinations()) {
    const fare = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: d.fare, style: 'width:110px;padding:7px 10px' });
    fare.addEventListener('change', () => { tv.updateDestination(d.id, { fare: parseFloat(fare.value || '0') }); toast(`${d.name} fare updated`, 'ok'); });
    const comm = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: d.commission, style: 'width:110px;padding:7px 10px' });
    comm.addEventListener('change', () => { tv.updateDestination(d.id, { commission: parseFloat(comm.value || '0') }); toast(`${d.name} commission updated`, 'ok'); });
    const fb = basisSelect(d.fareBasis, (v) => { tv.updateDestination(d.id, { fareBasis: v }); toast(`${d.name} fare basis updated`, 'ok'); });
    const cb = basisSelect(d.commissionBasis, (v) => { tv.updateDestination(d.id, { commissionBasis: v }); toast(`${d.name} commission basis updated`, 'ok'); });
    tb.appendChild(el('tr', {}, [
      el('td', {}, el('strong', { text: d.name })),
      el('td', { class: 'num' }, fare),
      el('td', {}, fb),
      el('td', { class: 'num' }, comm),
      el('td', {}, cb),
      el('td', {}, el('span', { class: d.active ? 'tag dep' : 'tag rev', text: d.active ? 'active' : 'retired' })),
      el('td', { class: 'right' }, el('button', { class: 'btn ghost sm', text: d.active ? 'Retire' : 'Restore',
        onClick: () => { tv.updateDestination(d.id, { active: !d.active }); ctx.navigate('tv-settings'); } })),
    ]));
  }
  tbl.appendChild(tb);
  card.appendChild(el('div', { class: 'table-wrap' }, tbl));

  const nName = el('input', { class: 'input', placeholder: 'e.g. CORON' });
  const nFare = el('input', { class: 'input', type: 'number', min: '0', step: '50', placeholder: 'Fare ₱', style: 'max-width:130px' });
  const nComm = el('input', { class: 'input', type: 'number', min: '0', step: '50', placeholder: 'Commission ₱', style: 'max-width:150px' });
  let nBasis = 'per_pax';
  const nBasisSel = basisSelect('per_pax', (v) => { nBasis = v; });
  card.appendChild(el('div', { class: 'flex gap mt wrap', style: 'align-items:flex-end' }, [
    el('div', { class: 'field', style: 'flex:1;min-width:160px;margin:0' }, [el('label', { text: 'Add destination' }), nName]),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Fare' }), nFare]),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Basis' }), nBasisSel]),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Commission' }), nComm]),
    el('button', { class: 'btn primary', text: 'Add', onClick: () => {
      if (!nName.value.trim()) return toast('Enter a destination name', 'warn');
      tv.addDestination({ name: nName.value, fare: parseFloat(nFare.value || '0'), fareBasis: nBasis,
        commission: parseFloat(nComm.value || '0'), commissionBasis: nBasis });
      toast('Destination added', 'ok'); ctx.navigate('tv-settings');
    } }),
  ]));
  return card;
}

function basisSelect(value, onChange) {
  const s = el('select', { class: 'input', style: 'width:130px;padding:7px 10px' }, [
    el('option', { value: 'per_pax', text: 'per pax' }),
    el('option', { value: 'flat', text: 'flat' }),
  ]);
  s.value = value === 'flat' ? 'flat' : 'per_pax';
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

// ------------------------------------------------------------------ bookers
function bookersCard(ctx) {
  const card = el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Bookers' }), el('span', { class: 'sub', text: 'the "Booked By" list' })]),
    el('p', { class: 'muted', style: 'margin-top:0', text: 'Who can be credited with a booking. Removing someone keeps their past bookings on the record — it only takes them out of the dropdown.' }),
  ]);
  const roster = tv.bookers();
  if (roster.length) {
    const wrap = el('div', { class: 'flex gap wrap' });
    for (const b of roster) {
      wrap.appendChild(el('div', { class: 'chip', style: 'cursor:default' }, [
        el('span', { class: 'nm', text: b.name }),
        el('span', { class: 'amt', style: 'cursor:pointer', text: 'remove', onClick: () => {
          confirmDialog({ title: `Remove ${b.name}?`, sub: 'Their past bookings stay on the record.', confirmLabel: 'Remove', kind: 'out',
            onConfirm: () => { tv.removeBooker(b.id); toast(`${b.name} removed`, 'ok'); ctx.navigate('tv-settings'); } });
        } }),
      ]));
    }
    card.appendChild(wrap);
  } else {
    card.appendChild(el('div', { class: 'hint', text: 'No bookers yet — add one below.' }));
  }
  const nm = el('input', { class: 'input', placeholder: 'Name' });
  card.appendChild(el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
    el('div', { class: 'field', style: 'flex:1;margin:0' }, [el('label', { text: 'Add booker' }), nm]),
    el('button', { class: 'btn primary', text: 'Add', onClick: () => {
      if (!nm.value.trim()) return toast('Enter a name', 'warn');
      const b = tv.addBooker(nm.value);
      toast(b ? `${b.name} added` : 'That booker already exists', b ? 'ok' : 'warn');
      ctx.navigate('tv-settings');
    } }),
  ]));
  return card;
}

// --------------------------------------------------------------- cash & period
function cashCard(ctx) {
  const rec = tv.reconciliation();
  const openI = el('input', { class: 'input', type: 'number', step: '0.01', value: rec.beginning, style: 'max-width:200px' });
  const modeSel = el('select', { class: 'input', style: 'max-width:260px' }, [
    el('option', { value: 'half', text: 'Half-month (1–15 / 16–end) — as the sheet' }),
    el('option', { value: 'month', text: 'Calendar month' }),
  ]);
  modeSel.value = tv.config.periodMode === 'month' ? 'month' : 'half';
  modeSel.addEventListener('change', () => {
    tv.setPeriodMode(modeSel.value);
    toast('Reporting period updated', 'ok');
    ctx.navigate('tv-settings');
  });

  return el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Cash box & reporting' })]),
    el('p', { class: 'muted', style: 'margin-top:0', html: 'The travelista cash box is <strong>separate from the front-desk drawer</strong>. Front-desk Cash On Hand is guest deposits the hostel owes back; this is ticket money collected, most of which is payable to the travelista. Mixing them would break the deposit reconciliation, so they are tracked apart.' }),
    el('div', { class: 'amount-preview' }, [
      el('div', {}, [el('div', { class: 'lab', text: 'Cash box now' }),
        el('div', { class: 'muted', style: 'font-size:.78rem', html: `Opening ₱${pesoPlain(rec.beginning)} + collected ₱${pesoPlain(rec.collected)} − paid out ₱${pesoPlain(rec.paidOut)}` })]),
      el('div', { class: 'val', text: peso(rec.cash) }),
    ]),
    el('div', { class: 'flex gap mt', style: 'align-items:flex-end' }, [
      el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Opening float (₱)' }), openI]),
      el('button', { class: 'btn primary', text: 'Save', onClick: () => {
        const reason = el('input', { class: 'input', placeholder: 'Why is the opening float changing? (required)', autocomplete: 'off' });
        openModal({
          title: 'Change travelista opening float',
          sub: 'This shifts the cash box figure — the reason is recorded in the Activity Log.',
          body: el('div', { class: 'field' }, [el('label', { text: `Set opening float to ₱${pesoPlain(parseFloat(openI.value || '0') || 0)} — reason` }), reason]),
          actions: [
            { label: 'Cancel', kind: 'ghost' },
            { label: 'Save (admin)', kind: 'primary', onClick: (close) => {
              if (!reason.value.trim()) return toast('A reason is required', 'warn');
              managerGate(() => {
                tv.setBeginningCash(parseFloat(openI.value || '0') || 0, { reason: reason.value.trim() });
                toast(`Opening float set · cash box now ${peso(tv.cash())}`, 'ok');
                close(); ctx.navigate('tv-settings');
              }, { reason: 'Approve changing the travelista opening float' });
            } },
          ],
        });
      } }),
    ]),
    el('hr', { class: 'hr' }),
    el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Reporting period' }), modeSel,
      el('div', { class: 'hint', text: 'Bookings file by DEPARTURE date. Changing this re-files the whole record — no data is rewritten.' })]),
  ]);
}

// ------------------------------------------------------------- sheet data I/O
function dataCard(ctx) {
  const count = tv.bookings().length;
  const card = el('div', { class: 'card mt-lg', style: 'max-width:720px' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Sheet data' }), el('span', { class: 'sub', text: 'import & export' })]),
    el('p', { class: 'muted', style: 'margin-top:0', html: 'Import a CSV export of the Travelista_monitoring sheet (columns are matched by name), or load the starter period that shipped with this build. Imported rows go through the <strong>same append-only chain</strong> as typed ones — hashed, audited and reversible.' }),
    el('div', { class: 'flex gap wrap mt' }, [
      el('button', { class: 'btn primary', html: '📄&nbsp; Import CSV', onClick: () => importCSV(ctx) }),
      el('button', { class: 'btn', html: `🗄&nbsp; Load starter · ${STARTER_SHEET.label}`, onClick: () => loadStarter(ctx, count) }),
    ]),
    count ? el('div', { class: 'hint mt', text: `${count} booking${count === 1 ? '' : 's'} on record. Importing ADDS rows — it never replaces, so re-importing the same sheet will double it.` }) : null,
  ]);
  return card;
}

function loadStarter(ctx, existing) {
  const rows = STARTER_SHEET.rows;
  const total = rows.reduce((s, r) => s + r.total, 0);
  const commission = rows.reduce((s, r) => s + r.commission, 0);
  openModal({
    title: 'Load starter sheet', sub: STARTER_SHEET.label,
    body: el('div', {}, [
      el('p', { class: 'muted', style: 'margin-top:0', text: `${rows.length} bookings, ${fmtYMD('2026-08-01')} → ${fmtYMD('2026-08-10')}.` }),
      el('div', { class: 'amount-preview' }, [
        el('div', {}, [el('div', { class: 'lab', text: 'Total collected' }),
          el('div', { class: 'muted', style: 'font-size:.78rem', html: `Travelista ₱${pesoPlain(total - commission)} + commission ₱${pesoPlain(commission)}` })]),
        el('div', { class: 'val', text: peso(total) }),
      ]),
      existing
        ? el('div', { class: 'pill-warn mt', html: `<strong>${existing} booking(s) are already on record.</strong> This ADDS 15 more — if they overlap, the same money will be counted twice.` })
        : el('div', { class: 'pill mt', html: 'These are appended as normal bookings. Any you don\'t want can be voided afterwards.' }),
    ]),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Load 15 bookings', kind: 'primary', onClick: (close) => {
        managerGate(() => {
          const r = importRows(rows, { source: STARTER_SHEET.label });
          toast(`Loaded ${r.added} bookings · ₱${pesoPlain(r.total)}`, 'ok');
          close(); ctx.navigate('tv-bookings');
        }, { reason: 'Approve loading the starter sheet' });
      } },
    ],
  });
}

function importCSV(ctx) {
  const inp = el('input', { type: 'file', accept: '.csv,text/csv' });
  inp.addEventListener('change', () => {
    const f = inp.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      let rows;
      try { rows = parseTravelistaCSV(String(reader.result)); }
      catch (e) { toast(e.message || 'Could not read that CSV', 'err'); return; }
      if (!rows.length) return toast('No bookings found in that file', 'warn');
      const total = rows.reduce((s, r) => s + r.total, 0);
      const commission = rows.reduce((s, r) => s + (r.commission || 0), 0);
      openModal({
        title: 'Import travelista sheet', sub: f.name,
        body: el('div', {}, [
          el('p', { class: 'muted', style: 'margin-top:0', text: `${rows.length} bookings found (${fmtYMD(rows[0].date)} → ${fmtYMD(rows[rows.length - 1].date)}).` }),
          el('div', { class: 'amount-preview' }, [
            el('div', {}, [el('div', { class: 'lab', text: 'Total collected' }),
              el('div', { class: 'muted', style: 'font-size:.78rem', html: `Travelista ₱${pesoPlain(total - commission)} + commission ₱${pesoPlain(commission)}` })]),
            el('div', { class: 'val', text: peso(total) }),
          ]),
          el('div', { class: 'pill-warn mt', html: 'Rows are <strong>added</strong> to the record — nothing is replaced. Destinations and bookers not yet configured are created from the file.' }),
        ]),
        actions: [
          { label: 'Cancel', kind: 'ghost' },
          { label: `Import ${rows.length} bookings`, kind: 'primary', onClick: (close) => {
            managerGate(() => {
              const r = importRows(rows, { source: f.name });
              toast(`Imported ${r.added} bookings · ₱${pesoPlain(r.total)}`, 'ok');
              close(); ctx.navigate('tv-bookings');
            }, { reason: `Approve importing ${rows.length} travelista bookings` });
          } },
        ],
      });
    };
    reader.readAsText(f);
  });
  inp.click();
}
