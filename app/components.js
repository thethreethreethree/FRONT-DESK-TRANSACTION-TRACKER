// components.js — shared UI primitives: modal, confirm, manager-PIN gate.
import { el, $, clear } from './util.js';
import { store } from './store.js';

export function openModal({ title, sub, body, actions = [], wide = false }) {
  const back = el('div', { class: 'modal-back' });
  const modal = el('div', { class: 'modal' + (wide ? ' wide' : '') });
  if (title) modal.appendChild(el('h3', { text: title }));
  if (sub) modal.appendChild(el('p', { class: 'm-sub', text: sub }));
  if (body) modal.appendChild(body);
  const foot = el('div', { class: 'm-foot' });
  const close = () => back.remove();
  for (const a of actions) {
    foot.appendChild(el('button', {
      class: 'btn ' + (a.kind || ''),
      text: a.label,
      onClick: () => { if (a.onClick) a.onClick(close); else close(); },
    }));
  }
  if (actions.length) modal.appendChild(foot);
  back.appendChild(modal);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(back);
  const focusable = modal.querySelector('input, select, textarea, button');
  if (focusable) setTimeout(() => focusable.focus(), 50);
  return { close, modal };
}

export function confirmDialog({ title, sub, confirmLabel = 'Confirm', kind = 'primary', onConfirm }) {
  openModal({
    title, sub,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: confirmLabel, kind, onClick: (close) => { close(); onConfirm && onConfirm(); } },
    ],
  });
}

// Run `action` only after a valid Manager PIN. If already logged in as manager,
// runs immediately. Used to gate voids, settings, exports, staff mgmt.
export function managerGate(action, { reason } = {}) {
  if (store.isManager()) { action(); return; }
  const inp = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'Manager PIN', autocomplete: 'off' });
  const errp = el('p', { class: 'hint', style: 'color:var(--danger);min-height:16px' });
  const body = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { text: 'This action needs a manager.' }), inp, errp]),
  ]);
  const tryUnlock = (close) => {
    if (store.constructor.verifyPin(inp.value, store.config.managerPin)) {
      close();
      action();
    } else {
      errp.textContent = 'Incorrect PIN.';
      inp.value = ''; inp.focus();
    }
  };
  const { close } = openModal({
    title: 'Manager approval',
    sub: reason || 'Enter the Manager PIN to continue.',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Unlock', kind: 'primary', onClick: tryUnlock },
    ],
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(close); });
}

// Render a guest's towel tag(s) as small badges (or null when there are none).
// Shared by the outstanding list and the refund picker so the look is consistent.
export function towelBadges(towels) {
  if (!towels || !towels.length) return null;
  return el('div', { class: 'flex gap aic', style: 'flex-wrap:wrap;gap:6px;margin-top:5px' },
    [el('span', { class: 'g-room', text: `Towel${towels.length > 1 ? 's' : ''}:` })]
      .concat(towels.map((t) => el('span', { class: 'tag towel', text: t }))));
}

// section header helper
export function pageHead(title, subtitle, right) {
  const wrap = el('div', { class: 'topbar' });
  const crumbs = el('div', { class: 'crumbs' }, [
    el('h1', { text: title }),
    subtitle ? el('p', { text: subtitle }) : null,
  ]);
  wrap.appendChild(crumbs);
  if (right) wrap.appendChild(right);
  return wrap;
}
