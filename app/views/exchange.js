// views/exchange.js — Towel Exchange. A guest swaps one towel for another: the old
// towel returns to inventory, the new one goes out. NO cash moves (the deposit is
// untouched); it's recorded in the ledger and the inventory, linked to the deposit's
// transaction #. Mirrors the refund UI: outstanding deposits on the left, form right.
import { el, peso, pesoPlain, toast, clear, isTowelItem } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog, towelBadges } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const items = store.activeItems();
  const towelItem = items.find((it) => isTowelItem(it.name)) || items[0] || null;
  root.appendChild(pageHead('Towel Exchange', 'Swap a guest\'s towel for another — no cash changes, the deposit stays as is', null));

  let targetSeq = null;     // the deposit this exchange belongs to
  let pickedGuest = null;

  const layout = el('div', { class: 'grid', style: 'grid-template-columns:340px 1fr;gap:18px;align-items:start' });

  // ---------------- left: guests currently holding towels ----------------
  const left = el('div', { class: 'card', style: 'position:sticky;top:16px' });
  left.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: 'Holding towels' }), el('span', { class: 'sub', text: 'pick who is swapping' })]));
  const search = el('input', { class: 'input', placeholder: 'Search guest, room or transaction #…', autocomplete: 'off' });
  left.appendChild(search);
  const listWrap = el('div', { class: 'mt', style: 'max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:8px' });
  left.appendChild(listWrap);

  function renderList() {
    clear(listWrap);
    const q = search.value.trim();
    const ql = q.toLowerCase();
    const isNum = /^\d+$/.test(q);
    // Only guests who currently hold a towel; most recent first.
    let data = store.outstandingByGuest().filter((g) => (g.towels || []).length)
      .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
    if (q) {
      data = data.filter((g) =>
        g.guest.toLowerCase().includes(ql) || g.room.toLowerCase().includes(ql) ||
        (isNum && (g.openDeposits || []).some((d) => String(d.seq).includes(q))));
    }
    if (!data.length) {
      listWrap.appendChild(el('div', { class: 'empty', style: 'padding:24px 8px' }, [el('div', { class: 'ic', text: '🧺' }), el('p', { text: q ? 'No matching guests.' : 'No towels currently out.' })]));
      return;
    }
    for (const g of data) {
      const seqPills = (g.openDeposits || []).filter((d) => isTowelItem(d.itemName)).slice(0, 8).map((d) => el('span', {
        class: 'tag dep seq-pill' + (isNum && String(d.seq).includes(q) ? ' match' : ''),
        title: 'Exchange a towel on deposit #' + d.seq,
        onClick: (ev) => { ev.stopPropagation(); pickDeposit(d, g); toast(`Loaded deposit #${d.seq}`, 'ok'); },
        text: '#' + d.seq,
      }));
      listWrap.appendChild(el('div', { class: 'guest-card', style: 'cursor:pointer', onClick: () => pick(g) }, [
        el('div', {}, [
          el('div', { class: 'g-name', text: g.guest || '(no name)' }),
          el('div', { class: 'g-room', text: g.room ? `Room ${g.room}` : '' }),
          towelBadges(g.towels),
          seqPills.length ? el('div', { class: 'flex gap aic', style: 'flex-wrap:wrap;gap:5px;margin-top:6px' }, seqPills) : null,
        ]),
        el('div', { class: 'g-held', text: peso(g.held) }),
      ]));
    }
  }
  search.addEventListener('input', renderList);

  // ---------------- right: exchange form ----------------
  const form = el('div', { class: 'card elev' });
  const txBadge = el('div', { class: 'tx-badge', style: 'display:none' });
  function setTxBadge() {
    if (targetSeq) { txBadge.style.display = ''; txBadge.textContent = 'Deposit #' + targetSeq; }
    else { txBadge.style.display = 'none'; }
  }

  const guestInput = el('input', { class: 'input', placeholder: 'guest name', autocomplete: 'off' });
  const roomInput = el('input', { class: 'input', placeholder: 'room #', autocomplete: 'off' });
  const oldInput = el('input', { class: 'input', placeholder: 'towel being returned', autocomplete: 'off' });
  const oldHint = el('div', { class: 'hint', text: 'the towel coming back from the guest' });
  const newInput = el('input', { class: 'input', placeholder: 'new towel going out', autocomplete: 'off' });
  const noteInput = el('input', { class: 'input', placeholder: 'optional', autocomplete: 'off' });

  function pickDeposit(dep, g) {
    pickedGuest = g || null;
    targetSeq = dep ? dep.seq : null;
    if (g) { guestInput.value = g.guest; roomInput.value = g.room; }
    oldInput.value = dep ? (dep.towelNo || '') : (g ? (g.towels || []).join(', ') : '');
    oldHint.textContent = oldInput.value ? 'auto-filled — the towel(s) this guest currently holds' : 'the towel coming back from the guest';
    newInput.value = '';
    setTxBadge();
    setTimeout(() => newInput.focus(), 40);
  }
  function pick(g) {
    // Target the guest's most recent open TOWEL deposit.
    const dep = (g.openDeposits || []).find((d) => isTowelItem(d.itemName)) || null;
    pickDeposit(dep, g);
    toast(dep ? `Loaded ${g.guest} · deposit #${dep.seq}` : `Loaded ${g.guest}`, 'ok');
  }

  form.appendChild(el('div', { class: 'flex between aic', style: 'gap:10px;margin-bottom:14px' }, [
    el('div', {}, [el('h3', { style: 'margin:0', text: 'Exchange towel' }), el('p', { class: 'muted', style: 'margin:2px 0 0;font-size:.84rem', text: 'No cash — the deposit balance stays the same' })]),
    txBadge,
  ]));
  form.appendChild(el('div', { class: 'row2' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Guest name' }), guestInput]),
    el('div', { class: 'field' }, [el('label', { text: 'Room #' }), roomInput]),
  ]));
  form.appendChild(el('div', { class: 'row2' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Towel returned (old)' }), oldInput, oldHint]),
    el('div', { class: 'field' }, [el('label', { text: 'New towel (out)' }), newInput, el('div', { class: 'hint', text: 'the replacement towel handed to the guest' })]),
  ]));
  form.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Note (optional)' }), noteInput]));
  form.appendChild(el('div', { class: 'pill', html: 'The old towel returns to <strong>available</strong> inventory and the new towel is marked <strong>out</strong>. The cash deposit is not refunded or changed.' }));

  const submit = el('button', { class: 'btn primary lg block mt-lg', html: '⇄&nbsp; Record exchange' });
  form.appendChild(submit);

  function doExchange() {
    store.recordTowelExchange({
      itemTypeId: (towelItem && towelItem.id) || null,
      guest: guestInput.value, room: roomInput.value,
      oldTowelNo: oldInput.value, newTowelNo: newInput.value, exchangesSeq: targetSeq,
      note: noteInput.value,
    });
    toast(`Exchanged #${oldInput.value.trim()} → #${newInput.value.trim()}${targetSeq ? ` · deposit #${targetSeq}` : ''}`, 'ok');
    ctx.navigate('towels');
  }

  submit.addEventListener('click', () => {
    const oldNo = oldInput.value.trim(), newNo = newInput.value.trim();
    if (!guestInput.value.trim() && !roomInput.value.trim()) { toast('Pick a guest or enter a name/room', 'warn'); return; }
    if (!oldNo) { toast('Enter the towel being returned', 'warn'); return; }
    if (!newNo) { toast('Enter the new towel going out', 'warn'); return; }
    if (oldNo.toUpperCase() === newNo.toUpperCase()) { toast('Old and new towel are the same', 'warn'); return; }
    confirmDialog({
      title: 'Record towel exchange?',
      sub: `${guestInput.value.trim() || roomInput.value.trim()} swaps towel #${oldNo} → #${newNo}. #${oldNo} returns to inventory, #${newNo} goes out. No cash changes${targetSeq ? ` (deposit #${targetSeq} unchanged)` : ''}.`,
      confirmLabel: 'Record exchange', kind: 'primary', onConfirm: doExchange,
    });
  });

  layout.appendChild(left);
  layout.appendChild(form);
  root.appendChild(layout);
  renderList();

  // Arrived from a ledger/refund deep-link with a target deposit.
  const wantSeq = ctx.args && ctx.args.depositSeq;
  if (wantSeq != null) {
    const dep = store.entryBySeq(wantSeq);
    if (dep && dep.kind === 'deposit') {
      const gk = (s) => (s || '').toUpperCase().trim();
      const g = store.outstandingByGuest().find((x) => gk(x.guest) === gk(dep.guest) && gk(x.room) === gk(dep.room));
      if (g) { const d = (g.openDeposits || []).find((x) => x.seq === dep.seq); pickDeposit(d || null, g); }
    }
  }
  return root;
}
