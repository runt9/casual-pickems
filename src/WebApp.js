/**
 * Pick page. Each player opens https://script.google.com/.../exec?t=<token>.
 * The token is the only credential; anyone holding a player's link can pick as them.
 *
 * Every function in this project without a trailing underscore can be called from the
 * browser via google.script.run, so only doGet and api* are meant to be public.
 * Owner-only functions (Setup.js) check the caller explicitly.
 */

function doGet(e) {
  const player = playerByToken_(e && e.parameter && e.parameter.t);
  if (!player) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">This pick link is not valid.</p>')
      .setTitle("Pick'em");
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.token = player.token;
  return t.evaluate()
    .setTitle("Pick'em")
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function playerByToken_(token) {
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) return null;
  return loadPlayers_().filter(function (p) { return p.token === token; })[0] || null;
}

function requirePlayer_(token) {
  const p = playerByToken_(token);
  if (!p) throw new Error('This pick link is not valid.');
  return p;
}

function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20 * 1000)) throw new Error('Busy, try again in a few seconds.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** State for one week as seen by this player. week may be null for the default week. */
function apiGetState(token, week) {
  const player = requirePlayer_(token);
  return buildState_(player, loadGames_(), week, now_());
}

/** side: 'home' | 'away' | null (clear). */
function apiSetPick(token, gameId, side) {
  const player = requirePlayer_(token);
  return withScriptLock_(function () {
    const nowMs = now_();
    const games = loadGames_();
    const game = typeof gameId === 'string' && Object.prototype.hasOwnProperty.call(games, gameId) ? games[gameId] : null;
    if (!game || game.void) throw new Error('Unknown game.');
    const weekPicks = loadWeekPicks_(game.week);
    const mine = weekPicks[player.id] || emptyPlayerPicks_();
    applyPick_(game, mine, side, nowMs);
    weekPicks[player.id] = mine;
    saveWeekPicks_(game.week, weekPicks);
    return buildState_(player, games, game.week, nowMs);
  });
}

/** gameId: game to lock, or null to remove the lock. */
function apiSetLock(token, week, gameId) {
  const player = requirePlayer_(token);
  if (gameId !== null && typeof gameId !== 'string') throw new Error('Invalid game.');
  return withScriptLock_(function () {
    const nowMs = now_();
    const games = loadGames_();
    const list = weekGames_(games, Number(week));
    if (!list.length) throw new Error('Unknown week.');
    const byId = {};
    list.forEach(function (g) { byId[g.id] = g; });
    const weekPicks = loadWeekPicks_(list[0].week);
    const mine = weekPicks[player.id] || emptyPlayerPicks_();
    applyLock_(byId, list[0].type, mine, gameId, nowMs);
    weekPicks[player.id] = mine;
    saveWeekPicks_(list[0].week, weekPicks);
    return buildState_(player, games, list[0].week, nowMs);
  });
}

function apiSetName(token, name) {
  const player = requirePlayer_(token);
  const clean = cleanName_(name);
  return withScriptLock_(function () {
    const players = loadPlayers_();
    if (players.some(function (p) { return p.id !== player.id && p.name.toLowerCase() === clean.toLowerCase(); })) {
      throw new Error('That name is taken.');
    }
    players.forEach(function (p) { if (p.id === player.id) p.name = clean; });
    savePlayers_(players);
    return clean;
  });
}

function cleanName_(name) {
  const s = String(name === null || name === undefined ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) throw new Error('Name cannot be empty.');
  if (s.length > CONFIG.MAX_NAME_LENGTH) throw new Error('Name must be ' + CONFIG.MAX_NAME_LENGTH + ' characters or fewer.');
  return s;
}

/** The week to show by default: the earliest week that still has an open game, else the last week. */
function defaultWeek_(games, weeks, nowMs) {
  for (let i = 0; i < weeks.length; i++) {
    if (weekGames_(games, weeks[i].week).some(function (g) { return !isFrozen_(g, nowMs); })) return weeks[i].week;
  }
  return weeks.length ? weeks[weeks.length - 1].week : null;
}

function buildState_(player, games, week, nowMs) {
  const players = loadPlayers_();
  const weeks = listWeeks_(games);
  let w = week === null || week === undefined || week === '' ? defaultWeek_(games, weeks, nowMs) : Number(week);
  if (!weeks.some(function (x) { return x.week === w; })) w = defaultWeek_(games, weeks, nowMs);
  const meta = weeks.filter(function (x) { return x.week === w; })[0];
  const list = w === null ? [] : weekGames_(games, w);
  const weekPicks = w === null ? {} : loadWeekPicks_(w);
  const summary = weekSummary_(list, weekPicks, players, nowMs);
  const mine = weekPicks[player.id] || emptyPlayerPicks_();
  const round = meta ? roundInfo_(meta.type) : null;
  const other = players.filter(function (p) { return p.id !== player.id; });

  return {
    nowMs: nowMs,
    me: { id: player.id, name: player.name },
    others: other.map(function (p) { return { id: p.id, name: p.name }; }),
    weeks: weeks,
    week: w,
    label: meta ? meta.label : '',
    multiplier: round ? round.multiplier : 1,
    locksAllowed: round ? round.locks : false,
    myLock: mine.lock,
    games: list.map(function (g) {
      const v = gameView_(g, weekPicks, players, nowMs, player.id);
      v.awayName = teamName_(g.away);
      v.homeName = teamName_(g.home);
      return v;
    }),
    totals: players.map(function (p) {
      return { id: p.id, name: p.name, points: summary.byPlayer[p.id].points };
    }),
    complete: summary.complete,
    winnerIds: summary.winnerIds,
  };
}
