// views/deposit.js — record a guest deposit (cash IN). Fast keyboard entry.
import { el, peso, pesoPlain, toast, guessShift, isTowelItem, isPassportItem } from '../util.js';
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

  // passport (non-cash): ₱0 deposit, MEWS reservation # required, no unit amount.
  function isPassport() { return !!(selected && isPassportItem(selected.name)); }
  const mewsInput = el('input', { class: 'input', placeholder: 'e.g. RES-48213', autocomplete: 'off' });
  const mewsField = el('div', { class: 'field' }, [
    el('label', { text: 'MEWS reservation #' }), mewsInput,
    el('div', { class: 'hint', text: 'required — the booking this passport is held against' }),
  ]);
  function syncPassport() {
    const p = isPassport();
    mewsField.style.display = p ? '' : 'none';
    unitInput.disabled = p;
    if (p) { unitOverride = 0; unitInput.value = 0; }
    updatePreview();
  }

  // guest / room / pax
  const guestInput = el('input', { class: 'input', placeholder: 'e.g. Charlie H.', autocomplete: 'off' });
  const roomInput = el('input', { class: 'input', placeholder: 'e.g. 309', autocomplete: 'off' });
  const paxInput = el('input', { class: 'input', type: 'number', min: '1', placeholder: 'e.g. 2', inputmode: 'numeric' });
  const noteInput = el('input', { class: 'input', placeholder: 'optional', autocomplete: 'off' });

  // amount preview
  const previewVal = el('div', { class: 'val', text: '₱0.00' });
  const previewLab = el('div', { class: 'lab', text: 'Deposit amount (auto)' });
  const previewSub = el('div', { class: 'muted', style: 'font-size:.78rem', text: 'unit × quantity' });
  function unit() { return isPassport() ? 0 : (unitOverride != null ? unitOverride : (selected ? selected.defaultAmount : 0)); }
  function amount() { return Math.round(unit() * qty * 100) / 100; }
  function updatePreview() {
    previewVal.textContent = peso(amount());
    previewLab.textContent = isPassport() ? 'No cash — passport held' : 'Deposit amount (auto)';
    previewSub.textContent = isPassport() ? 'collateral only · COH unchanged' : 'unit × quantity';
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
  card.appendChild(el('div', { class: 'row2' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Guest name' }), guestInput]),
    el('div', { class: 'field' }, [el('label', { text: 'Room #' }), roomInput]),
  ]));
  card.appendChild(towelField);
  card.appendChild(mewsField);
  card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Note (optional)' }), noteInput]));
  card.appendChild(preview);

  const submit = el('button', { class: 'btn in lg block mt-lg', html: '＋&nbsp; Record deposit' });
  card.appendChild(submit);
  card.appendChild(el('p', { class: 'hint center mt', html: `Will be logged to the <strong>${guessShift()}</strong> shift as <strong>${store.session ? store.session.name : ''}</strong>, then sealed into the ledger.` }));

  submit.addEventListener('click', () => {
    if (!selected) { toast('Pick an item first', 'warn'); return; }
    if (!guestInput.value.trim() && !roomInput.value.trim()) { toast('Enter a guest name or room #', 'warn'); return; }
    if (isPassport()) {
      if (!mewsInput.value.trim()) { toast('Enter the MEWS reservation number', 'warn'); return; }
    } else if (amount() <= 0) { toast('Amount must be greater than 0', 'warn'); return; }
    const e = store.addDeposit({
      itemTypeId: selected.id, qty, unitAmount: unit(), amount: amount(),
      guest: guestInput.value, room: roomInput.value, pax: paxInput.value, note: noteInput.value,
      towelNo: isTowelItem(selected.name) ? towelInput.value : '',
      mewsRes: isPassport() ? mewsInput.value : '',
    });
    toast(isPassport()
      ? `Passport held · ${guestInput.value.trim() || roomInput.value.trim()} · MEWS ${mewsInput.value.trim()}`
      : `Deposit recorded · ${peso(e.amount)} · COH now ${peso(store.coh())}`, 'ok');
    ctx.navigate(isPassport() ? 'passports' : 'dashboard');
  });

  root.appendChild(card);
  paintChips(); updatePreview(); syncTowel(); syncPassport();
  setTimeout(() => guestInput.focus(), 60);
  return root;
}
