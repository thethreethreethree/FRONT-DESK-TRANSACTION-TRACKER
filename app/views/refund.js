// views/refund.js — return a deposit (cash OUT). Pulls from outstanding deposits
// and guards against refunding more than is held for that guest.
import { el, peso, pesoPlain, toast, clear } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog } from '../components.js';

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
      onClick: () => { selected = it; unitInput.value = it.defaultAmount; paintChips(); updatePreview(); },
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

  function unit() { return parseFloat(unitInput.value || '0'); }
  function amount() { return Math.round(unit() * qty * 100) / 100; }

  const previewVal = el('div', { class: 'val', text: '₱0.00' });
  const heldNote = el('div', { class: 'muted', style: 'font-size:.78rem' });
  function updatePreview() {
    previewVal.textContent = peso(amount());
    if (pickedGuest) {
      heldNote.textContent = `${pickedGuest.guest} holds ${peso(pickedGuest.held)}`;
      heldNote.style.color = amount() > pickedGuest.held + 0.005 ? 'var(--out-700)' : 'var(--muted)';
    } else heldNote.textContent = 'unit × quantity';
  }
  const preview = el('div', { class: 'amount-preview', style: 'border-color:var(--out);background:var(--out-50)' }, [
    el('div', {}, [el('div', { class: 'lab', style: 'color:var(--out-700)', text: 'Refund amount (auto)' }), heldNote]),
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
  form.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Note (optional)' }), noteInput]));
  form.appendChild(preview);

  const submit = el('button', { class: 'btn out lg block mt-lg', html: '↩&nbsp; Record refund' });
  form.appendChild(submit);

  function doRefund() {
    const e = store.addRefund({
      itemTypeId: selected.id, qty, unitAmount: unit(), amount: amount(),
      guest: guestInput.value, room: roomInput.value, note: noteInput.value,
    });
    toast(`Refund recorded · ${peso(e.amount)} · COH now ${peso(store.coh())}`, 'ok');
    ctx.navigate('dashboard');
  }

  submit.addEventListener('click', () => {
    if (!selected) { toast('Pick an item first', 'warn'); return; }
    if (!guestInput.value.trim() && !roomInput.value.trim()) { toast('Enter a guest name or room #', 'warn'); return; }
    if (amount() <= 0) { toast('Amount must be greater than 0', 'warn'); return; }
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
  paintChips(); updatePreview(); renderList();
  return root;
}
