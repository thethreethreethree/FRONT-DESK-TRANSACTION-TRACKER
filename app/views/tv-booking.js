// views/tv-booking.js — record a travelista booking (cash IN).
// The rate table fills the numbers in; every one of them stays editable, and the
// split is shown live so the person at the desk sees exactly what they're sealing.
import { el, peso, pesoPlain, toast, businessDate } from '../util.js';
import { tv, periodOf, toYMD, misPricedWholeVehicle } from '../travelista.js';
import { store } from '../store.js';
import { pageHead, openModal } from '../components.js';

export function render(ctx) {
  tv.ensureSeed();
  const root = el('div');
  const dests = tv.activeDestinations();

  let selected = dests[0] || null;
  let pax = 1;
  let fareOverride = null;
  let commissionOverride = null;

  root.appendChild(pageHead('New Booking', 'Ticket sold to a guest — cash received', null));

  if (!dests.length) {
    root.appendChild(el('div', { class: 'card', style: 'max-width:680px' }, [
      el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🚐' }), el('p', { text: 'No destinations set up yet. An admin can add them in Travelista → Settings.' })]),
      store.isManager() ? el('button', { class: 'btn primary block', text: 'Open settings', onClick: () => ctx.navigate('tv-settings') }) : null,
    ]));
    return root;
  }

  const card = el('div', { class: 'card elev', style: 'max-width:680px' });

  // destination chips (fare + split shown on the chip, like the deposit items)
  const chipWrap = el('div', { class: 'chips' });
  function paintChips() {
    chipWrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.id === (selected && selected.id)));
  }
  for (const d of dests) {
    chipWrap.appendChild(el('div', {
      class: 'chip', dataset: { id: d.id },
      onClick: () => {
        selected = d; fareOverride = null; commissionOverride = null;
        fareInput.value = d.fare; commInput.value = '';
        paintChips(); update();
      },
    }, [
      el('span', { class: 'nm', text: d.name }),
      el('span', { class: 'amt', text: `₱${pesoPlain(d.fare)} ${d.fareBasis === 'flat' ? 'flat' : 'ea'}` }),
    ]));
  }

  const dateInput = el('input', { class: 'input', type: 'date', value: businessDate() });
  const guestInput = el('input', { class: 'input', placeholder: 'e.g. SILUNA DON', autocomplete: 'off' });

  const paxInput = el('input', { type: 'number', min: '1', value: '1', inputmode: 'numeric' });
  const stepper = el('div', { class: 'stepper' }, [
    el('button', { type: 'button', text: '−', onClick: () => { pax = Math.max(1, pax - 1); paxInput.value = pax; update(); } }),
    paxInput,
    el('button', { type: 'button', text: '+', onClick: () => { pax += 1; paxInput.value = pax; update(); } }),
  ]);
  paxInput.addEventListener('input', () => { pax = Math.max(1, parseInt(paxInput.value || '1', 10)); update(); });

  const fareInput = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: selected ? selected.fare : 0 });
  fareInput.addEventListener('input', () => { fareOverride = parseFloat(fareInput.value || '0'); update(); });

  const commInput = el('input', { class: 'input', type: 'number', min: '0', step: '50', placeholder: 'auto' });
  commInput.addEventListener('input', () => {
    const v = commInput.value.trim();
    commissionOverride = v === '' ? null : parseFloat(v || '0');
    update();
  });

  // Who booked it. A NEW building starts with an empty roster, so the list has to
  // be able to grow from here — otherwise the very first booking is unrecordable
  // until someone finds the Settings page.
  const bookedBy = el('select', { class: 'input' });
  function paintBookers(select) {
    while (bookedBy.firstChild) bookedBy.removeChild(bookedBy.firstChild);
    bookedBy.appendChild(el('option', { value: '', text: '— who booked it —' }));
    for (const b of tv.bookers()) bookedBy.appendChild(el('option', { value: b.name, text: b.name }));
    bookedBy.appendChild(el('option', { value: '__add__', text: '＋ Add a booker…' }));
    // The signed-in person is the likeliest booker — preselect when on the roster.
    const me = (store.session ? store.session.name : '').trim().toUpperCase();
    bookedBy.value = select || (tv.bookers().some((b) => b.name === me) ? me : '');
  }
  bookedBy.addEventListener('change', () => {
    if (bookedBy.value !== '__add__') return;
    const nm = el('input', { class: 'input', placeholder: 'Name', autocomplete: 'off' });
    openModal({
      title: 'Add a booker', sub: 'They will be available on every booking from now on.',
      body: el('div', { class: 'field' }, [el('label', { text: 'Name' }), nm]),
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: (close) => { paintBookers(''); close(); } },
        { label: 'Add', kind: 'primary', onClick: (close) => {
          const added = tv.addBooker(nm.value);
          if (!added && nm.value.trim()) { paintBookers(nm.value.trim().toUpperCase()); close(); return; }
          if (!added) { toast('Enter a name', 'warn'); return; }
          toast(`${added.name} added`, 'ok');
          paintBookers(added.name); close();
        } },
      ],
    });
  });
  paintBookers();

  const remarksInput = el('input', { class: 'input', placeholder: 'e.g. PRIVATE VAN', autocomplete: 'off' });

  // live split preview — total, travelista share, hostel commission
  const totalVal = el('div', { class: 'val', text: '₱0.00' });
  const splitLine = el('div', { class: 'muted', style: 'font-size:.78rem' });
  const periodLine = el('div', { class: 'hint mt' });
  const basisHint = el('div', { class: 'hint' });
  // A private van is one price for the vehicle. If the rate table has it priced
  // per pax, the total below is multiplied by the passenger count — say so
  // loudly, at the moment the money is about to be taken.
  const rateWarn = el('div', { class: 'pill-warn', style: 'display:none' });

  function q() {
    return tv.quote({
      destinationId: selected ? selected.id : null, pax,
      fare: fareOverride != null ? fareOverride : undefined,
      commission: commissionOverride != null ? commissionOverride : undefined,
    });
  }
  function update() {
    const r = q();
    totalVal.textContent = peso(r.total);
    splitLine.innerHTML = `Travelista <b>₱${pesoPlain(r.share)}</b> &nbsp;·&nbsp; Hostel commission <b>₱${pesoPlain(r.commission)}</b>`;
    const p = periodOf(toYMD(dateInput.value) || businessDate());
    periodLine.textContent = p ? `Files under ${p.label} (by departure date)` : 'Pick a departure date';
    basisHint.textContent = selected && selected.fareBasis === 'flat'
      ? `flat rate — ₱${pesoPlain(r.fare)} for the whole vehicle, however many pax`
      : `priced per pax — ₱${pesoPlain(r.fare)} × ${pax}`;
    const wrong = misPricedWholeVehicle(selected) && pax > 1;
    rateWarn.style.display = wrong ? '' : 'none';
    if (wrong) {
      rateWarn.innerHTML = `<strong>Check this total.</strong> “${selected.name}” is priced <strong>per pax</strong>, `
        + `so ${pax} passengers come to <strong>₱${pesoPlain(r.total)}</strong>. A private van is normally one price for the `
        + `whole vehicle (₱${pesoPlain(r.fare)}). An admin can switch it to <strong>flat</strong> in Travelista → Settings.`;
    }
  }
  dateInput.addEventListener('change', update);

  const preview = el('div', { class: 'amount-preview' }, [
    el('div', {}, [
      el('div', { class: 'lab', text: 'Total collected (auto)' }),
      splitLine,
    ]),
    totalVal,
  ]);

  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Destination' }), chipWrap, basisHint]));
  card.appendChild(el('div', { class: 'row2' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Departure date' }), dateInput]),
    el('div', { class: 'field' }, [el('label', { text: 'Guest name' }), guestInput]),
  ]));
  card.appendChild(el('div', { class: 'row3' }, [
    el('div', { class: 'field' }, [el('label', { text: 'No. of pax' }), stepper]),
    el('div', { class: 'field' }, [el('label', { text: 'Fare (₱)' }), fareInput, el('div', { class: 'hint', text: 'editable' })]),
    el('div', { class: 'field' }, [el('label', { text: 'Commission (₱)' }), commInput, el('div', { class: 'hint', text: 'blank = from the rate table' })]),
  ]));
  card.appendChild(el('div', { class: 'row2' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Booked by' }), bookedBy]),
    el('div', { class: 'field' }, [el('label', { text: 'Remarks' }), remarksInput]),
  ]));
  card.appendChild(rateWarn);
  card.appendChild(preview);
  card.appendChild(periodLine);

  const submit = el('button', { class: 'btn in lg block mt-lg', html: '＋&nbsp; Record booking' });
  card.appendChild(submit);
  card.appendChild(el('p', { class: 'hint center mt', html: `Sealed into the travelista record as <strong>${store.session ? store.session.name : ''}</strong> — correctable later only by an admin void.` }));

  submit.addEventListener('click', () => {
    if (!selected) return toast('Pick a destination first', 'warn');
    if (!guestInput.value.trim()) return toast('Enter the guest name', 'warn');
    if (!dateInput.value) return toast('Pick the departure date', 'warn');
    const r = q();
    if (!(r.total > 0)) return toast('Total must be greater than 0', 'warn');
    if (r.commission > r.total) return toast('Commission cannot be more than the total', 'warn');
    if (!bookedBy.value) return toast('Select who booked it', 'warn');
    const e = tv.addBooking({
      departureDate: dateInput.value, guest: guestInput.value, destinationId: selected.id,
      pax, fare: r.fare, total: r.total, commission: r.commission,
      bookedBy: bookedBy.value, remarks: remarksInput.value,
    });
    toast(`Booking #${e.seq} recorded · ${peso(e.total)} · cash box now ${peso(tv.cash())}`, 'ok');
    ctx.navigate('tv-dashboard');
  });

  root.appendChild(card);
  paintChips(); update();
  setTimeout(() => guestInput.focus(), 60);
  return root;
}
