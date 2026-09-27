/**
 * Writes the shared, view-only spreadsheet: a Standings tab and one tab per week.
 * All visibility decisions come from gameView_/weekSummary_ (Model.js).
 */

const STANDINGS_SHEET_ = 'Standings';
const POINTS_FORMAT_ = '+0.0;-0.0;0.0';

/**
 * Everything paint_ needs to draw one tab. Rows and columns are 1-based sheet positions.
 * @typedef {Object} Layout
 * @property {Array<Array<(string|number)>>} rows   short rows are padded to `width`
 * @property {number} width
 * @property {Array<number>} headerRows              bold on a tinted background
 * @property {?number} totalRow                      bold, or null for none
 * @property {number} frozenRows                     rows kept in view while scrolling; 0 for none
 * @property {Array<Array<number>>} pointsRanges     [row, column, rowCount, columnCount] shown as points
 */

/**
 * Redraws only tabs whose content changed since the last render (tracked by a hash in
 * Script Properties), which keeps each sync fast. Tabs are created in order: Standings
 * first, then weeks ascending; later weeks (playoffs) are appended at the end. Existing
 * tabs are never reordered, so hiding or moving tabs by hand is respected.
 * @param {Object<string, Game>} games
 * @param {Object<number, WeekPicks>} allPicks
 * @param {Array<Player>} players
 */
function renderSheets_(games, allPicks, players, nowMs) {
  if (!players.length) return;
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const season = seasonSummary_(games, allPicks, players, nowMs);
  const drawnHashes = readJson_(PropertyKey.RENDER, {});

  // index: where a missing tab is inserted; undefined appends it after the last tab.
  const draw = (tabName, layout, index) => {
    const hash = hashOf_(layout);
    let sheet = spreadsheet.getSheetByName(tabName);
    if (sheet && drawnHashes[tabName] === hash) return;
    if (!sheet) sheet = index === undefined ? spreadsheet.insertSheet(tabName) : spreadsheet.insertSheet(tabName, index);
    paint_(sheet, layout);
    drawnHashes[tabName] = hash;
  };

  const standings = standingsLayout_(season, players, nowMs);
  draw(STANDINGS_SHEET_, standings, 0);
  season.weeks.forEach((week) => {
    const gamesOfWeek = weekGames_(games, week.week);
    const layout = weekLayout_(week, gamesOfWeek, allPicks[week.week] || {}, players, nowMs);
    draw(week.label, layout);
  });
  writeJson_(PropertyKey.RENDER, drawnHashes);
}

/** 32-bit FNV-1a over the layout JSON; only used to detect changes. */
function hashOf_(layout) {
  const json = JSON.stringify(layout);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Every string cell is formatted as plain text BEFORE writing so Sheets never reinterprets
 * values like "+4.5 / -1.5" (formula) or "2-1" (date). Numbers get a points or integer format.
 * @param {SpreadsheetApp.Sheet} sheet
 * @param {Layout} layout
 */
function paint_(sheet, layout) {
  const { rows, width, headerRows, totalRow, frozenRows, pointsRanges } = layout;
  const padRow = (row) => {
    const padded = row.slice();
    while (padded.length < width) padded.push('');
    return padded;
  };
  const cellFormat = (value) => (typeof value === 'number' ? '0' : '@');

  sheet.clear();
  const paddedRows = rows.map(padRow);
  const range = sheet.getRange(1, 1, paddedRows.length, width);
  range.setNumberFormats(paddedRows.map((row) => row.map(cellFormat)));
  range.setValues(paddedRows);
  pointsRanges.forEach(([row, column, rowCount, columnCount]) => {
    sheet.getRange(row, column, rowCount, columnCount).setNumberFormat(POINTS_FORMAT_);
  });

  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  headerRows.forEach((row) => sheet.getRange(row, 1, 1, width).setFontWeight('bold').setBackground('#e8eaf6'));
  if (totalRow) sheet.getRange(totalRow, 1, 1, width).setFontWeight('bold');
  if (frozenRows) sheet.setFrozenRows(frozenRows);
  sheet.autoResizeColumns(1, width);
}

/**
 * Prevent user-controlled text (display names) from being parsed as a formula. Cells are
 * also formatted as plain text (paint_); this is a second guard in case that is not honored.
 * "=Bob" -> "'=Bob"
 */
function safeText_(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

/** @return {Object<string, string>} playerId -> display name, safe to write to a cell */
function sheetNames_(players) {
  const nameById = {};
  players.forEach((player) => { nameById[player.id] = safeText_(player.name); });
  return nameById;
}

/** "Al" for a single winner, "Tie" for several. */
function winnerText_(winnerIds, nameById) {
  if (winnerIds.length === 1) return nameById[winnerIds[0]];
  return 'Tie';
}

/** "Sun Sep 27, 12:00 PM", or "TBD" while kickoff is unknown. */
function fmtTime_(ms, tz) {
  if (ms === null || ms === undefined) return 'TBD';
  return Utilities.formatDate(new Date(ms), tz, 'EEE MMM d, h:mm a');
}

/** "+4.5", "-1", "0" */
function fmtPts_(points) {
  return points > 0 ? `+${points}` : String(points);
}

/** "GB -4.5", "Pick'em", or "" before the line is frozen. */
function lineText_(game, line) {
  if (!line) return '';
  if (line.fav === null) return "Pick'em";
  const favoriteTeam = line.fav === Side.HOME ? game.home : game.away;
  return `${favoriteTeam} -${Math.abs(line.spread)}`;
}

/**
 * The Standings tab. A week gets a row once any of its games has a frozen line.
 *
 *   NFL Pick'em 2026
 *   Updated Sun Sep 27, 1:00 PM US Central         (+ "   WARNING: last data fetch failed: <error>")
 *
 *   Week             Status        Al      Bob     Winner
 *   Week 3           Final         22      -13     Al
 *   Week 4           In progress   8.5     4
 *
 *   Season                         Al      Bob
 *   Regular season   In progress   30.5    -9      Al (leading)
 *   Playoffs         In progress   0       0
 *   Full season      In progress   30.5    -9      Al (leading)
 *
 *   Stats                          Al      Bob
 *   Weeks won                      1       0
 *   Picks W-L-T                    9-7-0   8-8-0
 *   Upsets called                  2       3
 *   Locks W-L                      1-0     0-1
 *   Missed picks                   1       2
 *
 * @param {SeasonSummary} season
 * @param {Array<Player>} players
 * @return {Layout}
 */
function standingsLayout_(season, players, nowMs) {
  const nameById = sheetNames_(players);
  const names = players.map((player) => nameById[player.id]);
  const firstPlayerColumn = 3;
  const width = 2 + players.length + 1;
  const rows = [];
  const headerRows = [];
  const pointsRows = [];
  const nextRow = () => rows.length + 1;

  const syncStatus = loadSyncStatus_();
  const fetchFailed = syncStatus && !syncStatus.ok;
  const fetchWarning = fetchFailed ? `   WARNING: last data fetch failed: ${syncStatus.error}` : '';
  const { label: timezoneLabel, tz } = CONFIG.SHEET_TIMEZONES[0];
  rows.push([`NFL Pick'em ${CONFIG.SEASON}`]);
  rows.push([`Updated ${fmtTime_(nowMs, tz)} ${timezoneLabel}${fetchWarning}`]);
  rows.push(['']);

  const hasFrozenGame = (week) => players.some((player) => {
    const totals = week.byPlayer[player.id];
    return totals.wins + totals.losses + totals.ties + totals.pending + totals.missed > 0;
  });
  headerRows.push(nextRow());
  rows.push(['Week', 'Status', ...names, 'Winner']);
  season.weeks.filter(hasFrozenGame).forEach((week) => {
    pointsRows.push(nextRow());
    const points = players.map((player) => week.byPlayer[player.id].points);
    const winner = week.complete ? winnerText_(week.winnerIds, nameById) : '';
    rows.push([week.label, week.complete ? 'Final' : 'In progress', ...points, winner]);
  });
  rows.push(['']);

  const regularWeeks = season.weeks.filter((week) => week.type === GameType.REG);
  const regularFinal = regularWeeks.length > 0 && regularWeeks.every((week) => week.complete);
  const superBowl = season.weeks.find((week) => week.type === GameType.SB);
  const superBowlFinal = Boolean(superBowl) && superBowl.complete;
  const fullFinal = regularFinal && superBowlFinal;
  const leaderText = (totalKey, final) => {
    const points = players.map((player) => season.totals[player.id][totalKey]);
    const topPoints = Math.max(...points);
    const leaders = players.filter((player, index) => points[index] === topPoints);
    if (leaders.length > 1) return final ? 'Tie' : 'Tied';
    return `${nameById[leaders[0].id]} ${final ? '(champion)' : '(leading)'}`;
  };
  // The rules name two champions, regular season and full season; the playoffs alone have none.
  const seasonParts = [
    { label: 'Regular season', totalKey: 'regular', final: regularFinal, hasChampion: true },
    { label: 'Playoffs', totalKey: 'playoffs', final: fullFinal, hasChampion: false },
    { label: 'Full season', totalKey: 'full', final: fullFinal, hasChampion: true },
  ];
  headerRows.push(nextRow());
  rows.push(['Season', '', ...names, '']);
  seasonParts.forEach(({ label, totalKey, final, hasChampion }) => {
    pointsRows.push(nextRow());
    const points = players.map((player) => season.totals[player.id][totalKey]);
    const leader = hasChampion ? leaderText(totalKey, final) : '';
    rows.push([label, final ? 'Final' : 'In progress', ...points, leader]);
  });
  rows.push(['']);

  const stats = [
    ['Weeks won', (totals) => totals.weeksWon],
    ['Picks W-L-T', (totals) => `${totals.wins}-${totals.losses}-${totals.ties}`],
    ['Upsets called', (totals) => totals.upsets],
    ['Locks W-L', (totals) => `${totals.lockWins}-${totals.lockLosses}`],
    ['Missed picks', (totals) => totals.missed],
  ];
  headerRows.push(nextRow());
  rows.push(['Stats', '', ...names, '']);
  stats.forEach(([label, valueOf]) => {
    const values = players.map((player) => valueOf(season.totals[player.id]));
    rows.push([label, '', ...values]);
  });

  return {
    rows, width, headerRows, totalRow: null, frozenRows: 0,
    pointsRanges: pointsRows.map((row) => [row, firstPlayerColumn, 1, players.length]),
  };
}

/**
 * One week's tab: a row per game, then the week total. Each game row, by column:
 *
 *   Kickoff (US Central)       Thu Sep 24, 7:15 PM
 *   Kickoff (Central Europe)   Fri Sep 25, 2:15 AM
 *   Away                       Falcons (ATL)
 *   Home                       Packers (GB)
 *   Status                     Open until Thu Sep 24, 6:15 PM | Frozen, line pending | Frozen | In progress | Final
 *   Line                       GB -4.5
 *   Favorite win / loss        W +4 / L -1.5
 *   Underdog win / loss        W +6.5 / L -1
 *   Al pick, Bob pick          GB (LOCK) | ATL | no pick | picked (open game, others' view) | "" (no pick yet)
 *   Final                      ATL 35 - 14 GB
 *   Al pts, Bob pts            -3 | 6.5   (only once final)
 *
 * Above the header row: "Week 3 2026" and a note on locks (regular season) or the round
 * multiplier (playoffs). Below the games: "Week total so far" (or "Week total (final)"),
 * and "Winner: Al" once the week is complete.
 *
 * @param {WeekInfo & WeekSummary} week
 * @param {Array<Game>} gamesOfWeek
 * @param {WeekPicks} weekPicks
 * @param {Array<Player>} players
 * @return {Layout}
 */
function weekLayout_(week, gamesOfWeek, weekPicks, players, nowMs) {
  const round = roundInfo_(week.type);
  const timezones = CONFIG.SHEET_TIMEZONES;
  const nameById = sheetNames_(players);
  const names = players.map((player) => nameById[player.id]);
  const header = [
    ...timezones.map(({ label }) => `Kickoff (${label})`),
    'Away', 'Home', 'Status', 'Line', 'Favorite win / loss', 'Underdog win / loss',
    ...names.map((name) => `${name} pick`),
    'Final',
    ...names.map((name) => `${name} pts`),
  ];
  const width = header.length;
  const firstPointsColumn = width - players.length + 1;
  const rows = [];
  const nextRow = () => rows.length + 1;

  const roundNote = round.multiplier > 1
    ? `Round multiplier x${round.multiplier}, no locks`
    : `Lock doubles one pick. Picks and lines appear ${CONFIG.FREEZE_MINUTES_BEFORE_KICKOFF} minutes before each kickoff.`;
  rows.push([`${week.label} ${CONFIG.SEASON}`]);
  rows.push([roundNote]);
  rows.push(['']);
  const headerRow = nextRow();
  rows.push(header);

  const statusText = (game, view) => {
    if (view.final) return 'Final';
    if (!view.frozen) return `Open until ${fmtTime_(view.freezeAtMs, timezones[0].tz)}`;
    if (!view.line) return 'Frozen, line pending';
    return nowMs >= game.kickoffMs ? 'In progress' : 'Frozen';
  };
  const winLossText = (win, loss) => `W ${fmtPts_(win)} / L ${fmtPts_(loss)}`;
  const pickText = (game, playerView) => {
    if (!playerView.visible) return playerView.hasPick ? 'picked' : '';
    if (!playerView.side) return 'no pick';
    const team = playerView.side === Side.HOME ? game.home : game.away;
    return playerView.locked ? `${team} (LOCK)` : team;
  };
  const pointsCell = (view, playerView) => {
    if (!view.final) return '';
    const score = playerView.visible ? playerView.score : null;
    if (!score || score.points === null) return '';
    return score.points;
  };

  gamesOfWeek.forEach((game) => {
    const view = gameView_(game, weekPicks, players, nowMs, null);
    const values = view.line ? view.line.values : null;
    rows.push([
      ...timezones.map(({ tz }) => fmtTime_(game.kickoffMs, tz)),
      `${teamName_(game.away)} (${game.away})`,
      `${teamName_(game.home)} (${game.home})`,
      statusText(game, view),
      lineText_(game, view.line),
      values ? winLossText(values.favWin, values.favLoss) : '',
      values ? winLossText(values.dogWin, values.dogLoss) : '',
      ...view.players.map((playerView) => pickText(game, playerView)),
      view.final ? `${game.away} ${game.awayScore} - ${game.homeScore} ${game.home}` : '',
      ...view.players.map((playerView) => pointsCell(view, playerView)),
    ]);
  });

  rows.push(['']);
  const totalRow = nextRow();
  const totalCells = new Array(width).fill('');
  totalCells[0] = week.complete ? 'Week total (final)' : 'Week total so far';
  players.forEach((player, index) => { totalCells[firstPointsColumn - 1 + index] = week.byPlayer[player.id].points; });
  rows.push(totalCells);
  if (week.complete) rows.push([`Winner: ${winnerText_(week.winnerIds, nameById)}`]);

  return {
    rows, width, headerRows: [headerRow], totalRow, frozenRows: headerRow,
    pointsRanges: [[headerRow + 1, firstPointsColumn, totalRow - headerRow, players.length]],
  };
}
