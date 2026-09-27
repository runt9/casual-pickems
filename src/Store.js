/**
 * Persistence in Script Properties. Only the script owner can read these; the
 * shared spreadsheet never contains unfrozen picks or unfrozen lines.
 *
 * Keys:
 *   players        Array<Player>
 *   g:<week>       Object<gameId, Game>      one key per week keeps each value under the size limit
 *   p:<week>       WeekPicks
 *   sync           SyncStatus
 *   render         Object<tabName, hash>     content hash of each sheet tab as last drawn (Render.js)
 *   WEB_APP_URL    the web app's /exec URL, set by hand (Setup.js printLinks)
 */
const PropertyKey = Object.freeze({
  PLAYERS: 'players',
  GAMES_PREFIX: 'g:',
  PICKS_PREFIX: 'p:',
  SYNC: 'sync',
  RENDER: 'render',
  WEB_APP_URL: 'WEB_APP_URL',
});

/** Script Properties rejects values over 9 KB; failing here names the key that grew too big. */
const MAX_PROPERTY_BYTES_ = 9000;

/**
 * @typedef {Object} Player
 * @property {string} id      'p1', 'p2', ...
 * @property {string} token   UUID in the player's link (?t=); their only credential
 * @property {string} name    display name, cleaned by cleanName_
 * @property {number} [joinedAtMs]  set when added mid-season by addPlayer; see playsGame_
 */

/**
 * A game's line as frozen. Written once at the freeze and never changed.
 * @typedef {Object} Snapshot
 * @property {number} spread        nflverse convention; 0 for a pick'em
 * @property {PointValues} values
 * @property {number} atMs          when the snapshot was taken (the first sync at or after the freeze)
 * @property {string} source        a LineSource
 */

/**
 * @typedef {Object} Game
 * @property {string} id                nflverse game_id
 * @property {number} week
 * @property {string} type              a GameType
 * @property {string} away              team code
 * @property {string} home              team code
 * @property {?number} kickoffMs        null while nflverse has no date or time
 * @property {?number} lastSpread       latest line seen while the game was open
 * @property {?number} lastSpreadAtMs   when lastSpread was seen
 * @property {?Snapshot} snap           set at the freeze
 * @property {?number} awayScore
 * @property {?number} homeScore
 * @property {?number} result           home - away; null until final
 * @property {boolean} void             cancelled or re-identified upstream; excluded everywhere
 */

/**
 * One player's picks for one week.
 * @typedef {Object} PlayerPicks
 * @property {Object<string, string>} picks  gameId -> Side
 * @property {?string} lock                  gameId of the locked pick, if any
 */

/** @typedef {Object<string, PlayerPicks>} WeekPicks  playerId -> picks, for one week */

/**
 * @typedef {Object} SyncStatus
 * @property {number} atMs      last attempt, successful or not
 * @property {boolean} ok
 * @property {?string} error    why the fetch failed
 * @property {number} [rows]    season rows fetched; only when ok
 */

function props_() {
  return PropertiesService.getScriptProperties();
}

function readJson_(key, fallback) {
  const raw = props_().getProperty(key);
  return raw === null ? fallback : JSON.parse(raw);
}

function encode_(key, value) {
  const json = JSON.stringify(value);
  if (json.length > MAX_PROPERTY_BYTES_) throw new Error(`Stored value too large for ${key} (${json.length} bytes)`);
  return json;
}

function writeJson_(key, value) {
  props_().setProperty(key, encode_(key, value));
}

/** @return {Object<string, Game>} every stored game, id -> game */
function loadGames_() {
  const games = {};
  Object.entries(props_().getProperties())
    .filter(([key]) => key.startsWith(PropertyKey.GAMES_PREFIX))
    .forEach(([, json]) => {
      const weekGames = JSON.parse(json);
      Object.assign(games, weekGames);
    });
  return games;
}

/** @param {Object<string, Game>} games  id -> game */
function saveGames_(games) {
  const gamesByKey = {};
  Object.entries(games).forEach(([id, game]) => {
    const key = PropertyKey.GAMES_PREFIX + game.week;
    gamesByKey[key] = gamesByKey[key] || {};
    gamesByKey[key][id] = game;
  });
  const encodedByKey = {};
  Object.entries(gamesByKey).forEach(([key, weekGames]) => { encodedByKey[key] = encode_(key, weekGames); });
  // false: keep every other property (players, picks, WEB_APP_URL, ...).
  props_().setProperties(encodedByKey, false);
}

/** @return {WeekPicks} */
function loadWeekPicks_(week) {
  return readJson_(PropertyKey.PICKS_PREFIX + week, {});
}

/** @param {WeekPicks} weekPicks */
function saveWeekPicks_(week, weekPicks) {
  writeJson_(PropertyKey.PICKS_PREFIX + week, weekPicks);
}

/** @return {Object<number, WeekPicks>} week -> picks, for every week that has any */
function loadAllPicks_() {
  const allPicks = {};
  Object.entries(props_().getProperties())
    .filter(([key]) => key.startsWith(PropertyKey.PICKS_PREFIX))
    .forEach(([key, json]) => {
      const week = Number(key.slice(PropertyKey.PICKS_PREFIX.length));
      allPicks[week] = JSON.parse(json);
    });
  return allPicks;
}

/** @return {Array<Player>} */
function loadPlayers_() {
  return readJson_(PropertyKey.PLAYERS, []);
}

/** @param {Array<Player>} players */
function savePlayers_(players) {
  writeJson_(PropertyKey.PLAYERS, players);
}

/** @return {?SyncStatus} null before the first sync */
function loadSyncStatus_() {
  return readJson_(PropertyKey.SYNC, null);
}

/** @param {SyncStatus} status */
function saveSyncStatus_(status) {
  writeJson_(PropertyKey.SYNC, status);
}
