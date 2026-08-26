// views/deposit.js — record a guest deposit (cash IN). Fast keyboard entry.
import { el, peso, pesoPlain, toast, guessShift, isTowelItem } from '../util.js';
import { store } from '../store.js';
import { pageHead } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const items = store.activeItems();

  let selected = items[0] || null;
  let qty = 1;
  let unitOverride = null;

  const state = { guest: '', room: '', pax: '' };

  root.appendChild(pageHead('New Deposit', 'Cash received when a guest borrows an item', null));

  const card = el('div', { class: 'card elev', style: 'max-width:680px' });

  // item chips
  const chipWrap = el('div', { class: 'chips' });
  function paintChips() {
    chipWrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.id === (selected && selected.id)));
  }
  for (const it of items) {
    chipWrap.appendChild(el('div', {
      class: 'chip', dataset: { id: it.id },
      onClick: () => { selected = it; unitOverride = null; unitInput.value = it.defaultAmount; paintChips(); updatePreview(); syncTowel(); syncPassport(); },
    }, [
      el('span', { class: 'nm', text: it.name }),
      el('span', { class: 'amt', text: `₱${pesoPlain(it.defaultAmount)} ea` }),
    ]));
  }

  // qty stepper
  const qtyInput = el('input', { type: 'number', min: '1', value: '1', inputmode: 'numeric' });
  const stepper = el('div', { class: 'stepper' }, [
    el('button', { type: 'button', text: '−', onClick: () => { qty = Math.max(1, qty - 1); qtyInput.value = qty; updatePreview(); } }),
    qtyInput,
    el('button', { type: 'button', text: '+', onClick: () => { qty = qty + 1; qtyInput.value = qty; updatePreview(); } }),
  ]);
  qtyInput.addEventListener('input', () => { qty = Math.max(1, parseInt(qtyInput.value || '1', 10)); updatePreview(); });

  // unit amount (override allowed)
  const unitInput = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: selected ? selected.defaultAmount : 0 });
  unitInput.addEventListener('input', () => { unitOverride = parseFloat(unitInput.value || '0'); updatePreview(); });

  // towel tag number — only shown for the "Towel" item (not Beach Towel etc.)
  const towelInput = el('input', { class: 'input', placeholder: 'e.g. 42 or 87/97', autocomplete: 'off' });
  const towelField = el('div', { class: 'field' }, [
    el('label', { text: 'Towel number' }), towelInput,
    el('div', { class: 'hint', text: 'tag number on the towel the guest is borrowing' }),
  ]);
  function syncTowel() { towelField.style.display = (selected && isTowelItem(selected.name)) ? '' : 'none'; }

  // How the deposit is secured. Three ways an item leaves the desk:
  //   Cash         — the normal deposit; COH rises by the amount.
  //   Passport     — the passport SUBSTITUTES for the cash. ₱0 taken (COH
  //                  untouched), passport held against a MEWS reservation #.
  //   Private room — secured by the room itself. No cash, no document held. ₱0,
  //                  so it moves no money now and none at check-out either; it
  //                  exists purely to record that the item is out and with whom.
  let method = 'cash';
  const methodToggle = el('div', { class: 'role-toggle' }, [
    el('button', { type: 'button', class: 'active', html: '💵&nbsp; Cash', onClick: (ev) => setMethod('cash', ev) }),
    el('button', { type: 'button', html: `${store.location.collateral.icon}&nbsp; ${store.location.collateral.label}`, onClick: (ev) => setMethod('passport', ev) }),
    el('button', { type: 'button', html: '🏠&nbsp; Private room', onClick: (ev) => setMethod('room', ev) }),
  ]);
  function setMethod(m, ev) {
    method = m;
    methodToggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    ev.currentTarget.classList.add('active');
    syncPassport();
  }
  function isPassport() { return method === 'passport'; }
  function isPrivateRoom() { return method === 'room'; }
  // The non-cash collateral is a passport at Main and a valid ID at the
  // Beachfront. Same mechanism throughout — only the wording differs.
  const COLL = store.location.collateral;
  const mewsInput = el('input', { class: 'input', placeholder: COLL.refPlaceholder, autocomplete: 'off' });
  const mewsField = el('div', { class: 'field' }, [
    el('label', { text: COLL.refLabel }), mewsInput,
    el('div', { class: 'hint', text: COLL.refHint }),
  ]);
  const roomNote = el('div', { class: 'pill', style: 'display:none', html: `No cash and no ${COLL.noun} is taken. The item is signed out against the room — close it with <strong>Guest checked out</strong> on the Private Rooms page when they return it.` });
  function syncPassport() {
    mewsField.style.display = isPassport() ? '' : 'none';
    roomNote.style.display = isPrivateRoom() ? '' : 'none';
    // The room # IS the security on a private-room hold, so it stops being optional.
    roomLabel.textContent = isPrivateRoom() ? 'Room # (required)' : 'Room #';
    updatePreview();
  }

  // guest / room / pax
  const guestInput = el('input', { class: 'input', placeholder: 'e.g. Charlie H.', autocomplete: 'off' });
  const roomInput = el('input', { class: 'input', placeholder: 'e.g. 309', autocomplete: 'off' });
  const roomLabel = el('label', { text: 'Room #' });
  const paxInput = el('input', { class: 'input', type: 'number', min: '1', placeholder: 'e.g. 2', inputmode: 'numeric' });
  const noteInput = el('input', { class: 'input', placeholder: 'optional', autocomplete: 'off' });

  // amount preview
  const previewVal = el('div', { class: 'val', text: '₱0.00' });
  const previewLab = el('div', { class: 'lab', text: 'Deposit amount (auto)' });
  const previewSub = el('div', { class: 'muted', style: 'font-size:.78rem', text: 'unit × quantity' });
  function unit() { return unitOverride != null ? unitOverride : (selected ? selected.defaultAmount : 0); }
  function value() { return Math.round(unit() * qty * 100) / 100; } // nominal deposit value
  // Cash actually taken. Both non-cash methods take ₱0 — the value above is kept
  // for reference only, so COH is untouched either way.
  function amount() { return (isPassport() || isPrivateRoom()) ? 0 : value(); }
  function updatePreview() {
    previewVal.textContent = peso(value());
    previewLab.textContent = isPassport() ? `Deposit value · ${peso(value())} (${COLL.label.toLowerCase()})`
      : isPrivateRoom() ? `Item value · ${peso(value())} (private room)`
        : 'Deposit amount (auto)';
    previewSub.textContent = isPassport() ? `secured by ${COLL.noun} — no cash, COH unchanged`
      : isPrivateRoom() ? 'secured by the room — no cash taken, COH unchanged'
        : 'unit × quantity';
  }

  const preview = el('div', { class: 'amount-preview' }, [
    el('div', {}, [previewLab, previewSub]),
    previewVal,
  ]);

  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Item' }), chipWrap]));
  card.appendChild(el('div', { class: 'row3' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Quantity' }), stepper]),
    el('div', { class: 'field' }, [el('label', { text: 'Unit amount (₱)' }), unitInput, el('div', { class: 'hint', text: 'editable — note the reason if changed' })]),
    el('div', { class: 'field' }, [el('label', { text: 'PAX (optional)' }), paxInput]),
  ]));
  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Deposit paid by' }), methodToggle]));
  card.appendChild(el('div', { class: 'row2' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Guest name' }), guestInput]),
    el('div', { class: 'field' }, [roomLabel, roomInput]),
  ]));
  card.appendChild(towelField);
  card.appendChild(mewsField);
  card.appendChild(roomNote);
  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Note (optional)' }), noteInput]));
  card.appendChild(preview);

  const submit = el('button', { class: 'btn in lg block mt-lg', html: '＋&nbsp; Record deposit' });
  card.appendChild(submit);
  card.appendChild(el('p', { class: 'hint center mt', html: `Will be logged to the <strong>${guessShift()}</strong> shift as <strong>${store.session ? store.session.name : ''}</strong>, then sealed into the ledger.` }));

  submit.addEventListener('click', () => {
    if (!selected) { toast('Pick an item first', 'warn'); return; }
    if (!guestInput.value.trim() && !roomInput.value.trim()) { toast('Enter a guest name or room #', 'warn'); return; }
    if (isPassport()) {
      if (!mewsInput.value.trim()) { toast(`Enter the ${COLL.refLabel.toLowerCase()}`, 'warn'); return; }
    } else if (isPrivateRoom()) {
      if (!roomInput.value.trim()) { toast('Enter the room # — it secures a private-room hold', 'warn'); return; }
    } else if (amount() <= 0) { toast('Amount must be greater than 0', 'warn'); return; }
    const e = store.addDeposit({
      itemTypeId: selected.id, qty, unitAmount: unit(), amount: amount(),
      guest: guestInput.value, room: roomInput.value, pax: paxInput.value, note: noteInput.value,
      towelNo: isTowelItem(selected.name) ? towelInput.value : '',
      mewsRes: isPassport() ? mewsInput.value : '',
      privateRoom: isPrivateRoom(),
    });
    toast(isPassport()
      ? `${COLL.label} held for ${selected.name} (${peso(value())}) · ${guestInput.value.trim() || roomInput.value.trim()} · ${mewsInput.value.trim()}`
      : isPrivateRoom()
        ? `${selected.name} out on private room ${roomInput.value.trim()} · no cash taken · COH unchanged (${peso(store.coh())})`
        : `Deposit recorded · ${peso(e.amount)} · COH now ${peso(store.coh())}`, 'ok');
    ctx.navigate(isPassport() ? 'passports' : isPrivateRoom() ? 'privaterooms' : 'dashboard');
  });

  root.appendChild(card);
  paintChips(); updatePreview(); syncTowel(); syncPassport();
  setTimeout(() => guestInput.focus(), 60);
  return root;
}
