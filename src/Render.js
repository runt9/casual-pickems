/**
 * Writes the shared, view-only spreadsheet: a Standings tab and one tab per week.
 * All visibility decisions come from gameView_/weekSummary_ (Model.js).
 */

const STANDINGS_SHEET_ = 'Standings';

function renderSheets_(games, allPicks, players, nowMs) {
  if (!players.length) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const season = seasonSummary_(games, allPicks, players, nowMs);

  renderStandings_(ss, season, players, nowMs);
  const weeks = listWeeks_(games); // ascending: Week 3 ... Super Bowl
  weeks.forEach(function (w, i) {
    const sh = renderWeek_(ss, w, weekGames_(games, w.week), allPicks[w.week] || {}, players, nowMs,
      season.weeks.filter(function (x) { return x.week === w.week; })[0]);
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 2);
  });
  ss.setActiveSheet(ss.getSheetByName(STANDINGS_SHEET_));
  ss.moveActiveSheet(1);
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** Prevent user-controlled text (display names) from being parsed as a formula. */
function safeText_(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fmtTime_(ms, tz) {
  return ms === null || ms === undefined ? 'TBD' : Utilities.formatDate(new Date(ms), tz, 'EEE MMM d, h:mm a');
}

function fmtPts_(x) {
  return (x > 0 ? '+' : '') + x;
}

function lineText_(g, line) {
  if (!line) return '';
  if (line.fav === null) return "Pick'em";
  return (line.fav === 'home' ? g.home : g.away) + ' -' + Math.abs(line.spread);
}

function writeBlock_(sh, rows, width) {
  const padded = rows.map(function (r) {
    const out = r.slice();
    while (out.length < width) out.push('');
    return out;
  });
  sh.getRange(1, 1, padded.length, width).setValues(padded);
}

function renderStandings_(ss, season, players, nowMs) {
  const sh = getOrCreateSheet_(ss, STANDINGS_SHEET_);
  sh.clear();
  const names = players.map(function (p) { return safeText_(p.name); });
  const nameOf = {};
  players.forEach(function (p, i) { nameOf[p.id] = names[i]; });
  const width = 2 + players.length + 1;
  const status = loadSyncStatus_();
  const rows = [];
  const bold = [];
  const ptsRows = [];

  rows.push(["NFL Pick'em " + CONFIG.SEASON]);
  rows.push(['Updated ' + fmtTime_(nowMs, CONFIG.SHEET_TIMEZONES[0].tz) + ' ' + CONFIG.SHEET_TIMEZONES[0].label +
    (status && !status.ok ? '   WARNING: last data fetch failed: ' + status.error : '')]);
  rows.push(['']);

  const regWeeks = season.weeks.filter(function (w) { return w.type === 'REG'; });
  const poWeeks = season.weeks.filter(function (w) { return w.type !== 'REG'; });
  const started = function (w) {
    return players.some(function (p) {
      const b = w.byPlayer[p.id];
      return b.wins + b.losses + b.ties + b.pending + b.missed > 0;
    });
  };

  bold.push(rows.length + 1);
  rows.push(['Week', 'Status'].concat(names, ['Winner']));
  season.weeks.filter(started).forEach(function (w) {
    ptsRows.push(rows.length + 1);
    rows.push([w.label, w.complete ? 'Final' : 'In progress']
      .concat(players.map(function (p) { return w.byPlayer[p.id].points; }),
        [w.complete ? (w.winnerIds.length === 1 ? nameOf[w.winnerIds[0]] : 'Tie') : '']));
  });
  rows.push(['']);

  const regComplete = regWeeks.length > 0 && regWeeks.every(function (w) { return w.complete; });
  const sb = poWeeks.filter(function (w) { return w.type === 'SB'; })[0];
  const fullComplete = regComplete && !!sb && sb.complete;
  const leader = function (key, done) {
    const vals = players.map(function (p) { return season.totals[p.id][key]; });
    const best = Math.max.apply(null, vals);
    const top = players.filter(function (p, i) { return vals[i] === best; });
    if (top.length > 1) return done ? 'Tie' : 'Tied';
    return nameOf[top[0].id] + (done ? ' (champion)' : ' (leading)');
  };

  bold.push(rows.length + 1);
  rows.push(['Season', ''].concat(names, ['']));
  [['Regular season', 'regular', regComplete], ['Playoffs', 'playoffs', fullComplete], ['Full season', 'full', fullComplete]]
    .forEach(function (x) {
      ptsRows.push(rows.length + 1);
      rows.push([x[0], x[2] ? 'Final' : 'In progress']
        .concat(players.map(function (p) { return season.totals[p.id][x[1]]; }), [leader(x[1], x[2])]));
    });
  rows.push(['']);
  bold.push(rows.length + 1);
  rows.push(['Stats', ''].concat(names, ['']));
  const stat = function (label, fn) { rows.push([label, ''].concat(players.map(function (p) { return fn(season.totals[p.id]); }))); };
  stat('Weeks won', function (t) { return t.weeksWon; });
  stat('Picks W-L-T', function (t) { return t.wins + '-' + t.losses + '-' + t.ties; });
  stat('Upsets called', function (t) { return t.upsets; });
  stat('Locks W-L', function (t) { return t.lockWins + '-' + t.lockLosses; });
  stat('Missed picks', function (t) { return t.missed; });

  writeBlock_(sh, rows, width);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  bold.forEach(function (r) { sh.getRange(r, 1, 1, width).setFontWeight('bold').setBackground('#e8eaf6'); });
  ptsRows.forEach(function (r) { sh.getRange(r, 3, 1, players.length).setNumberFormat('+0.0;-0.0;0.0'); });
  sh.autoResizeColumns(1, width);
}

function renderWeek_(ss, w, games, weekPicks, players, nowMs, summary) {
  const sh = getOrCreateSheet_(ss, w.label);
  sh.clear();
  const round = roundInfo_(w.type);
  const tzs = CONFIG.SHEET_TIMEZONES;
  const names = players.map(function (p) { return safeText_(p.name); });
  const header = tzs.map(function (t) { return 'Kickoff (' + t.label + ')'; })
    .concat(['Away', 'Home', 'Status', 'Line', 'Favorite win / loss', 'Underdog win / loss'])
    .concat(names.map(function (n) { return n + ' pick'; }))
    .concat(['Final'])
    .concat(names.map(function (n) { return n + ' pts'; }));
  const width = header.length;
  const firstPtsCol = width - players.length + 1;

  const rows = [];
  rows.push([w.label + ' ' + CONFIG.SEASON]);
  rows.push([round.multiplier > 1 ? 'Round multiplier x' + round.multiplier + ', no locks' :
    'Lock doubles one pick. Picks and lines appear 1 hour before each kickoff.']);
  rows.push(['']);
  const headerRow = rows.length + 1;
  rows.push(header);

  games.forEach(function (g) {
    const v = gameView_(g, weekPicks, players, nowMs, null);
    const status = v.final ? 'Final'
      : v.frozen ? (v.line ? (nowMs >= g.kickoffMs ? 'In progress' : 'Frozen') : 'Frozen, line pending')
        : 'Open until ' + fmtTime_(v.freezeAtMs, tzs[0].tz);
    const vals = v.line ? v.line.values : null;
    const picks = v.players.map(function (pv) {
      if (!pv.visible) return pv.hasPick ? 'picked' : '';
      if (!pv.side) return 'no pick';
      return (pv.side === 'home' ? g.home : g.away) + (pv.locked ? ' (LOCK)' : '');
    });
    const pts = v.players.map(function (pv) {
      return v.final && pv.visible && pv.score && pv.score.points !== null ? pv.score.points : '';
    });
    rows.push(tzs.map(function (t) { return fmtTime_(g.kickoffMs, t.tz); })
      .concat([teamName_(g.away) + ' (' + g.away + ')', teamName_(g.home) + ' (' + g.home + ')', status,
        lineText_(g, v.line),
        vals ? fmtPts_(vals.favWin) + ' / ' + fmtPts_(vals.favLoss) : '',
        vals ? fmtPts_(vals.dogWin) + ' / ' + fmtPts_(vals.dogLoss) : ''])
      .concat(picks)
      .concat([v.final ? g.away + ' ' + g.awayScore + ' - ' + g.homeScore + ' ' + g.home : ''])
      .concat(pts));
  });

  rows.push(['']);
  const totalRow = rows.length + 1;
  const total = new Array(width).fill('');
  total[0] = summary.complete ? 'Week total (final)' : 'Week total so far';
  players.forEach(function (p, i) { total[firstPtsCol - 1 + i] = summary.byPlayer[p.id].points; });
  rows.push(total);
  if (summary.complete) {
    const nameOf = {};
    players.forEach(function (p, i) { nameOf[p.id] = names[i]; });
    rows.push(['Winner: ' + (summary.winnerIds.length === 1 ? nameOf[summary.winnerIds[0]] : 'Tie')]);
  }

  writeBlock_(sh, rows, width);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(headerRow, 1, 1, width).setFontWeight('bold').setBackground('#e8eaf6').setWrap(true);
  sh.getRange(totalRow, 1, 1, width).setFontWeight('bold');
  sh.getRange(headerRow + 1, firstPtsCol, Math.max(1, totalRow - headerRow), players.length)
    .setNumberFormat('+0.0;-0.0;0.0');
  sh.setFrozenRows(headerRow);
  sh.autoResizeColumns(1, width);
  return sh;
}
