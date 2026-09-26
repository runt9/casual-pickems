/**
 * Persistence in Script Properties. Only the script owner can read these; the
 * shared spreadsheet never contains unfrozen picks or unfrozen lines.
 *
 * Keys:
 *   players        [{id, token, name}]
 *   g:<week>       {gameId: game}          one key per week keeps each value < 9 KB
 *   p:<week>       {playerId: {picks: {gameId: 'home'|'away'}, lock: ?gameId}}
 *   sync           {atMs, ok, error, rows}
 */
const MAX_PROPERTY_BYTES_ = 9000;

function props_() {
  return PropertiesService.getScriptProperties();
}

function readJson_(key, fallback) {
  const raw = props_().getProperty(key);
  return raw === null ? fallback : JSON.parse(raw);
}

function encode_(key, value) {
  const s = JSON.stringify(value);
  if (s.length > MAX_PROPERTY_BYTES_) throw new Error('Stored value too large for ' + key + ' (' + s.length + ' bytes)');
  return s;
}

function writeJson_(key, value) {
  props_().setProperty(key, encode_(key, value));
}

/** All stored games as id -> game. */
function loadGames_() {
  const all = props_().getProperties();
  const games = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('g:') !== 0) return;
    const wk = JSON.parse(all[k]);
    Object.keys(wk).forEach(function (id) { games[id] = wk[id]; });
  });
  return games;
}

function saveGames_(games) {
  const byWeek = {};
  Object.keys(games).forEach(function (id) {
    const g = games[id];
    (byWeek['g:' + g.week] = byWeek['g:' + g.week] || {})[id] = g;
  });
  const batch = {};
  Object.keys(byWeek).forEach(function (k) { batch[k] = encode_(k, byWeek[k]); });
  props_().setProperties(batch, false);
}

function loadWeekPicks_(week) {
  return readJson_('p:' + week, {});
}

function saveWeekPicks_(week, picks) {
  writeJson_('p:' + week, picks);
}

/** week -> {playerId: {picks, lock}} for every week that has picks. */
function loadAllPicks_() {
  const all = props_().getProperties();
  const out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('p:') === 0) out[Number(k.slice(2))] = JSON.parse(all[k]);
  });
  return out;
}

function loadPlayers_() {
  return readJson_('players', []);
}

function savePlayers_(players) {
  writeJson_('players', players);
}

function loadSyncStatus_() {
  return readJson_('sync', null);
}

function saveSyncStatus_(status) {
  writeJson_('sync', status);
}
