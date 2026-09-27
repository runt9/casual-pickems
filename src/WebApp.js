/**
 * Pick page. Each player opens https://script.google.com/.../exec?t=<token>.
 * The token is the only credential; anyone holding a player's link can pick as them.
 *
 * Every function in this project without a trailing underscore can be called from the
 * browser via google.script.run, so only doGet and api* are meant to be public.
 * Owner-only functions (Setup.js) check the caller explicitly.
 */

/**
 * Everything the pick page shows for one week, as seen by one player. Client.html renders it.
 * @typedef {Object} PickPageState
 * @property {number} nowMs                            server clock; the page corrects its countdowns with it
 * @property {{id: string, name: string}} me
 * @property {Array<{id: string, name: string}>} others
 * @property {Array<WeekInfo>} weeks
 * @property {?number} week                            null before the first sync has loaded any games
 * @property {string} label
 * @property {number} multiplier                       round multiplier
 * @property {boolean} locksAllowed
 * @property {?string} myLock                          gameId of this player's lock
 * @property {Array<GameView>} games                   each also has awayName and homeName (team nicknames)
 * @property {Array<{id: string, name: string, points: number}>} totals   frozen games only
 * @property {boolean} complete
 * @property {Array<string>} winnerIds
 */

function doGet(e) {
  const token = e && e.parameter ? e.parameter.t : undefined;
  const player = playerByToken_(token);
  if (!player) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">This pick link is not valid.</p>')
      .setTitle("Pick'em");
  }
  const template = HtmlService.createTemplateFromFile('Index');
  template.token = player.token;
  return template.evaluate()
    .setTitle("Pick'em")
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Inlines another HTML file into a template (<?!= include_('Styles') ?>). Apps Script cannot
 * serve separate .css/.js files, so the page's styles and script live in their own .html files
 * and are pasted in when the page is generated. Scriptlets run on the server, so this private
 * function is reachable from templates but not from google.script.run.
 */
function include_(fileName) {
  return HtmlService.createHtmlOutputFromFile(fileName).getContent();
}

/** @return {?Player} */
function playerByToken_(token) {
  if (typeof token !== 'string') return null;
  if (!/^[0-9a-f-]{36}$/.test(token)) return null;
  return loadPlayers_().find((player) => player.token === token) || null;
}

/** @return {Player} */
function requirePlayer_(token) {
  const player = playerByToken_(token);
  if (!player) throw new Error('This pick link is not valid.');
  return player;
}

function withScriptLock_(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20 * 1000)) throw new Error('Busy, try again in a few seconds.');
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

/**
 * State for one week as seen by this player.
 * @param {?number} week  null for the default week
 * @return {PickPageState}
 */
function apiGetState(token, week) {
  const player = requirePlayer_(token);
  return buildState_(player, loadGames_(), week, now_());
}

/**
 * @param {?string} side  a Side, or null to clear the pick
 * @return {PickPageState}
 */
function apiSetPick(token, gameId, side) {
  const player = requirePlayer_(token);
  return withScriptLock_(() => {
    const nowMs = now_();
    const games = loadGames_();
    // gameId comes from the browser; an own-property check keeps names like "constructor" out.
    const isKnown = typeof gameId === 'string' && Object.prototype.hasOwnProperty.call(games, gameId);
    if (!isKnown) throw new Error('Unknown game.');
    const game = games[gameId];
    if (game.void) throw new Error('Unknown game.');

    const weekPicks = loadWeekPicks_(game.week);
    const mine = weekPicks[player.id] || emptyPlayerPicks_();
    applyPick_(game, mine, side, nowMs);
    weekPicks[player.id] = mine;
    saveWeekPicks_(game.week, weekPicks);
    return buildState_(player, games, game.week, nowMs);
  });
}

/**
 * @param {?string} gameId  game to lock, or null to remove the lock
 * @return {PickPageState}
 */
function apiSetLock(token, week, gameId) {
  const player = requirePlayer_(token);
  if (gameId !== null && typeof gameId !== 'string') throw new Error('Invalid game.');
  return withScriptLock_(() => {
    const nowMs = now_();
    const games = loadGames_();
    const gamesOfWeek = weekGames_(games, Number(week));
    if (!gamesOfWeek.length) throw new Error('Unknown week.');
    const { week: weekNumber, type: weekType } = gamesOfWeek[0];
    const gamesById = {};
    gamesOfWeek.forEach((game) => { gamesById[game.id] = game; });

    const weekPicks = loadWeekPicks_(weekNumber);
    const mine = weekPicks[player.id] || emptyPlayerPicks_();
    applyLock_(gamesById, weekType, mine, gameId, nowMs);
    weekPicks[player.id] = mine;
    saveWeekPicks_(weekNumber, weekPicks);
    return buildState_(player, games, weekNumber, nowMs);
  });
}

/** @return {string} the name as saved, after cleanName_ */
function apiSetName(token, name) {
  const player = requirePlayer_(token);
  const cleanName = cleanName_(name);
  return withScriptLock_(() => {
    const players = loadPlayers_();
    const sameName = (other) => other.name.toLowerCase() === cleanName.toLowerCase();
    if (players.some((other) => other.id !== player.id && sameName(other))) throw new Error('That name is taken.');
    players.find((stored) => stored.id === player.id).name = cleanName;
    savePlayers_(players);
    return cleanName;
  });
}

/** Strips control characters and collapses whitespace; throws if empty or too long. */
function cleanName_(name) {
  const raw = name === null || name === undefined ? '' : String(name);
  const cleanName = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanName) throw new Error('Name cannot be empty.');
  if (cleanName.length > CONFIG.MAX_NAME_LENGTH) throw new Error(`Name must be ${CONFIG.MAX_NAME_LENGTH} characters or fewer.`);
  return cleanName;
}

/**
 * @param {Player} player              the viewer
 * @param {Object<string, Game>} games
 * @param {*} week                     the week asked for; anything that is not a known week gets the default week
 * @return {PickPageState}
 */
function buildState_(player, games, week, nowMs) {
  const players = loadPlayers_();
  const weeks = listWeeks_(games);
  // The earliest week that still has an open game, else the last week.
  const defaultWeek = () => {
    const hasOpenGame = (weekInfo) => weekGames_(games, weekInfo.week).some((game) => !isFrozen_(game, nowMs));
    return weeks.find(hasOpenGame) || weeks[weeks.length - 1] || null;
  };
  const requestedWeek = weeks.find((weekInfo) => weekInfo.week === Number(week));
  const shownWeek = requestedWeek || defaultWeek();

  const gamesOfWeek = shownWeek ? weekGames_(games, shownWeek.week) : [];
  const weekPicks = shownWeek ? loadWeekPicks_(shownWeek.week) : {};
  const summary = weekSummary_(gamesOfWeek, weekPicks, players, nowMs);
  const mine = weekPicks[player.id] || emptyPlayerPicks_();
  const round = shownWeek ? roundInfo_(shownWeek.type) : null;
  const others = players.filter((other) => other.id !== player.id);
  const gameForPage = (game) => ({
    ...gameView_(game, weekPicks, players, nowMs, player.id),
    awayName: teamName_(game.away),
    homeName: teamName_(game.home),
  });

  return {
    nowMs,
    me: { id: player.id, name: player.name },
    others: others.map(({ id, name }) => ({ id, name })),
    weeks,
    week: shownWeek ? shownWeek.week : null,
    label: shownWeek ? shownWeek.label : '',
    multiplier: round ? round.multiplier : 1,
    locksAllowed: round ? round.locks : false,
    myLock: mine.lock,
    games: gamesOfWeek.map(gameForPage),
    totals: players.map(({ id, name }) => ({ id, name, points: summary.byPlayer[id].points })),
    complete: summary.complete,
    winnerIds: summary.winnerIds,
  };
}
