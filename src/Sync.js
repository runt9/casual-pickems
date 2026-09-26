/**
 * Time-driven sync: fetch nflverse, freeze games, re-render the shared sheet.
 */

/** Trigger entry point. Also callable from the editor to force a refresh. */
function syncTrigger() {
  sync_(false);
}

function now_() {
  return Date.now();
}

function sync_(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return; // another sync or a pick write is running
  try {
    const nowMs = now_();
    const last = loadSyncStatus_();
    if (!force && last && last.ok && nowMs - last.atMs < CONFIG.MIN_SYNC_GAP_SECONDS * 1000) return;

    let rows;
    try {
      rows = parseSchedule_(fetchCsv_(), CONFIG.SEASON);
    } catch (err) {
      // Keep going with stored data: games still freeze on time even if the fetch fails,
      // they just use the last line seen before the failure.
      saveSyncStatus_({ atMs: nowMs, ok: false, error: String(err && err.message || err) });
      rows = null;
    }

    const games = loadGames_();
    if (rows) mergeRows_(games, rows, nowMs);
    snapshotDueGames_(games, nowMs);
    saveGames_(games);
    if (rows) saveSyncStatus_({ atMs: nowMs, ok: true, error: null, rows: rows.length });

    renderSheets_(games, loadAllPicks_(), loadPlayers_(), nowMs);
  } finally {
    lock.releaseLock();
  }
}

/** Freeze games whose freeze time passed even when no fresh data arrived this run. */
function snapshotDueGames_(games, nowMs) {
  Object.keys(games).forEach(function (id) {
    const g = games[id];
    if (!g.snap && isFrozen_(g, nowMs)) takeSnapshot_(g, null, nowMs);
  });
}

function fetchCsv_() {
  const res = UrlFetchApp.fetch(CONFIG.DATA_URL, { muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('nflverse fetch failed: HTTP ' + code);
  return res.getContentText();
}
