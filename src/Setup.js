/**
 * Owner-only functions, run from the Apps Script editor.
 *
 * These have no trailing underscore so they appear in the editor's Run menu, which also
 * makes them callable from the browser. assertOwner_ blocks that: web app visitors run
 * anonymously, so Session.getActiveUser() is empty for them.
 */

function assertOwner_() {
  const active = Session.getActiveUser().getEmail();
  const owner = Session.getEffectiveUser().getEmail();
  if (!active || active !== owner) throw new Error('Owner only.');
}

/** One-time setup: players, trigger, first sync. Safe to re-run; it never replaces existing tokens. */
function setup() {
  assertOwner_();
  let players = loadPlayers_();
  if (!players.length) {
    players = [];
    for (let i = 1; i <= CONFIG.PLAYER_COUNT; i++) {
      players.push({ id: 'p' + i, token: Utilities.getUuid(), name: 'Player ' + i });
    }
    savePlayers_(players);
  }
  installTrigger_();
  sync_(true);
  printLinks();
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncTrigger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncTrigger').timeBased().everyMinutes(CONFIG.SYNC_EVERY_MINUTES).create();
}

/**
 * Logs each player's personal link. Set the script property WEB_APP_URL to the
 * deployment's /exec URL (Deploy > Manage deployments) before running.
 */
function printLinks() {
  assertOwner_();
  const url = props_().getProperty('WEB_APP_URL');
  if (!url || !/\/exec$/.test(url)) {
    Logger.log('Set script property WEB_APP_URL to your web app URL ending in /exec, then run printLinks again.');
    return;
  }
  loadPlayers_().forEach(function (p) {
    Logger.log('%s (%s): %s?t=%s', p.id, p.name, url, p.token);
  });
}

/** Issue a new link for one player (e.g. 'p2') if theirs leaks. The old link stops working. */
function resetPlayerLink(playerId) {
  assertOwner_();
  const players = loadPlayers_();
  const p = players.filter(function (x) { return x.id === playerId; })[0];
  if (!p) throw new Error('No player ' + playerId + '. Edit the argument, e.g. resetPlayerLink("p2").');
  p.token = Utilities.getUuid();
  savePlayers_(players);
  printLinks();
}

function resetP1Link() { resetPlayerLink('p1'); }
function resetP2Link() { resetPlayerLink('p2'); }

/** Force a sync now, ignoring the throttle. */
function syncNow() {
  assertOwner_();
  sync_(true);
}
