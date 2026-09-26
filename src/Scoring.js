/**
 * Pure scoring functions. No Apps Script services used here.
 *
 * Spread convention follows nflverse `spread_line`: positive means the HOME team is
 * favored by that many points, negative means the AWAY team is favored, 0 is a pick'em.
 * Result convention follows nflverse `result`: home score minus away score.
 */

/** Round to the nearest half point; exact quarter ties round away from zero. */
function roundHalf_(x) {
  const r = Math.round(Math.abs(x) * 2) / 2;
  return x < 0 ? -r : r;
}

/** Favorite's win probability for an absolute spread. */
function favWinProb_(absSpread) {
  return 1 / (1 + Math.exp(-CONFIG.SCORING.CURVE_K * absSpread));
}

/**
 * Base point values (before lock/round multipliers) for a game with this spread.
 * @return {{favWin:number, favLoss:number, dogWin:number, dogLoss:number}}
 */
function pointValues_(spread) {
  const S = CONFIG.SCORING;
  const p = favWinProb_(Math.abs(spread));
  const favAvg = S.FAV_AVG_BASE + S.FAV_AVG_RISE * (p - 0.5) / S.FAV_AVG_RISE_SPAN;
  const dogAvg = favAvg - S.GAP_SLOPE * (p - 0.5);
  const favLossRaw = -1 - S.FAV_LOSS_SLOPE * (p - 0.5);
  return {
    favWin: roundHalf_((favAvg - (1 - p) * favLossRaw) / p),
    favLoss: roundHalf_(favLossRaw),
    dogWin: Math.min(S.DOG_WIN_CAP, roundHalf_((dogAvg - p * S.DOG_LOSS) / (1 - p))),
    dogLoss: S.DOG_LOSS,
  };
}

/** 'home' | 'away' | null (pick'em). */
function favoriteSide_(spread) {
  if (spread > 0) return 'home';
  if (spread < 0) return 'away';
  return null;
}

function roundInfo_(gameType) {
  const r = CONFIG.ROUNDS[gameType];
  if (!r) throw new Error('Unknown game type: ' + gameType);
  return r;
}

/**
 * Score one player's pick on one game.
 * @param {Object} o
 * @param {?string} o.side       'home' | 'away' | null (no pick)
 * @param {Object}  o.snap       frozen snapshot {spread, values}; required
 * @param {?number} o.result     home - away, null while not final
 * @param {string}  o.gameType   nflverse game_type
 * @param {boolean} o.locked
 * @return {{status:string, points:?number, pickedFav:?boolean, upset:boolean}}
 *   status: 'nopick' | 'pending' | 'tie' | 'win' | 'loss'
 */
function scorePick_(o) {
  if (!o.side) return { status: 'nopick', points: 0, pickedFav: null, upset: false };
  const fav = favoriteSide_(o.snap.spread);
  const pickedFav = fav === null || o.side === fav;
  if (o.result === null || o.result === undefined) {
    return { status: 'pending', points: null, pickedFav: pickedFav, upset: false };
  }
  if (o.result === 0) return { status: 'tie', points: 0, pickedFav: pickedFav, upset: false };

  const winner = o.result > 0 ? 'home' : 'away';
  const correct = o.side === winner;
  const v = o.snap.values;
  const base = correct ? (pickedFav ? v.favWin : v.dogWin) : (pickedFav ? v.favLoss : v.dogLoss);
  const lockMult = o.locked ? CONFIG.LOCK_MULTIPLIER : 1;
  return {
    status: correct ? 'win' : 'loss',
    points: base * roundInfo_(o.gameType).multiplier * lockMult,
    pickedFav: pickedFav,
    upset: correct && fav !== null && !pickedFav,
  };
}
