// views/tv-dashboard.js — Travelista overview: the cash box, this period's
// sheet totals, what's still owed to the travelista, and recent bookings.
import { el, peso, pesoPlain, fmtTime } from '../util.js';
import { tv, periodFromKey, fmtYMD } from '../travelista.js';
import { store } from '../store.js';
import { pageHead } from '../components.js';

export function render(ctx) {
  const root = el('div');
  const integ = tv.integrity;

  root.appendChild(pageHead(
    `Travelista · ${store.session ? store.session.name : ''}`,
    `Van & boat bookings · ${new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })}`,
    el('div', { class: 'flex gap aic' }, [
      el('span', { class: `integrity ${integ.ok ? 'ok' : 'bad'}` }, [
        el('span', { class: 'dot' }),
        integ.ok ? 'Records verified' : `Integrity broken @ #${integ.brokenAtSeq}`,
      ]),
    ]),
  ));

  if (!tv.entries.length) {
    root.appendChild(el('div', { class: 'card elev', style: 'max-width:720px' }, [
      el('div', { class: 'card-h' }, [el('h3', { text: '🚐 Travelista Management & Tracking' })]),
      el('p', { class: 'muted', style: 'margin-top:0', html: 'Record every van/boat booking, split the fare into the <strong>travelista\'s share</strong> and the <strong>hostel\'s commission</strong>, and track the cash until it\'s remitted. Same rules as the front desk: append-only, hash-chained, nothing edited after the fact.' }),
      el('div', { class: 'flex gap wrap mt' }, [
        el('button', { class: 'btn primary lg', html: '＋&nbsp; Record the first booking', onClick: () => ctx.navigate('tv-booking') }),
        store.isManager() ? el('button', { class: 'btn lg', html: '⚙&nbsp; Rates & setup', onClick: () => ctx.navigate('tv-settings') }) : null,
      ]),
    ]));
    return root;
  }

  const cash = tv.cash();
  const rec = tv.reconciliation();
  const pKey = tv.currentPeriodKey();
  const period = periodFromKey(pKey);
  const pT = tv.totals(tv.inPeriod(pKey));

  // ---- cash hero + side stats ----
  const heroRow = el('div', { class: 'grid coh-row' });
  const parts = [];
  if (rec.beginning) parts.push(el('span', { html: `Opening <b>₱${pesoPlain(rec.beginning)}</b>` }));
  parts.push(el('span', { html: `${rec.beginning ? '+ ' : ''}Collected <b>₱${pesoPlain(rec.collected)}</b>` }));
  parts.push(el('span', { html: `− Paid out <b>₱${pesoPlain(rec.paidOut)}</b>` }));
  parts.push(el('span', { html: `= <b>₱${pesoPlain(cash)}</b>` }));
  heroRow.appendChild(el('div', { class: 'coh-hero' }, [
    el('div', { class: 'label', text: 'Travelista Cash Box' }),
    el('div', { class: 'amount', html: `<span class="cur">₱</span>${pesoPlain(cash)}` }),
    el('div', { class: 'lockline' }, ['🔒 Auto-calculated · separate from the front-desk drawer']),
    el('div', { class: 'formula' }, parts),
  ]));

  heroRow.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'stat' }, [
      el('span', { class: 'k', text: 'Owed to travelista' }),
      el('span', { class: 'v out', text: peso(rec.payable) }),
      el('span', { class: 'meta', text: 'collected, not yet remitted' }),
    ]),
    el('hr', { class: 'hr' }),
    el('div', { class: 'stat' }, [
      el('span', { class: 'k', text: 'Commission held' }),
      el('span', { class: 'v in', text: peso(rec.commissionHeld) }),
      el('span', { class: 'meta', text: 'hostel\'s earnings in the box' }),
    ]),
  ]));

  heroRow.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'stat' }, [
      el('span', { class: 'k', text: period ? period.label : 'This period' }),
      el('span', { class: 'v', text: peso(pT.collected) }),
      el('span', { class: 'meta', text: `${pT.bookings} booking${pT.bookings === 1 ? '' : 's'} · ${pT.pax} pax` }),
    ]),
    el('hr', { class: 'hr' }),
    el('div', { class: 'flex between aic' }, [
      el('span', { class: 'muted', style: 'font-size:.82rem', html: `Travelista <b>₱${pesoPlain(pT.share)}</b>` }),
      el('span', { class: 'muted', style: 'font-size:.82rem', html: `Commission <b>₱${pesoPlain(pT.commission)}</b>` }),
    ]),
    el('button', { class: 'btn sm mt', text: 'Open the sheet →', onClick: () => ctx.navigate('tv-bookings') }),
  ]));
  root.appendChild(heroRow);

  // The identity that keeps the box honest. Shown only when it FAILS — a silent
  // green tick teaches nothing, but a mismatch means a record is wrong.
  if (!rec.balances) {
    root.appendChild(el('div', { class: 'pill-warn mt', html:
      `<strong>Cash box doesn't reconcile.</strong> Opening ₱${pesoPlain(rec.beginning)} + owed ₱${pesoPlain(rec.payable)} + commission ₱${pesoPlain(rec.commissionHeld)} should equal the box (₱${pesoPlain(cash)}). Check the recent payouts.` }));
  }

  // ---- quick actions ----
  root.appendChild(el('div', { class: 'card mt-lg' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Quick actions' })]),
    el('div', { class: 'quick' }, [
      el('button', { class: 'btn in', onClick: () => ctx.navigate('tv-booking') },
        [el('span', { class: 'ic', text: '＋' }), el('span', { text: 'New Booking' }), el('span', { class: 'sub', text: 'guest buys a ticket' })]),
      el('button', { class: 'btn out', onClick: () => ctx.navigate('tv-payouts') },
        [el('span', { class: 'ic', text: '↗' }), el('span', { text: 'Remit / Payout' }), el('span', { class: 'sub', text: 'pay the travelista' })]),
      el('button', { class: 'btn', onClick: () => ctx.navigate('tv-reports') },
        [el('span', { class: 'ic', text: '📊' }), el('span', { text: 'Reports' }), el('span', { class: 'sub', text: 'by period, booker, route' })]),
    ]),
  ]));

  // ---- recent bookings ----
  const recent = tv.entries.slice(-8).reverse();
  const card = el('div', { class: 'card mt-lg' }, [
    el('div', { class: 'card-h' }, [
      el('h3', { text: 'Recent activity' }),
      el('button', { class: 'btn ghost sm', text: 'View all →', onClick: () => ctx.navigate('tv-bookings') }),
    ]),
  ]);
  const list = el('div');
  for (const e of recent) {
    const voided = tv.isReversed(e.id);
    const isBooking = e.kind === 'booking';
    list.appendChild(el('div', { class: 'flex between aic', style: 'padding:9px 2px;border-bottom:1px solid var(--line)' }, [
      el('div', {}, [
        el('div', { class: 'flex gap aic', style: 'gap:8px' }, [
          el('span', { class: `tag ${isBooking ? 'dep' : e.kind === 'payout' ? 'ref' : 'rev'}`, text: isBooking ? 'booking' : e.kind }),
          el('strong', { text: e.guest || (e.payee ? e.payee : '—') }),
          e.destination ? el('span', { class: 'muted', text: e.destination }) : null,
        ]),
        el('div', { class: 'muted', style: 'font-size:.76rem;margin-top:2px',
          text: isBooking
            ? `${e.pax} pax · dep ${fmtYMD(e.departureDate)} · by ${e.bookedBy || '—'} · ${e.staff} · ${fmtTime(e.ts)}`
            : `${e.payoutType || ''}${e.method ? ' · ' + e.method : ''} · ${e.staff} · ${fmtTime(e.ts)}` }),
      ]),
      el('div', { class: e.direction > 0 ? 'amt-in' : 'amt-out', style: voided ? 'text-decoration:line-through;opacity:.5' : '',
        text: `${e.direction > 0 ? '+' : '−'}${pesoPlain(e.amount)}` }),
    ]));
  }
  card.appendChild(list);
  root.appendChild(card);
  return root;
}
