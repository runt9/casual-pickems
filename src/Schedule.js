/**
 * Parse nflverse games.csv into game rows and merge them into stored state.
 */

/**
 * One season row of games.csv, as parsed. Numbers are null where the cell is blank.
 * @typedef {Object} ScheduleRow
 * @property {string} id
 * @property {number} week
 * @property {string} type         a GameType
 * @property {string} away         team code
 * @property {string} home         team code
 * @property {?number} kickoffMs   null while nflverse has no date or time
 * @property {?number} spread      nflverse spread_line
 * @property {?number} awayScore
 * @property {?number} homeScore
 * @property {?number} result      home - away
 */

/** Convert an nflverse Eastern-time gameday/gametime to epoch ms (null if unknown). */
function parseKickoffMs_(gameday, gametime) {
  if (!gameday || !gametime) return null;
  return Utilities.parseDate(`${gameday} ${gametime}`, CONFIG.DATA_TIMEZONE, 'yyyy-MM-dd HH:mm').getTime();
}

function numOrNull_(cell) {
  if (cell === undefined || cell === null) return null;
  if (String(cell).trim() === '') return null;
  const number = Number(cell);
  return isFinite(number) ? number : null;
}

/**
 * @param {string} csvText  full games.csv
 * @param {number} season
 * @return {Array<ScheduleRow>} rows for that season
 */
function parseSchedule_(csvText, season) {
  const [header, ...dataRows] = Utilities.parseCsv(csvText);
  const column = {};
  header.forEach((name, index) => { column[name] = index; });
  const requiredColumns = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'home_team',
    'away_score', 'home_score', 'result', 'spread_line'];
  requiredColumns.forEach((name) => {
    if (column[name] === undefined) throw new Error(`games.csv is missing column ${name}`);
  });

  return dataRows
    .filter((cells) => Number(cells[column.season]) === season)
    .map((cells) => ({
      id: cells[column.game_id],
      week: Number(cells[column.week]),
      type: cells[column.game_type],
      away: cells[column.away_team],
      home: cells[column.home_team],
      kickoffMs: parseKickoffMs_(cells[column.gameday], cells[column.gametime]),
      spread: numOrNull_(cells[column.spread_line]),
      awayScore: numOrNull_(cells[column.away_score]),
      homeScore: numOrNull_(cells[column.home_score]),
      result: numOrNull_(cells[column.result]),
    }));
}

/** Regular-season weeks before CONFIG.START_WEEK are ignored entirely. */
function countsForGame_(row) {
  if (row.type !== GameType.REG) return true;
  return row.week >= CONFIG.START_WEEK;
}

/**
 * Merge freshly parsed rows into stored games. Mutates `games`.
 *
 * Freeze and line rules:
 *  - While a game is open, every sync records the latest line as `lastSpread`.
 *  - Freeze is decided from the STORED kickoff before any new data is applied, so a
 *    kickoff that moves (or goes blank) after the clock freeze cannot reopen the game.
 *  - The snapshot line is the last line seen before the freeze. If none was seen, the
 *    game is scored as a pick'em (spread 0). Lines published after the freeze never count.
 *  - After the snapshot, kickoff/teams/line are never changed; only scores update.
 *  - `fullFetch`: rows are a complete season file, so an unfinished stored game missing
 *    from it has been cancelled or re-identified and is marked void (excluded everywhere).
 *    Voiding is reversed if the game reappears.
 *
 * @param {Object<string, Game>} games  id -> game
 * @param {Array<ScheduleRow>} rows
 * @param {boolean} fullFetch
 * @return {Object<string, Game>} the same `games`
 */
function mergeRows_(games, rows, nowMs, fullFetch) {
  const seenIds = new Set();
  rows.filter(countsForGame_).forEach((row) => {
    seenIds.add(row.id);
    const isStored = Object.prototype.hasOwnProperty.call(games, row.id);
    if (!isStored) {
      games[row.id] = {
        id: row.id, week: row.week, type: row.type, away: row.away, home: row.home,
        kickoffMs: row.kickoffMs, lastSpread: null, lastSpreadAtMs: null, snap: null,
        awayScore: null, homeScore: null, result: null, void: false,
      };
    }
    const game = games[row.id];
    game.void = false;

    // 1. Freeze using what we already had, before trusting new kickoff data.
    if (!game.snap && isFrozen_(game, nowMs)) takeSnapshot_(game, nowMs);

    // 2. Open games take new kickoff/teams, then freeze or record the current line.
    if (!game.snap) {
      game.kickoffMs = row.kickoffMs;
      game.away = row.away;
      game.home = row.home;
      if (isFrozen_(game, nowMs)) {
        takeSnapshot_(game, nowMs);
      } else if (row.spread !== null) {
        game.lastSpread = row.spread;
        game.lastSpreadAtMs = nowMs;
      }
    }

    game.awayScore = row.awayScore;
    game.homeScore = row.homeScore;
    game.result = row.result;
  });

  if (fullFetch) {
    Object.values(games)
      .filter((game) => !seenIds.has(game.id) && game.result === null)
      .forEach((game) => { game.void = true; });
  }
  return games;
}

/**
 * Freeze a game: the last line seen strictly before its freeze time, else pick'em.
 * Only called on frozen games, so the freeze time is known.
 */
function takeSnapshot_(game, nowMs) {
  const lineSeen = game.lastSpread !== null && game.lastSpreadAtMs !== null;
  const usable = lineSeen && game.lastSpreadAtMs < freezeAtMs_(game);
  const spread = usable ? game.lastSpread : 0;
  game.snap = {
    spread,
    values: pointValues_(spread),
    atMs: nowMs,
    source: usable ? LineSource.BEFORE_FREEZE : LineSource.NO_LINE,
  };
}
