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
  if (!loadPlayers_().length) {
    const players = [];
    for (let number = 1; number <= CONFIG.PLAYER_COUNT; number++) {
      players.push({ id: `p${number}`, token: Utilities.getUuid(), name: `Player ${number}` });
    }
    savePlayers_(players);
  }
  installTrigger_();
  sync_(true);
  printLinks();
}

function installTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'syncTrigger')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('syncTrigger').timeBased().everyMinutes(CONFIG.SYNC_EVERY_MINUTES).create();
}

/**
 * Logs each player's personal link. Set the script property WEB_APP_URL to the
 * deployment's /exec URL (Deploy > Manage deployments) before running.
 */
function printLinks() {
  assertOwner_();
  const url = props_().getProperty(PropertyKey.WEB_APP_URL);
  if (!url || !url.endsWith('/exec')) {
    Logger.log('Set script property WEB_APP_URL to your web app URL ending in /exec, then run printLinks again.');
    return;
  }
  loadPlayers_().forEach((player) => {
    Logger.log('%s (%s): %s?t=%s', player.id, player.name, url, player.token);
  });
}

/** Issue a new link for one player (e.g. 'p2') if theirs leaks. The old link stops working. */
function resetPlayerLink(playerId) {
  assertOwner_();
  const players = loadPlayers_();
  const player = players.find((stored) => stored.id === playerId);
  if (!player) throw new Error(`No player ${playerId}. Edit the argument, e.g. resetPlayerLink("p2").`);
  player.token = Utilities.getUuid();
  savePlayers_(players);
  printLinks();
}

function resetP1Link() { resetPlayerLink('p1'); }
function resetP2Link() { resetPlayerLink('p2'); }
function resetP3Link() { resetPlayerLink('p3'); }

/**
 * Adds one player to a running season and logs every link; existing links do not change.
 * The new player is not in games that froze before now (playsGame_). Refuses once
 * CONFIG.PLAYER_COUNT players exist, so running it twice by mistake cannot add a spare.
 */
function addPlayer() {
  assertOwner_();
  withScriptLock_(() => {
    const players = loadPlayers_();
    if (players.length >= CONFIG.PLAYER_COUNT) {
      throw new Error(`There are already ${players.length} players. Raise CONFIG.PLAYER_COUNT first to add another.`);
    }
    const number = players.length + 1;
    players.push({ id: `p${number}`, token: Utilities.getUuid(), name: `Player ${number}`, joinedAtMs: now_() });
    savePlayers_(players);
  });
  sync_(true);
  printLinks();
}

/** Force a sync now, ignoring the throttle. */
function syncNow() {
  assertOwner_();
  sync_(true);
}
