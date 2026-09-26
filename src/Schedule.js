/**
 * Parse nflverse games.csv into game rows and merge them into stored state.
 */

/** Convert an nflverse Eastern-time gameday/gametime to epoch ms (null if unknown). */
function parseKickoffMs_(gameday, gametime) {
  if (!gameday || !gametime) return null;
  return Utilities.parseDate(gameday + ' ' + gametime, CONFIG.DATA_TIMEZONE, 'yyyy-MM-dd HH:mm').getTime();
}

function numOrNull_(s) {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/**
 * @param {string} csvText  full games.csv
 * @param {number} season
 * @return {Array<Object>} rows for that season
 */
function parseSchedule_(csvText, season) {
  const table = Utilities.parseCsv(csvText);
  const header = table[0];
  const col = {};
  header.forEach(function (name, i) { col[name] = i; });
  ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'home_team',
    'away_score', 'home_score', 'result', 'spread_line'].forEach(function (c) {
    if (col[c] === undefined) throw new Error('games.csv is missing column ' + c);
  });

  const out = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    if (Number(r[col.season]) !== season) continue;
    out.push({
      id: r[col.game_id],
      week: Number(r[col.week]),
      type: r[col.game_type],
      away: r[col.away_team],
      home: r[col.home_team],
      kickoffMs: parseKickoffMs_(r[col.gameday], r[col.gametime]),
      spread: numOrNull_(r[col.spread_line]),
      awayScore: numOrNull_(r[col.away_score]),
      homeScore: numOrNull_(r[col.home_score]),
      result: numOrNull_(r[col.result]),
    });
  }
  return out;
}

function countsForGame_(row) {
  return row.type !== 'REG' || row.week >= CONFIG.START_WEEK;
}

/**
 * Merge freshly parsed rows into stored games (id -> game). Mutates `games`.
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
 */
function mergeRows_(games, rows, nowMs, fullFetch) {
  const seen = {};
  rows.forEach(function (row) {
    if (!countsForGame_(row)) return;
    seen[row.id] = true;
    let g = Object.prototype.hasOwnProperty.call(games, row.id) ? games[row.id] : null;
    if (!g) {
      g = {
        id: row.id, week: row.week, type: row.type, away: row.away, home: row.home,
        kickoffMs: row.kickoffMs, lastSpread: null, lastSpreadAtMs: null, snap: null,
        awayScore: null, homeScore: null, result: null, void: false,
      };
      games[row.id] = g;
    }
    g.void = false;

    // 1. Freeze using what we already had, before trusting new kickoff data.
    if (!g.snap && isFrozen_(g, nowMs)) takeSnapshot_(g, nowMs);

    // 2. Open games take new kickoff/teams, then freeze or record the current line.
    if (!g.snap) {
      g.kickoffMs = row.kickoffMs;
      g.away = row.away;
      g.home = row.home;
      if (isFrozen_(g, nowMs)) {
        takeSnapshot_(g, nowMs);
      } else if (row.spread !== null) {
        g.lastSpread = row.spread;
        g.lastSpreadAtMs = nowMs;
      }
    }

    g.awayScore = row.awayScore;
    g.homeScore = row.homeScore;
    g.result = row.result;
  });

  if (fullFetch) {
    Object.keys(games).forEach(function (id) {
      const g = games[id];
      if (!seen[id] && g.result === null) g.void = true;
    });
  }
  return games;
}

/** Freeze a game: the last line seen strictly before its freeze time, else pick'em. */
function takeSnapshot_(g, nowMs) {
  const f = freezeAtMs_(g);
  const usable = g.lastSpread !== null && g.lastSpreadAtMs !== null && (f === null || g.lastSpreadAtMs < f);
  const spread = usable ? g.lastSpread : 0;
  g.snap = { spread: spread, values: pointValues_(spread), atMs: nowMs, source: usable ? 'before-freeze' : 'no-line' };
}
