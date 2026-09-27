/**
 * View models shared by the web app and the sheet renderer.
 * Every visibility rule for picks lives in gameView_ so both outputs stay consistent.
 */

/**
 * @typedef {Object} WeekInfo
 * @property {number} week
 * @property {string} type    a GameType
 * @property {string} label   "Week 5", "Wild Card", ...
 */

/**
 * @typedef {Object} LineView
 * @property {number} spread
 * @property {?string} fav          the favored Side; null for a pick'em
 * @property {PointValues} values
 * @property {string} source        a LineSource
 */

/**
 * One player's part of a GameView. A hidden entry has only id, visible and hasPick.
 * @typedef {Object} PlayerGameView
 * @property {string} id
 * @property {boolean} visible      false while the game is open, for everyone but the viewer
 * @property {boolean} hasPick
 * @property {?string} [side]       a Side, or null for no pick
 * @property {boolean} [locked]
 * @property {?PickScore} [score]   null until the line is frozen
 */

/**
 * @typedef {Object} GameView
 * @property {string} id
 * @property {string} type           a GameType
 * @property {string} away           team code
 * @property {string} home           team code
 * @property {?number} kickoffMs
 * @property {?number} freezeAtMs
 * @property {boolean} frozen
 * @property {?LineView} line        null until the snapshot is taken (the first sync after the freeze)
 * @property {boolean} final
 * @property {?number} awayScore
 * @property {?number} homeScore
 * @property {Array<PlayerGameView>} players
 */

/**
 * One player's totals for one week, counting frozen games only.
 * @typedef {Object} PlayerWeekTotals
 * @property {number} points
 * @property {number} wins
 * @property {number} losses
 * @property {number} ties
 * @property {number} pending
 * @property {number} missed
 * @property {number} upsets
 * @property {?{gameId: string, status: string, points: ?number}} lock   the locked pick once frozen
 */

/**
 * @typedef {Object} WeekSummary
 * @property {boolean} complete                            every game frozen and final
 * @property {Array<string>} winnerIds                     top scorers once complete; more than one is a tie
 * @property {Object<string, PlayerWeekTotals>} byPlayer   playerId -> totals
 */

/**
 * @typedef {Object} SeasonTotals
 * @property {number} regular      regular-season points
 * @property {number} playoffs     playoff points
 * @property {number} full         regular + playoffs
 * @property {number} wins
 * @property {number} losses
 * @property {number} ties
 * @property {number} missed
 * @property {number} upsets
 * @property {number} weeksWon     complete weeks won outright; tied weeks do not count
 * @property {number} lockWins
 * @property {number} lockLosses
 */

/**
 * @typedef {Object} SeasonSummary
 * @property {Array<WeekInfo & WeekSummary>} weeks
 * @property {Object<string, SeasonTotals>} totals   playerId -> totals
 */

/** "Week 5" for the regular season, the round name ("Wild Card") in the playoffs. */
function weekLabel_(week, type) {
  if (type === GameType.REG) return `Week ${week}`;
  return roundInfo_(type).label;
}

/** Stored games minus voided ones (cancelled or re-identified upstream). */
function liveGames_(games) {
  return Object.values(games).filter((game) => !game.void);
}

/** @return {Array<WeekInfo>} sorted by week */
function listWeeks_(games) {
  const typeByWeek = new Map();
  liveGames_(games).forEach((game) => typeByWeek.set(game.week, game.type));
  return [...typeByWeek.keys()]
    .sort((firstWeek, secondWeek) => firstWeek - secondWeek)
    .map((week) => {
      const type = typeByWeek.get(week);
      return { week, type, label: weekLabel_(week, type) };
    });
}

/** @return {Array<Game>} live games of one week by kickoff (unknown kickoffs last), then id */
function weekGames_(games, week) {
  const kickoffOrLast = (game) => game.kickoffMs || Infinity;
  const byKickoffThenId = (first, second) => {
    const firstKickoff = kickoffOrLast(first);
    const secondKickoff = kickoffOrLast(second);
    if (firstKickoff !== secondKickoff) return firstKickoff - secondKickoff;
    return first.id < second.id ? -1 : 1;
  };
  return liveGames_(games)
    .filter((game) => game.week === week)
    .sort(byKickoffThenId);
}

/**
 * One game as seen by `viewerId` (null = the shared sheet, i.e. nobody's private view).
 * A player's pick and lock are visible to others only once the game is frozen.
 * @param {Game} game
 * @param {WeekPicks} weekPicks
 * @param {Array<Player>} players
 * @param {?string} viewerId
 * @return {GameView}
 */
function gameView_(game, weekPicks, players, nowMs, viewerId) {
  const frozen = isFrozen_(game, nowMs);
  // A snapshot exists only once frozen. Between the freeze time and the next sync the game
  // is frozen without one, so picks show but the line and scores wait.
  const snap = game.snap;

  const playerView = (player) => {
    const mine = weekPicks[player.id] || emptyPlayerPicks_();
    const side = mine.picks[game.id] || null;
    const hasPick = side !== null;
    const isViewer = player.id === viewerId;
    if (!frozen && !isViewer) return { id: player.id, visible: false, hasPick };

    const locked = mine.lock === game.id;
    const score = snap ? scorePick_({ side, snap, result: game.result, gameType: game.type, locked }) : null;
    return { id: player.id, visible: true, hasPick, side, locked, score };
  };

  return {
    id: game.id,
    type: game.type,
    away: game.away,
    home: game.home,
    kickoffMs: game.kickoffMs,
    freezeAtMs: freezeAtMs_(game),
    frozen,
    line: snap ? { spread: snap.spread, fav: favoriteSide_(snap.spread), values: snap.values, source: snap.source } : null,
    final: game.result !== null,
    awayScore: game.awayScore,
    homeScore: game.homeScore,
    players: players.map(playerView),
  };
}

/**
 * Totals for one week, counting only games that are frozen (so nothing private leaks).
 * @param {Array<Game>} gamesOfWeek
 * @param {WeekPicks} weekPicks
 * @param {Array<Player>} players
 * @return {WeekSummary}
 */
function weekSummary_(gamesOfWeek, weekPicks, players, nowMs) {
  const byPlayer = {};
  players.forEach((player) => {
    byPlayer[player.id] = { points: 0, wins: 0, losses: 0, ties: 0, pending: 0, missed: 0, upsets: 0, lock: null };
  });
  const counterByStatus = {
    [ScoreStatus.WIN]: 'wins',
    [ScoreStatus.LOSS]: 'losses',
    [ScoreStatus.TIE]: 'ties',
    [ScoreStatus.PENDING]: 'pending',
    [ScoreStatus.NO_PICK]: 'missed',
  };

  gamesOfWeek.forEach((game) => {
    const view = gameView_(game, weekPicks, players, nowMs, null);
    view.players
      .filter((playerView) => playerView.visible && playerView.score)
      .forEach(({ id, score, locked }) => {
        const totals = byPlayer[id];
        totals[counterByStatus[score.status]]++;
        if (score.upset) totals.upsets++;
        if (score.points !== null) totals.points += score.points;
        if (locked) totals.lock = { gameId: game.id, status: score.status, points: score.points };
      });
  });

  const isDone = (game) => Boolean(game.snap) && game.result !== null;
  const complete = gamesOfWeek.length > 0 && gamesOfWeek.every(isDone);
  let winnerIds = [];
  if (complete) {
    const pointsOf = (player) => byPlayer[player.id].points;
    const topPoints = Math.max(...players.map(pointsOf));
    winnerIds = players.filter((player) => pointsOf(player) === topPoints).map((player) => player.id);
  }
  return { complete, winnerIds, byPlayer };
}

/**
 * Per-week summaries plus regular-season / playoff / full-season totals.
 * @param {Object<string, Game>} games
 * @param {Object<number, WeekPicks>} allPicks
 * @param {Array<Player>} players
 * @return {SeasonSummary}
 */
function seasonSummary_(games, allPicks, players, nowMs) {
  const weeks = listWeeks_(games).map((weekInfo) => {
    const gamesOfWeek = weekGames_(games, weekInfo.week);
    const summary = weekSummary_(gamesOfWeek, allPicks[weekInfo.week] || {}, players, nowMs);
    return { ...weekInfo, ...summary };
  });

  const totals = {};
  players.forEach((player) => {
    const season = { regular: 0, playoffs: 0, full: 0, wins: 0, losses: 0, ties: 0, missed: 0, upsets: 0,
      weeksWon: 0, lockWins: 0, lockLosses: 0 };
    weeks.forEach((week) => {
      const weekTotals = week.byPlayer[player.id];
      if (week.type === GameType.REG) season.regular += weekTotals.points;
      else season.playoffs += weekTotals.points;
      season.wins += weekTotals.wins;
      season.losses += weekTotals.losses;
      season.ties += weekTotals.ties;
      season.missed += weekTotals.missed;
      season.upsets += weekTotals.upsets;

      // winnerIds is empty until the week is complete; two or more ids is a tie.
      const soleWinnerId = week.winnerIds.length === 1 ? week.winnerIds[0] : null;
      if (soleWinnerId === player.id) season.weeksWon++;

      const lockStatus = weekTotals.lock ? weekTotals.lock.status : null;
      if (lockStatus === ScoreStatus.WIN) season.lockWins++;
      if (lockStatus === ScoreStatus.LOSS) season.lockLosses++;
    });
    season.full = season.regular + season.playoffs;
    totals[player.id] = season;
  });
  return { weeks, totals };
}
