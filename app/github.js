// github.js — push the ledger to a GitHub repo via the Contents API.
// Every backup is a commit, so Git history becomes a durable, dated,
// tamper-evident audit trail that lives OFF the front-desk device.
//
// The token is stored in its OWN localStorage key (never inside the exported
// backup JSON or the app state), and should be a FINE-GRAINED PAT scoped to a
// single repo with only "Contents: Read and write".

import { store, APP_BUILD } from './store.js';
import { toast, nowISO } from './util.js';

const TOKEN_KEY = 'fdtt_gh_token';

export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
export function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
export function hasToken() { return !!getToken(); }

// UTF-8 safe base64 (GitHub wants base64-encoded file content).
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function api(path, opts = {}) {
  return fetch('https://api.github.com' + path, {
    ...opts,
    cache: 'no-store', // always read the CURRENT sha — a cached/stale sha causes 409 conflicts
    headers: {
      Authorization: 'Bearer ' + getToken(),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
}

function cfg() { return store.config.github || {}; }
function cleanPath(p) { return (p || 'data/ledger-backup.json').replace(/^\/+/, ''); }

export async function testConnection() {
  const g = cfg();
  if (!getToken()) throw new Error('Paste a GitHub token first.');
  if (!g.owner || !g.repo) throw new Error('Set owner and repo first.');
  const res = await api(`/repos/${g.owner}/${g.repo}`);
  if (res.status === 401) throw new Error('Token rejected (401). Check it has not expired.');
  if (res.status === 404) throw new Error('Repo not found, or token lacks access to it.');
  if (!res.ok) throw new Error('GitHub error ' + res.status);
  const j = await res.json();
  if (!j.permissions || !j.permissions.push) throw new Error('Token can read but not WRITE to this repo. Grant "Contents: Read and write".');
  return j.full_name;
}

// Commit the current ledger snapshot. Returns the commit URL.
// SERIALIZED: a manual "Back up now" and the auto-sync must never PUT at the same
// moment — they'd both read the same file SHA, one would win, and the other would
// 409 ("does not match <sha>"). Concurrent calls queue behind the in-flight one.
let _busy = null;
export async function backupNow(reason = 'manual') {
  while (_busy) { try { await _busy; } catch (e) { /* prior backup's error is its caller's */ } }
  _busy = _commitBackup(reason);
  try { return await _busy; } finally { _busy = null; }
}

async function _commitBackup(reason) {
  const g = cfg();
  if (!getToken()) throw new Error('No GitHub token set.');
  if (!g.owner || !g.repo) throw new Error('Set owner and repo first.');
  const path = cleanPath(g.path);
  const branch = g.branch || 'main';

  // NEVER overwrite another device's work. If the file moved since we last wrote
  // it, someone else pushed: pull that state and MERGE it in before we write, so
  // what we PUT is the union of both. Without this the whole-file write is a
  // last-writer-wins race, which is exactly how 25 transactions ended up stranded
  // on one browser. Cheap in the common case — the SHA check is metadata only,
  // and the full file is fetched only when it has actually changed.
  await mergeRemoteBeforeWrite();

  const json = JSON.stringify(store.exportData(), null, 2);
  const content = b64utf8(json);
  const coh = store.coh();
  // The build goes in the commit subject so `git log` alone shows whether every
  // device is on current code — the quickest way to spot a stale one.
  const message = `Front desk backup (${reason}) · COH ₱${coh} · ${store.ledger.length} entries · ${APP_BUILD}`;

  // Up to 3 attempts: re-read the CURRENT file SHA each time, then PUT. On a SHA
  // conflict (409/422 — another device wrote in between) loop with a fresh SHA;
  // the file is large, so the read→write window is wide enough for a conflict to
  // slip in even when serialized locally. Any other error stops immediately.
  let putRes, txt = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha;
    const getRes = await api(`/repos/${g.owner}/${g.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
    else if (getRes.status !== 404) throw new Error('Could not read repo (' + getRes.status + ').');
    putRes = await api(`/repos/${g.owner}/${g.repo}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content, branch, sha }),
    });
    if (putRes.ok) break;
    if (putRes.status !== 409 && putRes.status !== 422) break; // not a conflict → report it
    txt = await putRes.text();
  }
  if (!putRes.ok) {
    if (!txt) txt = await putRes.text();
    let hint = ': ' + txt.slice(0, 140);
    if (putRes.status === 403) hint = ' — the token is missing "Contents: Read and write". Edit your fine-grained token (GitHub → Settings → Developer settings → Fine-grained tokens → this token → Repository permissions → Contents → Read and write), save, then try again.';
    else if (putRes.status === 401) hint = ' — token rejected (expired or invalid). Paste a fresh token.';
    else if (putRes.status === 409 || putRes.status === 422) hint = ' — another sync was writing at the same moment; your data still saved on the previous sync and the next change will catch up.';
    throw new Error('Backup failed (' + putRes.status + ')' + hint);
  }
  const j = await putRes.json();
  g.enabled = true;
  g.lastBackupAt = nowISO();
  g.lastBackupSha = j.content && j.content.sha;
  store.setConfig({ github: g });
  store._audit('backup.github', `Backup committed to ${g.owner}/${g.repo}@${branch} (${reason})`, { reason, coh, entries: store.ledger.length });
  return j.commit && j.commit.html_url;
}

// Pull-and-merge guard used immediately before a write (see _commitBackup).
// Returns quietly on any problem: a backup that cannot check the remote is still
// better attempted than skipped, and the merge itself fails safe.
export async function mergeRemoteBeforeWrite() {
  try {
    const g = cfg();
    const sha = await remoteFileSha();
    if (!sha || sha === g.lastBackupSha) return null; // nobody else has written since us
    const remote = await fetchRemoteState();
    if (!remote || !remote.payload || !remote.payload.state) return null;
    const merged = store.mergeRemote(remote.payload.state);
    if (merged) {
      const g2 = store.config.github || {};
      g2.lastBackupSha = remote.sha || g2.lastBackupSha;
      store.setConfig({ github: g2 });
      toast(`Merged ${merged.ledger} record(s) from another device`, 'ok');
    }
    return merged;
  } catch (e) { console.error('pre-write merge skipped', e); return null; }
}

// Fire-and-forget background backup (debounced auto-sync after every change).
// Never throws and stays SILENT on success — it runs on every mutation, so a
// toast each time would be noise. A failure shows one quiet warning. Requires a
// token + owner/repo; the caller decides WHETHER to auto-sync (config.autoSync).
let _warnedFail = false;
export async function autoBackup(reason) {
  const g = cfg();
  if (!getToken() || !g.owner || !g.repo) return false;
  try { await backupNow(reason); _warnedFail = false; return true; }
  catch (e) {
    console.error(e);
    if (!_warnedFail) { toast('GitHub sync failed: ' + e.message, 'err'); _warnedFail = true; }
    return false;
  }
}

// CHEAP change-check: return the current blob SHA of the backup file without
// downloading it (the Contents API returns metadata only for files > 1 MB — ours
// is several MB). Lets the live poll detect "did another device write?" cheaply,
// and only fetch the full ledger when the SHA actually changed. Token-only; returns
// null on no-token / error (caller falls back to a full fetch).
export async function remoteFileSha() {
  const g = cfg();
  if (!getToken() || !g.owner || !g.repo) return null;
  try {
    const branch = g.branch || 'main';
    const res = await api(`/repos/${g.owner}/${g.repo}/contents/${cleanPath(g.path)}?ref=${encodeURIComponent(branch)}`);
    if (res.ok) { const j = await res.json(); return j.sha || null; }
  } catch (e) { /* ignore */ }
  return null;
}

// CHEAP freshness probe for devices with NO token — which is most of them.
//
// Without a token the poll had no way to ask "did anything change?", so it fell
// straight through to a FULL download of the backup file. That file is ~17 MB and
// takes ~10 s to fetch, and the poll runs every 15 s plus on every focus — so a
// token-less device was pulling gigabytes an hour and saturating the connection
// (which is also why the device that DOES hold the token saw its pushes fail).
//
// The backup is written with its `meta` block first, so the first few hundred
// bytes identify the version of the whole file. A ranged GET therefore costs
// ~400 bytes instead of ~17 MB. Returns a stamp string, or null if the range
// request isn't honoured (caller then falls back to its previous behaviour).
export async function remoteStamp() {
  const path = cleanPath(cfg().path);
  const bust = path + (path.includes('?') ? '&' : '?') + 't=' + Date.now();
  const ctrl = new AbortController();
  try {
    const res = await fetch(bust, { cache: 'no-store', headers: { Range: 'bytes=0-400' }, signal: ctrl.signal });
    // 206 = the server honoured the range. Anything else would stream the whole
    // 17 MB into res.text(), so abort before touching the body.
    if (res.status !== 206) { try { ctrl.abort(); } catch (e) { /* ignore */ } return null; }
    const head = await res.text();
    const at = head.match(/"exportedAt"\s*:\s*"([^"]+)"/);
    if (!at) return null;
    const n = head.match(/"entries"\s*:\s*(\d+)/);
    return at[1] + '|' + (n ? n[1] : '?');
  } catch (e) { try { ctrl.abort(); } catch (e2) { /* ignore */ } return null; }
}

// Pull the latest backup from the repo. Returns { payload, sha } or null.
// With a token we use the Contents API (newest commit, no CDN cache); without a
// token we fetch the file over the same relative path the site is served from
// (GitHub Pages serves it straight from the repo) — so a freshly-cleared device
// with no token can still restore. Fails SOFT (returns null) on any error/404.
export async function fetchRemoteState() {
  const g = cfg();
  const path = cleanPath(g.path);
  if (getToken() && g.owner && g.repo) {
    try {
      const branch = g.branch || 'main';
      const res = await api(`/repos/${g.owner}/${g.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
      if (res.ok) {
        const j = await res.json();
        let text;
        if (j.content) {
          const bin = atob(j.content.replace(/\n/g, ''));
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          text = new TextDecoder().decode(bytes);
        } else if (j.download_url) {
          // Files > 1 MB come back without inline content — fetch the blob.
          text = await (await fetch(j.download_url, { cache: 'no-store' })).text();
        }
        if (text) return { payload: JSON.parse(text), sha: j.sha };
      } else if (res.status === 404) {
        return null;
      }
    } catch (e) { /* fall through to the relative fetch */ }
  }
  try {
    const bust = path + (path.includes('?') ? '&' : '?') + 't=' + Date.now();
    const res = await fetch(bust, { cache: 'no-store' });
    if (res.ok) return { payload: await res.json(), sha: null };
  } catch (e) { /* no remote backup reachable */ }
  return null;
}
