// views/refund.js — return a deposit (cash OUT). Pulls from outstanding deposits
// and guards against refunding more than is held for that guest.
import { el, peso, pesoPlain, toast, clear, isTowelItem, entryTowelNo } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog, towelBadges } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const items = store.activeItems();
  root.appendChild(pageHead('New Refund', 'Cash returned when a guest gives an item back or checks out', null));

  let selected = items[0] || null;
  let qty = 1;
  let pickedGuest = null;
  let targetSeq = null; // the deposit transaction # this refund settles (deposit ↔ refund link)

  // Transaction-# badge shown at the top-right of the form once a deposit is targeted.
  const txBadge = el('div', { class: 'tx-badge', style: 'display:none' });
  function setTxBadge() {
    if (targetSeq) { txBadge.style.display = ''; txBadge.textContent = 'Deposit #' + targetSeq; }
    else { txBadge.style.display = 'none'; txBadge.textContent = ''; }
  }

  const layout = el('div', { class: 'grid', style: 'grid-template-columns:340px 1fr;gap:18px;align-items:start' });

  // ---------------- left: outstanding guests ----------------
  const left = el('div', { class: 'card', style: 'position:sticky;top:16px' });
  left.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: 'Outstanding' }), el('span', { class: 'sub', text: 'deposits held' })]));
  const search = el('input', { class: 'input', placeholder: 'Search guest, room or transaction #…', autocomplete: 'off' });
  left.appendChild(search);
  const listWrap = el('div', { class: 'mt', style: 'max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:8px' });
  left.appendChild(listWrap);

  function renderList() {
    clear(listWrap);
    const q = search.value.trim();
    const ql = q.toLowerCase();
    const isNum = /^\d+$/.test(q);
    // Most recent deposit first (recency-prioritised), then filter by guest/room/tx #.
    let data = store.outstandingByGuest().slice().sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
    if (q) {
      data = data.filter((g) =>
        g.guest.toLowerCase().includes(ql) || g.room.toLowerCase().includes(ql) ||
        (isNum && (g.openDeposits || []).some((d) => String(d.seq).includes(q))));
    }
    if (!data.length) {
      listWrap.appendChild(el('div', { class: 'empty', style: 'padding:24px 8px' }, [el('div', { class: 'ic', text: '✓' }), el('p', { text: q ? 'No matching deposits.' : 'No outstanding deposits.' })]));
      return;
    }
    for (const g of data) {
      // Clickable transaction #s — click one to refund that specific deposit; click
      // the card to refund the most recent. Highlight a # matched by the search.
      const seqPills = (g.openDeposits || []).slice(0, 8).map((d) => el('span', {
        class: 'tag dep seq-pill' + (isNum && String(d.seq).includes(q) ? ' match' : ''),
        title: 'Refund deposit #' + d.seq,
        onClick: (ev) => { ev.stopPropagation(); pickDeposit(d, g); toast(`Loaded deposit #${d.seq}`, 'ok'); },
        text: '#' + d.seq,
      }));
      const card = el('div', {
        class: 'guest-card', style: 'cursor:pointer',
        onClick: () => pick(g),
      }, [
        el('div', {}, [
          el('div', { class: 'g-name', text: g.guest || '(no name)' }),
          el('div', { class: 'g-room', text: g.room ? `Room ${g.room}` : '' }),
          el('div', { class: 'g-items', text: Object.entries(g.items).filter(([, v]) => v > 0).map(([k, v]) => `${k} ₱${pesoPlain(v)}`).join(' · ') }),
          towelBadges(g.towels),
          seqPills.length ? el('div', { class: 'flex gap aic', style: 'flex-wrap:wrap;gap:5px;margin-top:6px' }, seqPills) : null,
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

  // Lost-towel path: the guest doesn't return the towel. They forfeit the deposit
  // they already paid (kept, not refunded) and aren't charged extra — so NO cash
  // moves. We just flag the towel lost; the deposit value is tracked as an indicator.
  const lostCheck = el('input', { type: 'checkbox' });
  const lostField = el('div', { class: 'field', style: 'background:var(--out-50);border:1px solid var(--out);border-radius:10px;padding:10px 12px' }, [
    el('label', { class: 'flex aic gap', style: 'cursor:pointer;margin:0' }, [lostCheck, 'Towel not returned (reported lost)']),
    el('div', { class: 'hint', style: 'margin-top:6px', text: 'No cash changes — the guest forfeits the deposit (they don\'t get it back, and pay nothing extra). The towel is flagged lost.' }),
  ]);
  function syncTowel() {
    const isTowel = !!(selected && isTowelItem(selected.name));
    towelField.style.display = isTowel ? '' : 'none';
    lostField.style.display = isTowel ? '' : 'none';
    if (!isTowel) lostCheck.checked = false;
    syncLost();
  }
  function syncLost() { updatePreview(); }
  lostCheck.addEventListener('change', syncLost);

  function unit() { return parseFloat(unitInput.value || '0'); }
  function amount() { return Math.round(unit() * qty * 100) / 100; }
  function isLost() { return !!(selected && isTowelItem(selected.name) && lostCheck.checked); }

  const previewVal = el('div', { class: 'val', text: '₱0.00' });
  const previewLab = el('div', { class: 'lab', style: 'color:var(--out-700)', text: 'Refund amount (auto)' });
  const heldNote = el('div', { class: 'muted', style: 'font-size:.78rem' });
  function updatePreview() {
    if (isLost()) {
      previewLab.textContent = 'Towel lost — no cash change';
      previewVal.textContent = peso(0);
      heldNote.innerHTML = `Deposit <b>${peso(amount())}</b> forfeited (kept, not refunded) · COH unchanged`;
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

  // Target a specific deposit transaction: mirror its item, amount and towel #, and
  // link the refund to it (refundsSeq) so deposit and refund share the same #.
  function pickDeposit(dep, g) {
    pickedGuest = g || null;
    targetSeq = dep ? dep.seq : null;
    if (g) { guestInput.value = g.guest; roomInput.value = g.room; }
    if (dep) {
      const match = items.find((it) => it.id === dep.itemTypeId) || items.find((it) => it.name === dep.itemName);
      if (match) { selected = match; paintChips(); }
      qty = 1; qtyInput.value = 1;
      unitInput.value = dep.amount;            // refund exactly this deposit's amount
      towelInput.value = dep.towelNo || '';
    } else if (g) {
      // No specific deposit — fall back to the most-held item type for this guest.
      const heldItemName = Object.entries(g.items).find(([, v]) => v > 0);
      const match = heldItemName && items.find((it) => it.name === heldItemName[0]);
      if (match) { selected = match; unitInput.value = match.defaultAmount; paintChips(); }
      towelInput.value = (g.towels || []).join(', ');
    }
    towelHint.textContent = towelInput.value ? 'auto-filled from deposit — edit if only some came back' : 'tag number on the returned towel';
    setTxBadge();
    syncTowel();
    updatePreview();
  }

  // Clicking a guest targets their MOST RECENT open deposit transaction.
  function pick(g) {
    const dep = (g.openDeposits && g.openDeposits[0]) || null;
    pickDeposit(dep, g);
    toast(dep ? `Loaded ${g.guest} · deposit #${dep.seq}` : `Loaded ${g.guest}`, 'ok');
  }

  form.appendChild(el('div', { class: 'field' }, [
    el('div', { class: 'flex between aic', style: 'margin-bottom:8px;gap:10px' }, [el('label', { text: 'Item being returned', style: 'margin:0' }), txBadge]),
    chipWrap,
  ]));
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
      refundsSeq: targetSeq,
    });
    toast(`Refund recorded · ${peso(e.amount)}${targetSeq ? ` · deposit #${targetSeq}` : ''} · COH now ${peso(store.coh())}`, 'ok');
    ctx.navigate('dashboard');
  }

  function doLost() {
    store.recordTowelLoss({
      itemTypeId: selected.id, guest: guestInput.value, room: roomInput.value,
      towelNo: towelInput.value.trim(), deposit: amount(),
      refundsSeq: targetSeq,
    });
    toast(`Towel ${towelInput.value.trim()} marked lost · no cash change`, 'ok');
    ctx.navigate('towels');
  }

  submit.addEventListener('click', () => {
    if (!selected) { toast('Pick an item first', 'warn'); return; }
    if (!guestInput.value.trim() && !roomInput.value.trim()) { toast('Enter a guest name or room #', 'warn'); return; }
    if (amount() <= 0) { toast('Amount must be greater than 0', 'warn'); return; }
    // Lost towel: no cash moves — the guest forfeits the deposit. Confirm, then flag.
    if (isLost()) {
      if (!towelInput.value.trim()) { toast('Enter the towel number that was lost', 'warn'); return; }
      confirmDialog({
        title: 'Record lost towel?',
        sub: `Towel ${towelInput.value.trim()} will be flagged LOST. ${guestInput.value.trim() || roomInput.value.trim()} forfeits the ${peso(amount())} deposit — it stays in the drawer, no refund, no extra charge. Cash On Hand does not change.`,
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

  // Arrived from the ledger's clickable transaction # → target that deposit directly.
  const wantSeq = ctx.args && ctx.args.depositSeq;
  if (wantSeq != null) {
    const dep = store.entryBySeq(wantSeq);
    if (dep && dep.kind === 'deposit') {
      const gk = (s) => (s || '').toUpperCase().trim();
      const g = store.outstandingByGuest().find((x) => gk(x.guest) === gk(dep.guest) && gk(x.room) === gk(dep.room))
        || { guest: dep.guest, room: dep.room, held: dep.amount, items: {}, towels: [], openDeposits: [] };
      pickDeposit({ seq: dep.seq, ts: dep.ts, itemTypeId: dep.itemTypeId, itemName: dep.itemName, amount: dep.amount, towelNo: entryTowelNo(dep) }, g);
      toast(`Refunding deposit #${dep.seq} · ${dep.guest || dep.room || ''}`, 'ok');
    }
  }
  return root;
}
