// github.js — push the ledger to a GitHub repo via the Contents API.
// Every backup is a commit, so Git history becomes a durable, dated,
// tamper-evident audit trail that lives OFF the front-desk device.
//
// The token is stored in its OWN localStorage key (never inside the exported
// backup JSON or the app state), and should be a FINE-GRAINED PAT scoped to a
// single repo with only "Contents: Read and write".

import { store } from './store.js';
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
export async function backupNow(reason = 'manual') {
  const g = cfg();
  if (!getToken()) throw new Error('No GitHub token set.');
  if (!g.owner || !g.repo) throw new Error('Set owner and repo first.');
  const path = cleanPath(g.path);
  const branch = g.branch || 'main';

  const json = JSON.stringify(store.exportData(), null, 2);
  const content = b64utf8(json);

  // need the existing file SHA to update it
  let sha;
  const getRes = await api(`/repos/${g.owner}/${g.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
  else if (getRes.status !== 404) throw new Error('Could not read repo (' + getRes.status + ').');

  const coh = store.coh();
  const message = `Front desk backup (${reason}) · COH ₱${coh} · ${store.ledger.length} entries`;
  let putRes = await api(`/repos/${g.owner}/${g.repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content, branch, sha }),
  });
  // 409/422 = another device committed in between (our `sha` is stale). Re-read
  // the current SHA once and retry, so two front-desk devices don't clobber each
  // other on a blind write.
  if (putRes.status === 409 || putRes.status === 422) {
    const r2 = await api(`/repos/${g.owner}/${g.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    const sha2 = r2.ok ? (await r2.json()).sha : undefined;
    putRes = await api(`/repos/${g.owner}/${g.repo}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content, branch, sha: sha2 }),
    });
  }
  if (!putRes.ok) {
    const txt = await putRes.text();
    throw new Error('Backup failed (' + putRes.status + '): ' + txt.slice(0, 140));
  }
  const j = await putRes.json();
  g.enabled = true;
  g.lastBackupAt = nowISO();
  g.lastBackupSha = j.content && j.content.sha;
  store.setConfig({ github: g });
  store._audit('backup.github', `Backup committed to ${g.owner}/${g.repo}@${branch} (${reason})`, { reason, coh, entries: store.ledger.length });
  return j.commit && j.commit.html_url;
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
