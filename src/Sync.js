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
 * @param {boolean} force  skip the MIN_SYNC_GAP_SECONDS throttle (owner-run syncs)
 */
function sync_(force) {
  const lock = LockService.getScriptLock();
  // Another sync or a pick write is running; the next trigger run catches up.
  if (!lock.tryLock(30 * 1000)) return;
  let renderInput = null;
  try {
    const nowMs = now_();
    // Throttle on the last attempt, successful or not, so the public entry point
    // cannot force repeated fetches while nflverse is failing.
    const lastStatus = loadSyncStatus_();
    const sinceLastSyncMs = lastStatus ? nowMs - lastStatus.atMs : Infinity;
    if (!force && sinceLastSyncMs < CONFIG.MIN_SYNC_GAP_SECONDS * 1000) return;

    let rows = null;
    let error = null;
    try {
      const csvText = fetchCsv_();
      rows = parseSchedule_(csvText, CONFIG.SEASON);
    } catch (err) {
      // Keep going with stored data: games still freeze on time even if the fetch fails.
      const message = err && err.message;
      error = String(message || err);
    }

    const games = loadGames_();
    if (rows) {
      // A complete season file has far more than this many rows; a truncated or empty
      // download must not void every stored game.
      const fullFetch = rows.length >= CONFIG.MIN_ROWS_FOR_FULL_FETCH;
      mergeRows_(games, rows, nowMs, fullFetch);
    }
    snapshotDueGames_(games, nowMs);
    saveGames_(games);
    const status = rows
      ? { atMs: nowMs, ok: true, error: null, rows: rows.length }
      : { atMs: nowMs, ok: false, error };
    saveSyncStatus_(status);

    const allPicks = loadAllPicks_();
    const players = loadPlayers_();
    try {
      notifyDiscord_(games, allPicks, players, nowMs);
    } catch (err) {
      // Games are already saved; the failed post was not recorded, so the next sync retries it.
      console.error(`Discord: ${err && err.message}`);
    }
    renderInput = { games, allPicks, players, nowMs };
  } finally {
    lock.releaseLock();
  }
  if (renderInput) renderSheets_(renderInput.games, renderInput.allPicks, renderInput.players, renderInput.nowMs);
}

/** Freeze games whose freeze time passed even when no fresh data arrived this run. */
function snapshotDueGames_(games, nowMs) {
  Object.values(games)
    .filter((game) => !game.snap && !game.void)
    .filter((game) => isFrozen_(game, nowMs))
    .forEach((game) => takeSnapshot_(game, nowMs));
}

function fetchCsv_() {
  const response = UrlFetchApp.fetch(CONFIG.DATA_URL, { muteHttpExceptions: true, followRedirects: true });
  const code = response.getResponseCode();
  if (code !== 200) throw new Error(`nflverse fetch failed: HTTP ${code}`);
  return response.getContentText();
}
