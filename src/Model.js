/**
 * View models shared by the web app and the sheet renderer.
 * Every visibility rule for picks lives in gameView_ so both outputs stay consistent.
 */

function weekLabel_(week, type) {
  return type === 'REG' ? 'Week ' + week : roundInfo_(type).label;
}

/** Stored games minus voided ones (cancelled or re-identified upstream). */
function liveGames_(games) {
  return Object.keys(games).map(function (id) { return games[id]; }).filter(function (g) { return !g.void; });
}

/** [{week, type, label}] sorted by week. */
function listWeeks_(games) {
  const seen = {};
  liveGames_(games).forEach(function (g) {
    seen[g.week] = g.type;
  });
  return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; }).map(function (w) {
    return { week: w, type: seen[w], label: weekLabel_(w, seen[w]) };
  });
}

function weekGames_(games, week) {
  return liveGames_(games)
    .filter(function (g) { return g.week === week; })
    .sort(function (a, b) {
      return (a.kickoffMs || Infinity) - (b.kickoffMs || Infinity) || (a.id < b.id ? -1 : 1);
    });
}

/**
 * One game as seen by `viewerId` (null = the shared sheet, i.e. nobody's private view).
 * A player's pick and lock are visible to others only once the game is frozen.
 */
function gameView_(g, weekPicks, players, nowMs, viewerId) {
  const frozen = isFrozen_(g, nowMs);
  return {
    id: g.id,
    type: g.type,
    away: g.away,
    home: g.home,
    kickoffMs: g.kickoffMs,
    freezeAtMs: freezeAtMs_(g),
    frozen: frozen,
    line: frozen && g.snap ? {
      spread: g.snap.spread, fav: favoriteSide_(g.snap.spread), values: g.snap.values, source: g.snap.source,
    } : null,
    final: g.result !== null,
    awayScore: g.awayScore,
    homeScore: g.homeScore,
    players: players.map(function (p) {
      const mine = weekPicks[p.id] || emptyPlayerPicks_();
      const side = mine.picks[g.id] || null;
      const locked = mine.lock === g.id;
      if (!frozen && p.id !== viewerId) return { id: p.id, visible: false, hasPick: side !== null };
      return {
        id: p.id, visible: true, hasPick: side !== null, side: side, locked: locked,
        score: frozen && g.snap
          ? scorePick_({ side: side, snap: g.snap, result: g.result, gameType: g.type, locked: locked })
          : null,
      };
    }),
  };
}

/**
 * Totals for one week, counting only games that are frozen (so nothing private leaks).
 * @return {{complete:boolean, winnerIds:Array<string>, byPlayer:Object<string,Object>}}
 */
function weekSummary_(gamesOfWeek, weekPicks, players, nowMs) {
  const byPlayer = {};
  players.forEach(function (p) {
    byPlayer[p.id] = { points: 0, wins: 0, losses: 0, ties: 0, pending: 0, missed: 0, upsets: 0, lock: null };
  });
  let complete = gamesOfWeek.length > 0;
  gamesOfWeek.forEach(function (g) {
    if (!(g.snap && g.result !== null)) complete = false;
    const v = gameView_(g, weekPicks, players, nowMs, null);
    v.players.forEach(function (pv) {
      if (!pv.visible || !pv.score) return;
      const t = byPlayer[pv.id];
      const s = pv.score;
      if (s.status === 'win') t.wins++;
      if (s.status === 'loss') t.losses++;
      if (s.status === 'tie') t.ties++;
      if (s.status === 'pending') t.pending++;
      if (s.status === 'nopick') t.missed++;
      if (s.upset) t.upsets++;
      if (s.points !== null) t.points += s.points;
      if (pv.locked) t.lock = { gameId: g.id, status: s.status, points: s.points };
    });
  });
  let winnerIds = [];
  if (complete) {
    const best = Math.max.apply(null, players.map(function (p) { return byPlayer[p.id].points; }));
    winnerIds = players.filter(function (p) { return byPlayer[p.id].points === best; }).map(function (p) { return p.id; });
  }
  return { complete: complete, winnerIds: winnerIds, byPlayer: byPlayer };
}

/** Per-week summaries plus regular-season / playoff / full-season totals. */
function seasonSummary_(games, allPicks, players, nowMs) {
  const weeks = listWeeks_(games).map(function (w) {
    const s = weekSummary_(weekGames_(games, w.week), allPicks[w.week] || {}, players, nowMs);
    return Object.assign({}, w, s);
  });
  const totals = {};
  players.forEach(function (p) {
    const t = { regular: 0, playoffs: 0, full: 0, wins: 0, losses: 0, ties: 0, missed: 0, upsets: 0,
      weeksWon: 0, lockWins: 0, lockLosses: 0 };
    weeks.forEach(function (w) {
      const b = w.byPlayer[p.id];
      if (w.type === 'REG') t.regular += b.points; else t.playoffs += b.points;
      t.wins += b.wins; t.losses += b.losses; t.ties += b.ties; t.missed += b.missed; t.upsets += b.upsets;
      if (w.complete && w.winnerIds.length === 1 && w.winnerIds[0] === p.id) t.weeksWon++;
      if (b.lock && b.lock.status === 'win') t.lockWins++;
      if (b.lock && b.lock.status === 'loss') t.lockLosses++;
    });
    t.full = t.regular + t.playoffs;
    totals[p.id] = t;
  });
  return { weeks: weeks, totals: totals };
}
