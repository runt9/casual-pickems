/**
 * Writes the shared, view-only spreadsheet: a Standings tab and one tab per week.
 * All visibility decisions come from gameView_/weekSummary_ (Model.js).
 */

const STANDINGS_SHEET_ = 'Standings';
const POINTS_FORMAT_ = '+0.0;-0.0;0.0';

/**
 * Redraws only tabs whose content changed since the last render (tracked by a hash in
 * Script Properties), which keeps each sync fast. Tabs are created in order: Standings
 * first, then weeks ascending; later weeks (playoffs) are appended at the end. Existing
 * tabs are never reordered, so hiding or moving tabs by hand is respected.
 */
function renderSheets_(games, allPicks, players, nowMs) {
  if (!players.length) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const season = seasonSummary_(games, allPicks, players, nowMs);
  const hashes = readJson_('render', {});

  const draw = function (name, layout, index) {
    const h = hashOf_(layout);
    let sh = ss.getSheetByName(name);
    if (sh && hashes[name] === h) return;
    if (!sh) sh = index === undefined ? ss.insertSheet(name) : ss.insertSheet(name, index);
    paint_(sh, layout);
    hashes[name] = h;
  };

  draw(STANDINGS_SHEET_, standingsLayout_(season, players, nowMs), 0);
  listWeeks_(games).forEach(function (w) {
    const summary = season.weeks.filter(function (x) { return x.week === w.week; })[0];
    draw(w.label, weekLayout_(w, weekGames_(games, w.week), allPicks[w.week] || {}, players, nowMs, summary));
  });
  writeJson_('render', hashes);
}

/** 32-bit FNV-1a over the layout JSON; only used to detect changes. */
function hashOf_(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Writes a layout: {rows, width, bold:[row], header:row|null, total:row|null, frozen, pointsCells:[[row,col,nRows,nCols]]}.
 * Every string cell is formatted as plain text BEFORE writing so Sheets never reinterprets
 * values like "+4.5 / -1.5" (formula) or "2-1" (date). Numbers get a points or integer format.
 */
function paint_(sh, L) {
  sh.clear();
  const rows = L.rows.map(function (r) {
    const out = r.slice();
    while (out.length < L.width) out.push('');
    return out;
  });
  const range = sh.getRange(1, 1, rows.length, L.width);
  range.setNumberFormats(rows.map(function (r) {
    return r.map(function (v) { return typeof v === 'number' ? '0' : '@'; });
  }));
  range.setValues(rows);
  (L.pointsCells || []).forEach(function (c) { sh.getRange(c[0], c[1], c[2], c[3]).setNumberFormat(POINTS_FORMAT_); });
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  (L.bold || []).forEach(function (r) { sh.getRange(r, 1, 1, L.width).setFontWeight('bold').setBackground('#e8eaf6'); });
  if (L.total) sh.getRange(L.total, 1, 1, L.width).setFontWeight('bold');
  if (L.frozen) sh.setFrozenRows(L.frozen);
  sh.autoResizeColumns(1, L.width);
}

/**
 * Prevent user-controlled text (display names) from being parsed as a formula. Cells are
 * also formatted as plain text (paint_); this is a second guard in case that is not honored.
 */
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


function standingsLayout_(season, players, nowMs) {
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

  return {
    rows: rows, width: width, bold: bold, total: null, frozen: 0,
    pointsCells: ptsRows.map(function (r) { return [r, 3, 1, players.length]; }),
  };
}

function weekLayout_(w, games, weekPicks, players, nowMs, summary) {
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
        vals ? 'W ' + fmtPts_(vals.favWin) + ' / L ' + fmtPts_(vals.favLoss) : '',
        vals ? 'W ' + fmtPts_(vals.dogWin) + ' / L ' + fmtPts_(vals.dogLoss) : ''])
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

  return {
    rows: rows, width: width, bold: [headerRow], total: totalRow, frozen: headerRow,
    pointsCells: [[headerRow + 1, firstPtsCol, totalRow - headerRow, players.length]],
  };
}
