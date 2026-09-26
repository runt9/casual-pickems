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
 * Spread handling:
 *  - While a game is open, every sync records the latest line as `lastSpread`.
 *  - The first sync at/after the freeze time takes the snapshot from `lastSpread`,
 *    i.e. the last line seen BEFORE the freeze, so lines published after the
 *    freeze never count. If no line was ever seen before the freeze (e.g. the
 *    script was installed late), the current line is used; if there is no line
 *    at all, the game is scored as a pick'em (spread 0).
 *  - After the snapshot, kickoff/teams/line are never changed; only scores update.
 */
function mergeRows_(games, rows, nowMs) {
  rows.forEach(function (row) {
    if (!countsForGame_(row)) return;
    let g = games[row.id];
    if (!g) {
      g = {
        id: row.id, week: row.week, type: row.type, away: row.away, home: row.home,
        kickoffMs: row.kickoffMs, lastSpread: null, lastSpreadAtMs: null, snap: null,
        awayScore: null, homeScore: null, result: null,
      };
      games[row.id] = g;
    }
    if (!g.snap) {
      g.kickoffMs = row.kickoffMs;
      g.away = row.away;
      g.home = row.home;
    }
    g.awayScore = row.awayScore;
    g.homeScore = row.homeScore;
    g.result = row.result;

    if (g.snap) return;
    const f = freezeAtMs_(g);
    if (f === null || nowMs < f) {
      if (row.spread !== null) {
        g.lastSpread = row.spread;
        g.lastSpreadAtMs = nowMs;
      }
    } else {
      takeSnapshot_(g, row.spread, nowMs);
    }
  });
  return games;
}

function takeSnapshot_(g, currentSpread, nowMs) {
  let spread = g.lastSpread;
  let source = 'before-freeze';
  if (spread === null) { spread = currentSpread; source = 'after-freeze'; }
  if (spread === null) { spread = 0; source = 'no-line'; }
  g.snap = { spread: spread, values: pointValues_(spread), atMs: nowMs, source: source };
}
