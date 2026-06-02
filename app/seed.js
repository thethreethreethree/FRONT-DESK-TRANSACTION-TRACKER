// seed.js — optional demo data drawn from the real Feb 3-9 front-desk sheet.
// Loaded only when the operator chooses "Start with sample data" so they can
// see the dashboard, outstanding list, and ledger populated immediately.

import { nowISO } from './util.js';

// Compact transaction script. d = deposit, r = refund.
// [kind, itemName, qty, guest, room, pax, shift, dayOffset, staff]
// dayOffset counts back from "today" so the demo always looks recent.
const SCRIPT = [
  // ---- earlier deposits still partly outstanding ----
  ['d', 'Towel', 5, 'Charlie H.', '309', 5, 'AM', 6, 'TC'],
  ['d', 'Towel', 1, 'Rebeca D.', '303', 1, 'AM', 6, 'TC'],
  ['d', 'Towel', 1, 'James M.', '209', 1, 'AM', 6, 'TC'],
  ['d', 'Padlock', 1, 'Burhan Kayaci', '303', 1, 'AM', 6, 'TC'],
  ['d', 'Towel', 3, 'Roxana', '207', 3, 'AM', 6, 'TC'],
  ['d', 'Padlock', 1, 'Roxana', '207', 1, 'AM', 6, 'TC'],
  ['d', 'Towel', 1, 'Sahra', '402', 1, 'AM', 6, 'TC'],
  ['d', 'Towel', 2, 'Ella Caton', '408', 2, 'PM', 6, 'JG'],
  ['d', 'Hair Dryer', 1, 'Roxana', '207', 1, 'PM', 6, 'JG'],
  ['d', 'Towel', 2, 'Christian S.', '209', 2, 'PM', 5, 'JG'],
  ['d', 'Towel', 1, 'Marie', '402', 1, 'PM', 5, 'JG'],
  ['d', 'Towel', 3, 'Mia Sultana', '402', 3, 'PM', 5, 'JG'],
  ['d', 'Towel', 2, 'Julia Kindworth', '303', 2, 'PM', 5, 'JG'],
  ['d', 'Towel', 1, 'Joel Blais', '403', 1, 'PM', 4, 'AM'],
  ['d', 'Towel', 2, 'Rushil Shah', '408', 2, 'PM', 4, 'MA'],
  ['d', 'Towel', 3, 'Seamus', '403', 3, 'PM', 3, 'MA'],
  ['d', 'Hair Dryer', 1, 'Roxanne', '306', 1, 'PM', 3, 'MA'],
  ['d', 'Towel', 2, 'Georgia Mckenzie', '208', 2, 'PM', 3, 'MA'],
  ['d', 'Towel', 2, 'Meike Rasink', '304', 2, 'PM', 2, 'TC'],
  ['d', 'Towel', 1, 'Wyeth', '303', 1, 'AM', 2, 'TC'],
  ['d', 'Towel', 6, 'Wyeth', '303', 6, 'AM', 2, 'TC'],
  ['d', 'Towel', 2, 'Adriana', '402', 2, 'PM', 1, 'JG'],
  ['d', 'Padlock', 1, 'Adriana', '402', 1, 'PM', 1, 'JG'],
  ['d', 'Towel', 2, 'Francesca', '207', 2, 'PM', 1, 'JG'],
  ['d', 'Padlock', 1, 'Francesca', '207', 1, 'PM', 1, 'JG'],
  ['d', 'Towel', 2, 'Tashy', '309', 2, 'PM', 1, 'JG'],
  ['d', 'Towel', 2, 'Monique', '409', 2, 'PM', 1, 'JG'],
  ['d', 'Towel', 2, 'Hanna B.', '307', 2, 'AM', 0, 'TC'],
  ['d', 'Padlock', 1, 'Hanna B.', '307', 1, 'AM', 0, 'TC'],
  ['d', 'Towel', 1, 'Clara', '202', 1, 'AM', 0, 'TC'],

  // ---- refunds (returns / check-outs) ----
  ['r', 'Towel', 5, 'Charlie H.', '309', 5, 'AM', 5, 'JG'],
  ['r', 'Towel', 1, 'Samuel O.', '204', 1, 'AM', 5, 'JG'],
  ['r', 'Towel', 1, 'James M.', '209', 1, 'AM', 4, 'AM'],
  ['r', 'Towel', 3, 'Roxana', '207', 3, 'PM', 3, 'MA'],
  ['r', 'Hair Dryer', 1, 'Roxana', '207', 1, 'PM', 3, 'MA'],
  ['r', 'Towel', 1, 'Marie', '402', 1, 'AM', 2, 'TC'],
  ['r', 'Towel', 2, 'Christian S.', '209', 2, 'AM', 2, 'TC'],
  ['r', 'Towel', 2, 'Rushil Shah', '408', 2, 'PM', 1, 'JG'],
  ['r', 'Towel', 3, 'Mia Sultana', '402', 3, 'PM', 1, 'JG'],
];

function dateForOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  // spread times within the shift so ordering looks natural
  d.setHours(9 + (offset % 3) * 4, 15 + (offset * 7) % 40, 0, 0);
  return d.toISOString();
}

export function loadDemoData(store) {
  // ensure items exist (setup seeds them, but be safe)
  if (!store.itemTypes.length) {
    store.addItem({ name: 'Towel', defaultAmount: 200 });
    store.addItem({ name: 'Padlock', defaultAmount: 100 });
    store.addItem({ name: 'Hair Dryer', defaultAmount: 500 });
  }
  const byName = {};
  for (const it of store.activeItems()) byName[it.name] = it;

  for (const [kind, itemName, qty, guest, room, pax, shift, dayOffset, staff] of SCRIPT) {
    const item = byName[itemName];
    if (!item) continue;
    const ts = dateForOffset(dayOffset);
    const common = {
      itemTypeId: item.id, qty, guest, room, pax,
    };
    // temporarily set session staff so attribution looks right
    const prev = store.session;
    store.session = { name: staff, role: 'staff' };
    // create entry with a backdated timestamp + matching shift
    if (kind === 'd') {
      const e = store.addDeposit(common);
      backdate(store, e, ts, shift);
    } else {
      const e = store.addRefund(common);
      backdate(store, e, ts, shift);
    }
    store.session = prev;
  }
  store.verifyIntegrity();
  store.save();
}

// Re-stamp a just-created entry's ts/shift and recompute its hash + everything
// after it, so the demo can show historical dates while keeping the chain valid.
function backdate(store, entry, ts, shiftLabel) {
  entry.ts = ts;
  entry.businessDate = ts.slice(0, 10);
  entry.shiftLabel = shiftLabel;
  rechain(store);
}

// Recompute the whole hash chain (used only by the demo loader / never in
// normal operation — real entries are immutable once appended).
import { sha256, stableStringify } from './util.js';
const GENESIS = '0'.repeat(64);
function rechain(store) {
  let prev = GENESIS;
  for (const e of store.ledger) {
    const { hash, ...rest } = e;
    rest.prevHash = prev;
    e.prevHash = prev;
    e.hash = sha256(stableStringify(rest));
    prev = e.hash;
  }
}
