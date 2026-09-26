/**
 * Pure game-state rules: freezing, pick validation, lock validation.
 */

/** Epoch ms at which picks and the spread freeze, or null if kickoff is unknown. */
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
  const f = freezeAtMs_(game);
  return f !== null && nowMs >= f;
}

function emptyPlayerPicks_() {
  return { picks: {}, lock: null };
}

/**
 * Validate and apply a pick change. Mutates `mine`.
 * @param {Object} game
 * @param {Object} mine   this player's {picks, lock} for the game's week
 * @param {?string} side  'home' | 'away' | null to clear
 */
function applyPick_(game, mine, side, nowMs) {
  if (side !== 'home' && side !== 'away' && side !== null) throw new Error('Invalid side.');
  if (isFrozen_(game, nowMs)) throw new Error('This game is frozen. Picks closed 1 hour before kickoff.');
  if (side === null) {
    delete mine.picks[game.id];
    if (mine.lock === game.id) mine.lock = null;
  } else {
    mine.picks[game.id] = side;
  }
}

/**
 * Validate and apply a lock change. Mutates `mine`.
 * @param {Object<string,Object>} weekGames  id -> game, all games of that week
 * @param {Object} mine
 * @param {?string} gameId  new lock target, or null to remove the lock
 */
function applyLock_(weekGames, weekType, mine, gameId, nowMs) {
  if (!roundInfo_(weekType).locks) throw new Error('Locks are not used in this round.');
  const current = mine.lock ? weekGames[mine.lock] : null;
  if (current && isFrozen_(current, nowMs)) {
    throw new Error('Your lock is on a game that has already frozen, so it can no longer move.');
  }
  if (gameId === null) {
    mine.lock = null;
    return;
  }
  const target = weekGames[gameId];
  if (!target) throw new Error('That game is not in this week.');
  if (isFrozen_(target, nowMs)) throw new Error('That game is frozen.');
  if (!mine.picks[gameId]) throw new Error('Pick a team in that game before locking it.');
  mine.lock = gameId;
}
