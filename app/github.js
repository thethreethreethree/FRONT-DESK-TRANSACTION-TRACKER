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
  const putRes = await api(`/repos/${g.owner}/${g.repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content, branch, sha }),
  });
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

// Fire-and-forget auto-backup (used on shift close). Never throws.
export async function autoBackup(reason) {
  const g = cfg();
  if (!g.enabled || !g.autoOnClose || !getToken()) return false;
  try { await backupNow(reason); toast('Backed up to GitHub ✓', 'ok'); return true; }
  catch (e) { console.error(e); toast('GitHub backup failed: ' + e.message, 'err'); return false; }
}
