/**
 * Pure game-state rules: freezing, pick validation, lock validation.
 */

/** Epoch ms at which picks and the line freeze, or null if kickoff is unknown. */
function freezeAtMs_(game) {
  if (game.kickoffMs === null || game.kickoffMs === undefined) return null;
  return game.kickoffMs - CONFIG.FREEZE_MINUTES_BEFORE_KICKOFF * 60 * 1000;
}

/**
 * A game is frozen once its freeze time has passed, or once a snapshot exists.
 * The time check matters between the freeze moment and the next sync, when the
 * snapshot has not been written yet but picks must already be refused.
 */
function isFrozen_(game, nowMs) {
  if (game.snap) return true;
  const freezeAtMs = freezeAtMs_(game);
  if (freezeAtMs === null) return false;
  return nowMs >= freezeAtMs;
}

/** @return {PlayerPicks} */
function emptyPlayerPicks_() {
  return { picks: {}, lock: null };
}

/**
 * Validate and apply a pick change. Mutates `mine`.
 * @param {Game} game
 * @param {PlayerPicks} mine  this player's picks for the game's week
 * @param {?string} side      a Side, or null to clear the pick (which also clears its lock)
 */
function applyPick_(game, mine, side, nowMs) {
  const allowedSides = [Side.HOME, Side.AWAY, null];
  if (!allowedSides.includes(side)) throw new Error('Invalid side.');
  if (isFrozen_(game, nowMs)) {
    throw new Error(`This game is frozen. Picks closed ${CONFIG.FREEZE_MINUTES_BEFORE_KICKOFF} minutes before kickoff.`);
  }

  if (side === null) {
    delete mine.picks[game.id];
    if (mine.lock === game.id) mine.lock = null;
    return;
  }
  mine.picks[game.id] = side;
}

/**
 * Validate and apply a lock change. Mutates `mine`.
 * @param {Object<string, Game>} weekGames  id -> game, every live game of that week
 * @param {string} weekType                 the week's GameType
 * @param {PlayerPicks} mine
 * @param {?string} gameId                  new lock target, or null to remove the lock
 */
function applyLock_(weekGames, weekType, mine, gameId, nowMs) {
  if (!roundInfo_(weekType).locks) throw new Error('Locks are not used in this round.');

  // gameId comes from the browser; an own-property check keeps names like "constructor" out.
  const inWeek = (id) => Object.prototype.hasOwnProperty.call(weekGames, id);
  const currentLockGame = inWeek(mine.lock) ? weekGames[mine.lock] : null;
  if (currentLockGame && isFrozen_(currentLockGame, nowMs)) {
    throw new Error('Your lock is on a game that has already frozen, so it can no longer move.');
  }
  if (gameId === null) {
    mine.lock = null;
    return;
  }

  if (!inWeek(gameId)) throw new Error('That game is not in this week.');
  if (isFrozen_(weekGames[gameId], nowMs)) throw new Error('That game is frozen.');
  if (!mine.picks[gameId]) throw new Error('Pick a team in that game before locking it.');
  mine.lock = gameId;
}
