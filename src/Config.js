/**
 * All tunable settings live here. Nothing else in the project hardcodes a rule value.
 *
 * Changing SCORING mid-season only affects games that have not frozen yet:
 * point values are computed and stored at each game's freeze.
 */
const CONFIG = {
  SEASON: 2026,
  // First regular-season week that counts. Earlier weeks are ignored entirely.
  START_WEEK: 3,

  // nflverse schedule, lines and results. Updated every ~20-40 minutes upstream.
  DATA_URL: 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  // nflverse gameday/gametime columns are US Eastern wall-clock time.
  DATA_TIMEZONE: 'America/New_York',

  // A game's picks and its spread freeze this many minutes before kickoff.
  FREEZE_MINUTES_BEFORE_KICKOFF: 60,
  // Time-driven trigger interval. Apps Script allows 1, 5, 10, 15 or 30.
  SYNC_EVERY_MINUTES: 15,
  // Ignore sync calls closer together than this (guards the public entry point).
  MIN_SYNC_GAP_SECONDS: 60,
  // Games missing from a download are only voided when the download looks complete.
  // A full 2026 file has 272 regular-season rows for the season.
  MIN_ROWS_FOR_FULL_FETCH: 250,

  LOCK_MULTIPLIER: 2,
  // nflverse game_type -> round multiplier and whether a lock may be used.
  // Keys are GameType values (Constants.js), written out because top-level code here cannot
  // rely on another file having loaded.
  ROUNDS: {
    REG: { label: 'Week', multiplier: 1, locks: true },
    WC:  { label: 'Wild Card', multiplier: 2, locks: false },
    DIV: { label: 'Divisional', multiplier: 3, locks: false },
    CON: { label: 'Conference', multiplier: 4, locks: false },
    SB:  { label: 'Super Bowl', multiplier: 6, locks: false },
  },

  // Half-point scoring model (agreed 2026-09-26).
  //   p        = favorite win probability = 1 / (1 + e^(-CURVE_K * |spread|))
  //   favAvg   = FAV_AVG_BASE + FAV_AVG_RISE * (p - 0.5) / FAV_AVG_RISE_SPAN
  //   dogAvg   = favAvg - GAP_SLOPE * (p - 0.5)
  //   favLoss  = -1 - FAV_LOSS_SLOPE * (p - 0.5)
  //   favWin   = (favAvg - (1 - p) * favLoss) / p
  //   dogWin   = (dogAvg - p * DOG_LOSS) / (1 - p), capped at DOG_WIN_CAP before multipliers
  //   All values rounded to the nearest half point (halves round away from zero).
  SCORING: {
    CURVE_K: 0.147,            // fitted to 2010-2025 regular-season closing lines
    FAV_AVG_BASE: 2.0,
    FAV_AVG_RISE: 0.5,
    FAV_AVG_RISE_SPAN: 0.45,
    GAP_SLOPE: 3.75,
    FAV_LOSS_SLOPE: 4.5,
    DOG_LOSS: -1,
    DOG_WIN_CAP: 20,
  },

  // Kickoff time columns on the shared sheet.
  SHEET_TIMEZONES: [
    { label: 'US Central', tz: 'America/Chicago' },
    { label: 'Central Europe', tz: 'Europe/Berlin' },
  ],

  // Players setup creates on a fresh install, and the most addPlayer allows on a running one.
  PLAYER_COUNT: 3,
  MAX_NAME_LENGTH: 20,
};
