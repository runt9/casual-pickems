/**
 * Pure scoring functions. No Apps Script services used here.
 *
 * Spread convention follows nflverse `spread_line`: positive means the HOME team is
 * favored by that many points, negative means the AWAY team is favored, 0 is a pick'em.
 * Result convention follows nflverse `result`: home score minus away score.
 */

/**
 * Base point values for one game, before lock and round multipliers.
 * @typedef {Object} PointValues
 * @property {number} favWin
 * @property {number} favLoss
 * @property {number} dogWin   capped at CONFIG.SCORING.DOG_WIN_CAP
 * @property {number} dogLoss
 */

/**
 * @typedef {Object} PickScore
 * @property {string} status       a ScoreStatus
 * @property {?number} points      null while the game is not final
 * @property {?boolean} pickedFav  null when there is no pick; true for either side of a pick'em
 * @property {boolean} upset       the pick was the underdog and it won
 */

/** Round to the nearest half point; exact quarter ties round away from zero. */
function roundHalf_(value) {
  const rounded = Math.round(Math.abs(value) * 2) / 2;
  return value < 0 ? -rounded : rounded;
}

/** Favorite's win probability for an absolute spread. */
function favWinProb_(absSpread) {
  return 1 / (1 + Math.exp(-CONFIG.SCORING.CURVE_K * absSpread));
}

/**
 * Base point values for a game with this spread. The formula is documented on CONFIG.SCORING.
 * @return {PointValues}
 */
function pointValues_(spread) {
  const scoring = CONFIG.SCORING;
  const absSpread = Math.abs(spread);
  const favProb = favWinProb_(absSpread);
  const favAvg = scoring.FAV_AVG_BASE + scoring.FAV_AVG_RISE * (favProb - 0.5) / scoring.FAV_AVG_RISE_SPAN;
  const dogAvg = favAvg - scoring.GAP_SLOPE * (favProb - 0.5);
  const favLossUnrounded = -1 - scoring.FAV_LOSS_SLOPE * (favProb - 0.5);
  const dogWinUncapped = roundHalf_((dogAvg - favProb * scoring.DOG_LOSS) / (1 - favProb));
  return {
    favWin: roundHalf_((favAvg - (1 - favProb) * favLossUnrounded) / favProb),
    favLoss: roundHalf_(favLossUnrounded),
    dogWin: Math.min(scoring.DOG_WIN_CAP, dogWinUncapped),
    dogLoss: scoring.DOG_LOSS,
  };
}

/** The favored Side, or null for a pick'em. */
function favoriteSide_(spread) {
  if (spread > 0) return Side.HOME;
  if (spread < 0) return Side.AWAY;
  return null;
}

/** The CONFIG.ROUNDS entry for a GameType. */
function roundInfo_(gameType) {
  const round = CONFIG.ROUNDS[gameType];
  if (!round) throw new Error(`Unknown game type: ${gameType}`);
  return round;
}

/**
 * Score one player's pick on one game.
 * @param {Object} pick
 * @param {?string} pick.side      a Side, or null (no pick)
 * @param {Snapshot} pick.snap     the game's frozen line; required
 * @param {?number} pick.result    home - away, null while not final
 * @param {string} pick.gameType   a GameType
 * @param {boolean} pick.locked
 * @return {PickScore}
 */
function scorePick_({ side, snap, result, gameType, locked }) {
  if (!side) return { status: ScoreStatus.NO_PICK, points: 0, pickedFav: null, upset: false };

  // Both sides of a pick'em pay the same, so either one counts as the favorite.
  const favorite = favoriteSide_(snap.spread);
  const pickedFav = favorite === null || side === favorite;
  if (result === null || result === undefined) {
    return { status: ScoreStatus.PENDING, points: null, pickedFav, upset: false };
  }
  if (result === 0) return { status: ScoreStatus.TIE, points: 0, pickedFav, upset: false };

  const winner = result > 0 ? Side.HOME : Side.AWAY;
  const correct = side === winner;
  const winValue = pickedFav ? snap.values.favWin : snap.values.dogWin;
  const lossValue = pickedFav ? snap.values.favLoss : snap.values.dogLoss;
  const basePoints = correct ? winValue : lossValue;
  const roundMultiplier = roundInfo_(gameType).multiplier;
  const lockMultiplier = locked ? CONFIG.LOCK_MULTIPLIER : 1;
  return {
    status: correct ? ScoreStatus.WIN : ScoreStatus.LOSS,
    points: basePoints * roundMultiplier * lockMultiplier,
    pickedFav,
    // A pick'em counts as picking the favorite, so it can never be an upset.
    upset: correct && !pickedFav,
  };
}
