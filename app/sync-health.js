// sync-health.js — device-local "internet outage / sync fault" watchdog + banner.
//
// The front desk runs several devices that all rely on GitHub sync so every device
// sees the same records. When the internet drops or a backup push fails, a deposit
// or refund is saved on THIS device only — not backed up, not visible elsewhere, and
// lost if the device is closed or cleared before it reconnects. That is exactly what
// produced the missed CAMERON and SAM refunds. This watchdog surfaces a persistent,
// unmissable banner the moment sync is at risk, and also flags data-level
// discrepancies (a failed integrity check or a cash total that no longer reconciles)
// that a mid-write interruption can cause.
//
// Everything here is per-device by design: sync health must NOT be written into
// state.config (a remote pull would overwrite it), so we keep it in memory only.
import { el } from './util.js';
import { store, APP_BUILD } from './store.js';
import { tv } from './travelista.js';
import * as gh from './github.js';

let bannerEl = null;
let opts = {};
const H = {
  online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  syncFailing: false, // the last auto-backup attempt threw / returned false
  lastError: '',
  integrityOk: true,
  reconGap: 0, // |beginning + held − over + adj − coh|; >0 means the books don't tie out
  tvIntegrityOk: true, // the travelista chain gets the same watch as the ledger
  tvBalances: true,    // opening + owed + commission held == the travelista cash box
  staleBuild: '',      // a newer build wrote the backup — THIS device needs refreshing
};

// A device left on old code is the one thing that can still break multi-device
// sync (it would write without merging). Backups carry the build that wrote them,
// so a device can notice another has newer code and say so plainly, instead of
// everyone assuming every computer updated itself.
export function noteRemoteBuild(build) {
  H.staleBuild = (build && String(build) > APP_BUILD) ? String(build) : '';
  render();
}

function syncConfigured() {
  const g = (store.config && store.config.github) || {};
  return gh.hasToken() && !!g.owner && !!g.repo;
}

// --- signals fed in from main.js ------------------------------------------------
export function recordSync(ok, errMsg) {
  H.syncFailing = !ok;
  if (!ok && errMsg) H.lastError = String(errMsg);
  render();
}

// Recompute the data-integrity + reconciliation guards. Called after the initial
// load and after adopting a remote pull (an interrupted write shows up here).
export function checkData() {
  try {
    H.integrityOk = store.verifyIntegrity().ok;
    const r = store.reconciliation();
    H.reconGap = Math.abs((r.beginning || 0) + r.held - r.over + (r.adjustments || 0) - r.coh);
  } catch (e) { /* keep last known values */ }
  // Second system, same guards — a corrupted or non-reconciling travelista record
  // must be as loud as a corrupted ledger, not silently wrong on a page nobody
  // happens to open. Guarded separately so a fault in one can't mask the other.
  try {
    H.tvIntegrityOk = store.verifyTravelistaIntegrity().ok;
    H.tvBalances = tv.entries.length ? tv.reconciliation().balances : true;
  } catch (e) { /* keep last known values */ }
  render();
}

// --- what to show ---------------------------------------------------------------
// Highest-priority active issue wins. `null` → all clear, banner hidden.
function evaluate() {
  if (!H.integrityOk) return {
    level: 'red', icon: '⛔',
    msg: 'System error: the ledger integrity check failed.',
    hint: 'A saved transaction may have been corrupted (e.g. a save cut off by an outage). Do not enter new transactions — contact the administrator.',
  };
  if (!H.tvIntegrityOk) return {
    level: 'red', icon: '⛔',
    msg: 'System error: the travelista record integrity check failed.',
    hint: 'A saved booking or payout may have been corrupted (e.g. a save cut off by an outage). Do not enter new bookings — contact the administrator.',
  };
  if (syncConfigured() && !H.online) return {
    level: 'red', icon: '⚠',
    msg: 'No internet — you are OFFLINE. New entries save on THIS device only and are not backed up or shared.',
    hint: 'If this device is closed or cleared before you reconnect, those entries can be lost. Reconnect, then confirm “Last sync” updates under Settings.',
  };
  if (syncConfigured() && H.syncFailing) return {
    level: 'amber', icon: '⚠',
    msg: 'Not backing up — the last sync to the cloud failed. Entries are saved here but are not reaching backup.',
    hint: 'Check the internet connection, or the GitHub token under Settings.' + (H.lastError ? ` (${H.lastError})` : ''),
  };
  if (H.staleBuild) return {
    level: 'amber', icon: '⟳',
    msg: 'This computer is running an OLD version of the app.',
    hint: `Another device is on ${H.staleBuild}. Refresh this one (Ctrl+Shift+R, or Cmd+Shift+R on Mac) — until you do, entries made here may not merge correctly with the other computers.`,
  };
  if (H.reconGap > 0.01) return {
    level: 'amber', icon: '⚠',
    msg: `Cash doesn’t reconcile — off by ₱${Math.round(H.reconGap).toLocaleString()}.`,
    hint: 'A deposit or refund may not have recorded correctly (a dropped connection can do this). Check Outstanding.',
  };
  if (!H.tvBalances) return {
    level: 'amber', icon: '⚠',
    msg: 'Travelista cash box doesn’t reconcile.',
    hint: 'What is owed to the travelista plus the commission held should equal the box. Check the recent bookings and payouts.',
  };
  return null;
}

function ensureBanner() {
  if (bannerEl && document.body.contains(bannerEl)) return bannerEl;
  bannerEl = document.createElement('div');
  bannerEl.id = 'sync-banner';
  document.body.insertBefore(bannerEl, document.body.firstChild);
  return bannerEl;
}

function render() {
  const b = ensureBanner();
  const issue = evaluate();
  if (!issue) {
    b.className = '';
    b.style.display = 'none';
    document.body.classList.remove('has-sync-banner');
    document.documentElement.style.removeProperty('--sync-banner-h');
    return;
  }
  b.className = `show ${issue.level}`;
  b.style.display = 'block';
  b.replaceChildren(el('div', { class: 'sb-inner' }, [
    el('span', { class: 'sb-ico', text: issue.icon }),
    el('span', { class: 'sb-txt' }, [
      el('b', { text: issue.msg }),
      issue.hint ? el('span', { class: 'sb-hint', text: ' ' + issue.hint }) : null,
    ]),
  ]));
  document.body.classList.add('has-sync-banner');
  // Offset the fixed banner's height so it never covers the sidebar/content.
  document.documentElement.style.setProperty('--sync-banner-h', b.offsetHeight + 'px');
}

// --- lifecycle ------------------------------------------------------------------
export function init(options = {}) {
  opts = options;
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      H.online = true;
      render();
      if (typeof opts.onReconnect === 'function') { try { opts.onReconnect(); } catch (e) { /* noop */ } }
    });
    window.addEventListener('offline', () => { H.online = false; render(); });
    // Re-measure the banner offset if the window resizes (text may re-wrap).
    window.addEventListener('resize', () => { if (document.body.classList.contains('has-sync-banner')) render(); });
  }
  checkData();
  render();
}
