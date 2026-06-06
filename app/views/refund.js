// views/refund.js — return a deposit (cash OUT). Pulls from outstanding deposits
// and guards against refunding more than is held for that guest.
import { el, peso, pesoPlain, toast, clear, isTowelItem } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog, towelBadges } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const items = store.activeItems();
  root.appendChild(pageHead('New Refund', 'Cash returned when a guest gives an item back or checks out', null));

  let selected = items[0] || null;
  let qty = 1;
  let pickedGuest = null;

  const layout = el('div', { class: 'grid', style: 'grid-template-columns:340px 1fr;gap:18px;align-items:start' });

  // ---------------- left: outstanding guests ----------------
  const left = el('div', { class: 'card', style: 'position:sticky;top:16px' });
  left.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: 'Outstanding' }), el('span', { class: 'sub', text: 'deposits held' })]));
  const search = el('input', { class: 'input', placeholder: 'Search guest or room…', autocomplete: 'off' });
  left.appendChild(search);
  const listWrap = el('div', { class: 'mt', style: 'max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:8px' });
  left.appendChild(listWrap);

  function renderList() {
    clear(listWrap);
    const q = search.value.toLowerCase().trim();
    const data = store.outstandingByGuest().filter((g) =>
      !q || g.guest.toLowerCase().includes(q) || g.room.toLowerCase().includes(q));
    if (!data.length) {
      listWrap.appendChild(el('div', { class: 'empty', style: 'padding:24px 8px' }, [el('div', { class: 'ic', text: '✓' }), el('p', { text: 'No outstanding deposits.' })]));
      return;
    }
    for (const g of data) {
      const card = el('div', {
        class: 'guest-card', style: 'cursor:pointer',
        onClick: () => pick(g),
      }, [
        el('div', {}, [
          el('div', { class: 'g-name', text: g.guest || '(no name)' }),
          el('div', { class: 'g-room', text: g.room ? `Room ${g.room}` : '' }),
          el('div', { class: 'g-items', text: Object.entries(g.items).filter(([, v]) => v > 0).map(([k, v]) => `${k} ₱${pesoPlain(v)}`).join(' · ') }),
          towelBadges(g.towels),
        ]),
        el('div', { class: 'g-held', text: peso(g.held) }),
      ]);
      listWrap.appendChild(card);
    }
  }
  search.addEventListener('input', renderList);

  // ---------------- right: refund form ----------------
  const form = el('div', { class: 'card elev' });

  const chipWrap = el('div', { class: 'chips' });
  function paintChips() { chipWrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.id === (selected && selected.id))); }
  for (const it of items) {
    chipWrap.appendChild(el('div', {
      class: 'chip', dataset: { id: it.id },
      onClick: () => { selected = it; unitInput.value = it.defaultAmount; paintChips(); updatePreview(); syncTowel(); },
    }, [el('span', { class: 'nm', text: it.name }), el('span', { class: 'amt', text: `₱${pesoPlain(it.defaultAmount)} ea` })]));
  }

  const qtyInput = el('input', { type: 'number', min: '1', value: '1', inputmode: 'numeric' });
  const stepper = el('div', { class: 'stepper' }, [
    el('button', { type: 'button', text: '−', onClick: () => { qty = Math.max(1, qty - 1); qtyInput.value = qty; updatePreview(); } }),
    qtyInput,
    el('button', { type: 'button', text: '+', onClick: () => { qty += 1; qtyInput.value = qty; updatePreview(); } }),
  ]);
  qtyInput.addEventListener('input', () => { qty = Math.max(1, parseInt(qtyInput.value || '1', 10)); updatePreview(); });

  const unitInput = el('input', { class: 'input', type: 'number', min: '0', step: '50', value: selected ? selected.defaultAmount : 0 });
  unitInput.addEventListener('input', updatePreview);
  const guestInput = el('input', { class: 'input', placeholder: 'guest name', autocomplete: 'off' });
  const roomInput = el('input', { class: 'input', placeholder: 'room #', autocomplete: 'off' });
  const noteInput = el('input', { class: 'input', placeholder: 'optional', autocomplete: 'off' });

  // towel tag number — only for the "Towel" item; pre-filled from the guest's
  // deposit so staff can confirm the right tag is coming back.
  const towelInput = el('input', { class: 'input', placeholder: 'e.g. 42', autocomplete: 'off' });
  const towelHint = el('div', { class: 'hint', text: 'tag number on the returned towel' });
  const towelField = el('div', { class: 'field' }, [el('label', { text: 'Towel number' }), towelInput, towelHint]);

  // Lost-towel path: when the towel is NOT returned, staff flag it and the manager
  // chooses how much of the deposit to keep (loss charge). Guest gets the rest back.
  const lostCheck = el('input', { type: 'checkbox' });
  const chargeInput = el('input', { class: 'input', type: 'number', min: '0', step: '50', placeholder: '0.00', style: 'max-width:200px' });
  chargeInput.addEventListener('input', updatePreview);
  const chargeField = el('div', { class: 'field', style: 'margin-top:8px' }, [
    el('label', { text: 'Loss charge to keep (₱)' }), chargeInput,
    el('div', { class: 'hint', text: 'kept by the hostel for the lost towel; the rest is returned to the guest' }),
  ]);
  const lostField = el('div', { class: 'field', style: 'background:var(--out-50);border:1px solid var(--out);border-radius:10px;padding:10px 12px' }, [
    el('label', { class: 'flex aic gap', style: 'cursor:pointer;margin:0' }, [lostCheck, 'Towel not returned (reported lost)']),
    chargeField,
  ]);
  function syncTowel() {
    const isTowel = !!(selected && isTowelItem(selected.name));
    towelField.style.display = isTowel ? '' : 'none';
    lostField.style.display = isTowel ? '' : 'none';
    if (!isTowel) lostCheck.checked = false;
    syncLost();
  }
  function syncLost() {
    chargeField.style.display = lostCheck.checked ? '' : 'none';
    if (lostCheck.checked && chargeInput.value === '') chargeInput.value = amount(); // default = forfeit full deposit
    updatePreview();
  }
  lostCheck.addEventListener('change', syncLost);

  function unit() { return parseFloat(unitInput.value || '0'); }
  function amount() { return Math.round(unit() * qty * 100) / 100; }
  function isLost() { return !!(selected && isTowelItem(selected.name) && lostCheck.checked); }
  function chargeVal() { return Math.min(Math.max(parseFloat(chargeInput.value || '0') || 0, 0), amount()); }

  const previewVal = el('div', { class: 'val', text: '₱0.00' });
  const previewLab = el('div', { class: 'lab', style: 'color:var(--out-700)', text: 'Refund amount (auto)' });
  const heldNote = el('div', { class: 'muted', style: 'font-size:.78rem' });
  function updatePreview() {
    if (isLost()) {
      const X = amount(), K = chargeVal(), R = Math.round((X - K) * 100) / 100;
      previewLab.textContent = 'Guest receives (towel lost)';
      previewVal.textContent = peso(R);
      heldNote.innerHTML = `Settle <b>${peso(X)}</b> · keep <b>${peso(K)}</b> as loss charge · return <b>${peso(R)}</b>`;
      heldNote.style.color = 'var(--out-700)';
    } else {
      previewLab.textContent = 'Refund amount (auto)';
      previewVal.textContent = peso(amount());
      if (pickedGuest) {
        heldNote.textContent = `${pickedGuest.guest} holds ${peso(pickedGuest.held)}`;
        heldNote.style.color = amount() > pickedGuest.held + 0.005 ? 'var(--out-700)' : 'var(--muted)';
      } else { heldNote.textContent = 'unit × quantity'; heldNote.style.color = 'var(--muted)'; }
    }
  }
  const preview = el('div', { class: 'amount-preview', style: 'border-color:var(--out);background:var(--out-50)' }, [
    el('div', {}, [previewLab, heldNote]),
    previewVal,
  ]);

  function pick(g) {
    pickedGuest = g;
    guestInput.value = g.guest;
    roomInput.value = g.room;
    // default qty/amount to first held item if matches a type
    const heldItemName = Object.entries(g.items).find(([, v]) => v > 0);
    if (heldItemName) {
      const match = items.find((it) => it.name === heldItemName[0]);
      if (match) { selected = match; unitInput.value = match.defaultAmount; paintChips(); }
    }
    // Auto-fill the towel tag(s) this guest left at deposit so the refund mirrors
    // the deposit. Fills all of them (full check-out is the common case); staff can
    // trim the field if only some towels actually came back.
    const tags = g.towels || [];
    towelInput.value = tags.join(', ');
    towelHint.textContent = tags.length
      ? 'auto-filled from deposit — edit if only some came back'
      : 'tag number on the returned towel';
    syncTowel();
    updatePreview();
    toast(`Loaded ${g.guest}`, 'ok');
  }

  form.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Item being returned' }), chipWrap]));
  form.appendChild(el('div', { class: 'row3' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Quantity' }), stepper]),
    el('div', { class: 'field' }, [el('label', { text: 'Unit amount (₱)' }), unitInput]),
    el('div', { class: 'field' }, [el('label', { text: 'Room #' }), roomInput]),
  ]));
  form.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Guest name' }), guestInput]));
  form.appendChild(towelField);
  form.appendChild(lostField);
  form.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Note (optional)' }), noteInput]));
  form.appendChild(preview);

  const submit = el('button', { class: 'btn out lg block mt-lg', html: '↩&nbsp; Record refund' });
  form.appendChild(submit);

  function doRefund() {
    const e = store.addRefund({
      itemTypeId: selected.id, qty, unitAmount: unit(), amount: amount(),
      guest: guestInput.value, room: roomInput.value, note: noteInput.value,
      towelNo: isTowelItem(selected.name) ? towelInput.value : '',
    });
    toast(`Refund recorded · ${peso(e.amount)} · COH now ${peso(store.coh())}`, 'ok');
    ctx.navigate('dashboard');
  }

  function doLost() {
    store.recordTowelLoss({
      itemTypeId: selected.id, guest: guestInput.value, room: roomInput.value,
      towelNo: towelInput.value.trim(), deposit: amount(), charge: chargeVal(),
    });
    toast(`Towel ${towelInput.value.trim()} marked lost · COH now ${peso(store.coh())}`, 'ok');
    ctx.navigate('dashboard');
  }

  submit.addEventListener('click', () => {
    if (!selected) { toast('Pick an item first', 'warn'); return; }
    if (!guestInput.value.trim() && !roomInput.value.trim()) { toast('Enter a guest name or room #', 'warn'); return; }
    if (amount() <= 0) { toast('Amount must be greater than 0', 'warn'); return; }
    // Lost-towel settlement: confirm the keep/return split before booking it.
    if (isLost()) {
      if (!towelInput.value.trim()) { toast('Enter the towel number that was lost', 'warn'); return; }
      const X = amount(), K = chargeVal(), R = Math.round((X - K) * 100) / 100;
      confirmDialog({
        title: 'Record lost towel?',
        sub: `Settle ${peso(X)} for ${guestInput.value.trim() || roomInput.value.trim()}: keep ${peso(K)} as a loss charge, return ${peso(R)}. Towel ${towelInput.value.trim()} will be flagged lost for admin review.`,
        confirmLabel: 'Record lost towel', kind: 'out', onConfirm: doLost,
      });
      return;
    }
    // over-refund guard vs this guest's held balance
    if (pickedGuest && amount() > pickedGuest.held + 0.005) {
      confirmDialog({
        title: 'Refund exceeds held deposit',
        sub: `${pickedGuest.guest} only holds ${peso(pickedGuest.held)}, but you're refunding ${peso(amount())}. This would push their balance negative. Proceed anyway?`,
        confirmLabel: 'Refund anyway', kind: 'out', onConfirm: doRefund,
      });
      return;
    }
    doRefund();
  });

  layout.appendChild(left);
  layout.appendChild(form);
  root.appendChild(layout);
  paintChips(); updatePreview(); renderList(); syncTowel();
  return root;
}
