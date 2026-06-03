// test-autosync.mjs — verify the GitHub auto-sync state machine (main.js) is
// LOOP-SAFE. The real backupNow() writes a `backup.github` audit and that save()
// re-fires the subscriber; naively that re-arms another backup forever. This test
// replicates the exact runAutoSync/_syncSig logic with a mock backup and asserts:
//   (1) one change → exactly ONE backup (the backup's own audit must NOT re-trigger),
//   (2) a change that lands DURING a backup → a SECOND backup (nothing missed),
//   (3) no change → no backup.
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 20, BACKUP_MS = 60;

function makeRig() {
  const audit = [];
  let backupCalls = 0;
  // mirrors github.js backupNow: appends a backup.github audit + fires subscriber twice
  // (the _audit save AND the setConfig save both emit in the real store).
  const autoBackup = async () => { backupCalls++; await delay(BACKUP_MS); audit.push({ action: 'backup.github' }); subscriber(); subscriber(); return true; };

  // ---- verbatim from main.js ----
  let _autoSyncTimer = null, _syncing = false, _lastSyncedSig = null;
  function _syncSig() { let b = 0; for (const e of audit) if (e.action === 'backup.github') b++; return audit.length - b; }
  function subscriber() { clearTimeout(_autoSyncTimer); _autoSyncTimer = setTimeout(runAutoSync, DEBOUNCE); }
  async function runAutoSync() {
    if (_syncing) { clearTimeout(_autoSyncTimer); _autoSyncTimer = setTimeout(runAutoSync, DEBOUNCE); return; }
    const sigAtStart = _syncSig();
    if (sigAtStart === _lastSyncedSig) return;
    _syncing = true; let ok = false;
    try { ok = await autoBackup(); } finally { _syncing = false; }
    if (ok) _lastSyncedSig = sigAtStart;
    if (_syncSig() !== _lastSyncedSig) { clearTimeout(_autoSyncTimer); _autoSyncTimer = setTimeout(runAutoSync, DEBOUNCE); }
  }
  // -------------------------------
  const change = (action = 'deposit.create') => { audit.push({ action }); subscriber(); };
  const setLastSynced = () => { _lastSyncedSig = _syncSig(); };
  return { audit, change, setLastSynced, calls: () => backupCalls };
}

let fail = 0;
function check(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++; }

// (1) one change → exactly one backup, no loop
{
  const r = makeRig();
  r.change();
  await delay(400);                       // well past debounce + backup + any echo
  check('1) single change → exactly 1 backup (no self-trigger loop)', r.calls() === 1);
}
// (2) a change DURING the backup → a follow-up backup (2 total)
{
  const r = makeRig();
  r.change();                             // arms backup #1
  await delay(DEBOUNCE + 25);             // backup #1 now in flight (awaiting)
  r.change();                             // lands mid-backup
  await delay(400);
  check('2) change during a backup → 2 backups (nothing missed)', r.calls() === 2);
}
// (3) restore marks state synced → no spurious push
{
  const r = makeRig();
  r.audit.push({ action: 'data.import' }); // imitate importData mutating the log
  r.setLastSynced();                       // syncFromRemote does this after a pull
  r.change('__noop__'); r.audit.pop();     // poke the subscriber without net new data
  // actually assert the real intent: with no NEW change beyond the restored state, no backup
  await delay(400);
  check('3) freshly-restored state → no echo backup', r.calls() === 0);
}

console.log(fail === 0 ? '\nAUTO-SYNC LOGIC OK ✓ — loop-safe, gap-free' : `\n${fail} CHECK(S) FAILED ✗`);
process.exit(fail ? 1 : 0);
