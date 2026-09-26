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

/**
 * The script lock is held only while reading and writing stored state. The sheet render
 * happens after release so pick submissions are never blocked by a slow redraw.
 */
function sync_(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return; // another sync or a pick write is running
  let snapshot;
  try {
    const nowMs = now_();
    const last = loadSyncStatus_();
    // Throttle on the last attempt, successful or not, so the public entry point
    // cannot force repeated fetches while nflverse is failing.
    if (!force && last && nowMs - last.atMs < CONFIG.MIN_SYNC_GAP_SECONDS * 1000) return;

    let rows = null;
    let error = null;
    try {
      rows = parseSchedule_(fetchCsv_(), CONFIG.SEASON);
    } catch (err) {
      // Keep going with stored data: games still freeze on time even if the fetch fails.
      error = String(err && err.message || err);
    }

    const games = loadGames_();
    // A complete season file has far more than this many rows; a truncated or empty
    // download must not void every stored game.
    if (rows) mergeRows_(games, rows, nowMs, rows.length >= CONFIG.MIN_ROWS_FOR_FULL_FETCH);
    snapshotDueGames_(games, nowMs);
    saveGames_(games);
    saveSyncStatus_(rows
      ? { atMs: nowMs, ok: true, error: null, rows: rows.length }
      : { atMs: nowMs, ok: false, error: error });

    snapshot = { games: games, picks: loadAllPicks_(), players: loadPlayers_(), nowMs: nowMs };
  } finally {
    lock.releaseLock();
  }
  if (snapshot) renderSheets_(snapshot.games, snapshot.picks, snapshot.players, snapshot.nowMs);
}

/** Freeze games whose freeze time passed even when no fresh data arrived this run. */
function snapshotDueGames_(games, nowMs) {
  Object.keys(games).forEach(function (id) {
    const g = games[id];
    if (!g.snap && !g.void && isFrozen_(g, nowMs)) takeSnapshot_(g, nowMs);
  });
}

function fetchCsv_() {
  const res = UrlFetchApp.fetch(CONFIG.DATA_URL, { muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('nflverse fetch failed: HTTP ' + code);
  return res.getContentText();
}
