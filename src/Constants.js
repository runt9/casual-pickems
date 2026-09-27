/**
 * Closed sets of values shared across files. These strings are stored in Script Properties
 * and sent to the pick page, so changing one breaks saved data; Client.html declares
 * matching copies of Side and ScoreStatus.
 *
 * Other files read these only inside functions: Apps Script does not guarantee the order
 * files load in, so top-level code elsewhere cannot rely on them existing yet.
 */

/** The team a player picked: nflverse home or away. */
const Side = Object.freeze({ HOME: 'home', AWAY: 'away' });

/** Outcome of one pick (scorePick_). */
const ScoreStatus = Object.freeze({ NO_PICK: 'nopick', PENDING: 'pending', TIE: 'tie', WIN: 'win', LOSS: 'loss' });

/** nflverse `game_type`. CONFIG.ROUNDS is keyed by these values. */
const GameType = Object.freeze({ REG: 'REG', WC: 'WC', DIV: 'DIV', CON: 'CON', SB: 'SB' });

/** Where a frozen game's line came from (takeSnapshot_). */
const LineSource = Object.freeze({ BEFORE_FREEZE: 'before-freeze', NO_LINE: 'no-line' });
