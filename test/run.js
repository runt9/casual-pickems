// node test/run.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { load, zonedToUtc } = require('./harness');

const CSV_PATH = process.env.GAMES_CSV || path.join(__dirname, '..', '..', 'nflverse', 'nfldata', 'data', 'games.csv');
const REAL_CSV = fs.readFileSync(CSV_PATH, 'utf8');
const H = 3600 * 1000;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); process.exitCode = 1; }
}

// ---------------------------------------------------------------- scoring
test('point values match the independent Python implementation for spreads 0-30', () => {
  const { ctx } = load();
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected_values.json'), 'utf8'));
  Object.entries(expected).forEach(([s, [fw, fl, dw, dl]]) => {
    for (const sign of [1, -1]) {
      const v = ctx.pointValues_(sign * Number(s));
      assert.deepStrictEqual([v.favWin, v.favLoss, v.dogWin, v.dogLoss], [fw, fl, dw, dl], 'spread ' + s);
    }
  });
});

test('point values match the table agreed in chat', () => {
  const { ctx } = load();
  const agreed = { 0: [5, -1, 5, -1], 1.5: [4.5, -1, 5.5, -1], 3: [4.5, -1.5, 6, -1], 4.5: [4, -1.5, 6.5, -1],
    6: [4, -2, 7.5, -1], 7: [4, -2, 8, -1], 8.5: [3.5, -2, 9, -1], 10: [3.5, -2.5, 10.5, -1],
    12: [3, -2.5, 13, -1], 14: [3, -2.5, 16.5, -1], 15.5: [3, -3, 19.5, -1], 16: [3, -3, 20, -1], 22: [2.5, -3, 20, -1] };
  Object.entries(agreed).forEach(([s, want]) => {
    const v = ctx.pointValues_(Number(s));
    assert.deepStrictEqual([v.favWin, v.favLoss, v.dogWin, v.dogLoss], want, 'spread ' + s);
  });
});

test('point values are monotonic and favorite is never the worse expected pick', () => {
  const { ctx } = load();
  let prev = null;
  for (let s = 0; s <= 30; s += 0.5) {
    const v = ctx.pointValues_(s);
    const p = ctx.favWinProb_(s);
    if (prev) {
      assert(v.favWin <= prev.favWin && v.favLoss <= prev.favLoss && v.dogWin >= prev.dogWin, 'monotonic at ' + s);
    }
    const favEv = p * v.favWin + (1 - p) * v.favLoss;
    const dogEv = (1 - p) * v.dogWin + p * v.dogLoss;
    if (s <= 20) assert(favEv >= dogEv - 1e-9, 'fav >= dog at ' + s);
    prev = v;
  }
});

test('scorePick_: favorite/underdog, ties, pending, no pick, lock, round multiplier, cap before multipliers', () => {
  const { ctx } = load();
  const snap = s => ({ spread: s, values: ctx.pointValues_(s) });
  const sc = o => ctx.scorePick_(Object.assign({ gameType: 'REG', locked: false }, o));
  // home favored by 3: fav +4.5/-1.5, dog +6/-1
  assert.strictEqual(sc({ side: 'home', snap: snap(3), result: 7 }).points, 4.5);
  assert.strictEqual(sc({ side: 'home', snap: snap(3), result: -3 }).points, -1.5);
  assert.strictEqual(sc({ side: 'away', snap: snap(3), result: -3 }).points, 6);
  assert.strictEqual(sc({ side: 'away', snap: snap(3), result: -3 }).upset, true);
  assert.strictEqual(sc({ side: 'away', snap: snap(3), result: 7 }).points, -1);
  // away favored (negative spread)
  assert.strictEqual(sc({ side: 'away', snap: snap(-3), result: -7 }).points, 4.5);
  assert.strictEqual(sc({ side: 'home', snap: snap(-3), result: 7 }).points, 6);
  // pick'em: both sides +5/-1, never an upset
  assert.strictEqual(sc({ side: 'away', snap: snap(0), result: -1 }).points, 5);
  assert.strictEqual(sc({ side: 'home', snap: snap(0), result: -1 }).points, -1);
  assert.strictEqual(sc({ side: 'away', snap: snap(0), result: -1 }).upset, false);
  assert.deepStrictEqual([sc({ side: 'home', snap: snap(3), result: 0 }).status, sc({ side: 'home', snap: snap(3), result: 0 }).points], ['tie', 0]);
  assert.strictEqual(sc({ side: 'home', snap: snap(3), result: 0, locked: true }).points, 0);
  assert.deepStrictEqual([sc({ side: 'home', snap: snap(3), result: null }).status, sc({ side: 'home', snap: snap(3), result: null }).points], ['pending', null]);
  assert.deepStrictEqual([sc({ side: null, snap: snap(3), result: 7 }).status, sc({ side: null, snap: snap(3), result: 7 }).points], ['nopick', 0]);
  assert.strictEqual(sc({ side: 'home', snap: snap(3), result: -3, locked: true }).points, -3);
  assert.strictEqual(sc({ side: 'home', snap: snap(3), result: 7, gameType: 'SB' }).points, 27);
  assert.strictEqual(sc({ side: 'home', snap: snap(3), result: 7, gameType: 'WC' }).points, 9);
  // cap is pre-multiplier: 17-point dog wins with a lock -> 20 * 2 = 40
  assert.strictEqual(sc({ side: 'away', snap: snap(17), result: -1, locked: true }).points, 40);
});

// ---------------------------------------------------------------- freeze and snapshot
const KICK = Date.UTC(2026, 8, 27, 17, 0); // Sun Sep 27 2026 1:00 PM ET
function row(o) {
  return Object.assign({ id: '2026_03_AAA_BBB', week: 3, type: 'REG', away: 'AAA', home: 'BBB', kickoffMs: KICK,
    spread: 3, awayScore: null, homeScore: null, result: null }, o);
}

test('Eastern kickoff parsing handles DST (Sep = EDT, Dec = EST)', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.parseKickoffMs_('2026-09-27', '13:00'), Date.UTC(2026, 8, 27, 17, 0));
  assert.strictEqual(ctx.parseKickoffMs_('2026-12-06', '13:00'), Date.UTC(2026, 11, 6, 18, 0));
  assert.strictEqual(ctx.parseKickoffMs_('2026-09-27', ''), null);
});

test('snapshot uses the last line seen before the freeze and ignores later moves', () => {
  const { ctx } = load();
  const games = {};
  ctx.mergeRows_(games, [row({ spread: 3 })], KICK - 5 * H);
  ctx.mergeRows_(games, [row({ spread: 3.5 })], KICK - 1.5 * H);
  assert.strictEqual(games['2026_03_AAA_BBB'].snap, null);
  ctx.mergeRows_(games, [row({ spread: 7 })], KICK - 0.9 * H); // first sync after freeze sees a moved line
  const g = games['2026_03_AAA_BBB'];
  assert.strictEqual(g.snap.spread, 3.5);
  assert.strictEqual(g.snap.source, 'before-freeze');
  ctx.mergeRows_(games, [row({ spread: 10, result: 4, awayScore: 20, homeScore: 24 })], KICK + 4 * H);
  assert.strictEqual(g.snap.spread, 3.5);
  assert.strictEqual(g.result, 4);
});

test('kickoff moved earlier: a line recorded after the new freeze time does not count', () => {
  const { ctx } = load();
  const games = {};
  ctx.mergeRows_(games, [row({ spread: 3 })], KICK - 2 * H);                      // seen at K-2h
  ctx.mergeRows_(games, [row({ spread: 3, kickoffMs: KICK - 1.5 * H })], KICK - 1.9 * H); // new freeze K-2.5h
  assert.deepStrictEqual([games['2026_03_AAA_BBB'].snap.spread, games['2026_03_AAA_BBB'].snap.source], [0, 'no-line']);
});

test('no line seen before the freeze scores as pick\'em, even if a line appears after', () => {
  const { ctx } = load();
  const games = {};
  ctx.mergeRows_(games, [row({ spread: 4.5 }), row({ id: 'X', spread: null })], KICK - 0.5 * H);
  assert.deepStrictEqual([games['2026_03_AAA_BBB'].snap.spread, games['2026_03_AAA_BBB'].snap.source], [0, 'no-line']);
  assert.deepStrictEqual([games.X.snap.spread, games.X.snap.source], [0, 'no-line']);
  const g2 = {};
  ctx.mergeRows_(g2, [row({ spread: null })], KICK - 3 * H);
  ctx.mergeRows_(g2, [row({ spread: 9.5 })], KICK - 0.9 * H);
  assert.strictEqual(g2['2026_03_AAA_BBB'].snap.spread, 0);
});

test('kickoff moving or going blank after the clock freeze cannot reopen the game', () => {
  const { ctx } = load();
  for (const moved of [KICK + 3 * H, null]) {
    const games = {};
    ctx.mergeRows_(games, [row({ spread: 3 })], KICK - 2 * H);
    const g = games['2026_03_AAA_BBB'];
    const mine = ctx.emptyPlayerPicks_();
    assert.throws(() => ctx.applyPick_(g, mine, 'home', KICK - 0.9 * H), /frozen/); // clock-frozen, no snapshot yet
    ctx.mergeRows_(games, [row({ spread: 7, kickoffMs: moved })], KICK - 0.8 * H);
    assert.strictEqual(g.snap.spread, 3, 'pre-freeze line kept');
    assert.strictEqual(g.kickoffMs, KICK, 'stored kickoff kept');
    assert.throws(() => ctx.applyPick_(g, mine, 'home', KICK - 0.7 * H), /frozen/);
  }
});

test('kickoff moved before the freeze moves the freeze; after the freeze it is fixed', () => {
  const { ctx } = load();
  const games = {};
  ctx.mergeRows_(games, [row({})], KICK - 3 * H);
  ctx.mergeRows_(games, [row({ kickoffMs: KICK + 3 * H })], KICK - 2 * H);
  assert.strictEqual(ctx.isFrozen_(games['2026_03_AAA_BBB'], KICK - 0.5 * H), false);
  ctx.mergeRows_(games, [row({ kickoffMs: KICK + 3 * H })], KICK + 2.5 * H);
  assert(games['2026_03_AAA_BBB'].snap);
  ctx.mergeRows_(games, [row({ kickoffMs: KICK + 9 * H })], KICK + 2.6 * H);
  assert.strictEqual(games['2026_03_AAA_BBB'].kickoffMs, KICK + 3 * H);
});

test('weeks before START_WEEK are ignored; playoff rows are kept', () => {
  const { ctx } = load();
  const games = {};
  ctx.mergeRows_(games, [row({ id: 'a', week: 2 }), row({ id: 'b', week: 3 }), row({ id: 'c', week: 19, type: 'WC' })], KICK - 5 * H);
  assert.deepStrictEqual(Object.keys(games).sort(), ['b', 'c']);
});

// ---------------------------------------------------------------- pick and lock rules
test('picks refused at and after freeze time even before a snapshot exists', () => {
  const { ctx } = load();
  const g = row({});
  const mine = ctx.emptyPlayerPicks_();
  ctx.applyPick_(g, mine, 'home', KICK - H - 1);
  assert.strictEqual(mine.picks[g.id], 'home');
  assert.throws(() => ctx.applyPick_(g, mine, 'away', KICK - H), /frozen/);
  assert.throws(() => ctx.applyPick_(g, mine, 'sideways', KICK - 2 * H), /Invalid side/);
});

test('lock rules: needs a pick, cannot move off or onto a frozen game, clearing a pick clears its lock, no playoff locks', () => {
  const { ctx } = load();
  const early = row({ id: 'e', kickoffMs: KICK });
  const late = row({ id: 'l', kickoffMs: KICK + 7 * H });
  const wk = { e: early, l: late };
  const mine = ctx.emptyPlayerPicks_();
  assert.throws(() => ctx.applyLock_(wk, 'REG', mine, 'e', KICK - 3 * H), /Pick a team/);
  ctx.applyPick_(early, mine, 'home', KICK - 3 * H);
  ctx.applyPick_(late, mine, 'away', KICK - 3 * H);
  ctx.applyLock_(wk, 'REG', mine, 'e', KICK - 3 * H);
  ctx.applyLock_(wk, 'REG', mine, 'l', KICK - 3 * H);   // move while both open
  ctx.applyLock_(wk, 'REG', mine, 'e', KICK - 3 * H);
  assert.throws(() => ctx.applyLock_(wk, 'REG', mine, 'l', KICK), /already frozen/); // lock game frozen
  const m2 = ctx.emptyPlayerPicks_();
  ctx.applyPick_(late, m2, 'away', KICK - 3 * H);
  ctx.applyPick_(early, m2, 'away', KICK - 3 * H);
  ctx.applyLock_(wk, 'REG', m2, 'l', KICK - 3 * H);
  assert.throws(() => ctx.applyLock_(wk, 'REG', m2, 'e', KICK), /frozen/);        // target frozen
  ctx.applyPick_(late, m2, null, KICK);
  assert.strictEqual(m2.lock, null);
  assert.throws(() => ctx.applyLock_(wk, 'WC', m2, 'l', KICK - 3 * H), /not used/);
});

// ---------------------------------------------------------------- end to end on the real 2026 file
function setupEnv(nowMs, opts) {
  const env = load(Object.assign({ now: nowMs, csv: REAL_CSV }, opts || {}));
  env.ctx.setup();
  const players = JSON.parse(env.store.get('players'));
  return Object.assign(env, { p1: players[0], p2: players[1] });
}

const SAT = Date.UTC(2026, 8, 26, 21, 0); // Sat Sep 26 2026 4:00 PM CDT

test('real 2026 data: Week 3 Thursday game frozen at install, Sunday games open, default week is 3', () => {
  const env = setupEnv(SAT);
  const st = env.ctx.apiGetState(env.p1.token, null);
  assert.strictEqual(st.week, 3);
  assert.strictEqual(st.weeks[0].week, 3);
  const tnf = st.games.find(g => g.id === '2026_03_ATL_GB');
  assert.strictEqual(tnf.frozen, true);
  assert.strictEqual(tnf.line.spread, 0); // no line was seen before its freeze (installed after it)
  assert.strictEqual(tnf.line.source, 'no-line');
  assert.strictEqual(tnf.final, true);
  assert.strictEqual(tnf.players[0].score.status, 'nopick');
  const open = st.games.filter(g => !g.frozen);
  assert.strictEqual(open.length, 15);
  open.forEach(g => assert.strictEqual(g.line, null, 'line hidden while open'));
  assert.strictEqual(env.net.fetches, 1);
});

test('sheet times: kickoff in both sheet timezones and the freeze time, in the real formatDate pattern', () => {
  const env = setupEnv(SAT);
  const rows = env.ss.getSheetByName('Week 3').rows();
  const tnf = rows.find(r => r && r[2] === 'Falcons (ATL)');
  assert.deepStrictEqual(tnf.slice(0, 2), ['Thu Sep 24, 7:15 PM', 'Fri Sep 25, 2:15 AM']); // 8:15 PM ET
  const early = rows.find(r => r && r[2] === 'Panthers (CAR)');
  assert.deepStrictEqual(early.slice(0, 2), ['Sun Sep 27, 12:00 PM', 'Sun Sep 27, 7:00 PM']); // 1:00 PM ET
  assert.strictEqual(early[4], 'Open until Sun Sep 27, 11:00 AM');
});

test('the freeze offset in user-facing text follows CONFIG.FREEZE_MINUTES_BEFORE_KICKOFF', () => {
  const env = load({ now: SAT, csv: REAL_CSV, config: c => { c.FREEZE_MINUTES_BEFORE_KICKOFF = 90; } });
  env.ctx.setup();
  const [p1] = JSON.parse(env.store.get('players'));
  assert.strictEqual(env.ctx.apiGetState(p1.token, 3).freezeMinutesBeforeKickoff, 90);
  assert.throws(() => env.ctx.apiSetPick(p1.token, '2026_03_ATL_GB', 'home'), /Picks closed 90 minutes before kickoff/);
  const note = env.ss.getSheetByName('Week 3').rows()[1][0];
  assert(note.includes('Picks and lines appear 90 minutes before each kickoff.'), note);
});

test('privacy: an open pick never appears in the other player\'s state or on the sheet', () => {
  const env = setupEnv(SAT);
  const { ctx, p1, p2 } = env;
  ctx.apiSetPick(p1.token, '2026_03_KC_MIA', 'home');
  ctx.apiSetLock(p1.token, 3, '2026_03_KC_MIA');
  const seen = ctx.apiGetState(p2.token, 3);
  const g = seen.games.find(x => x.id === '2026_03_KC_MIA');
  const theirs = g.players.find(p => p.id === p1.id);
  assert.deepStrictEqual(Object.keys(theirs).sort(), ['hasPick', 'id', 'plays', 'visible']);
  assert.strictEqual(theirs.hasPick, true);
  assert.strictEqual(theirs.plays, true); // an open game is always one every player is in
  seen.games.filter(x => !x.frozen).forEach(x => x.players.filter(p => p.id === p1.id).forEach(p => {
    assert(!('side' in p) && !('locked' in p) && !('score' in p), 'p1 details hidden on ' + x.id);
  }));
  assert.strictEqual(seen.myLock, null);
  assert.strictEqual(seen.totals.find(t => t.id === p1.id).points, 0);
  ctx.sync_(true);
  const sheet = env.ss.getSheetByName('Week 3').rows();
  const kcRow = sheet.find(r => r && String(r[2]).includes('KC'));
  assert(kcRow.includes('picked'));
  assert(!kcRow.some(c => String(c).includes('LOCK')));
  assert(!kcRow.some(c => /MIA$/.test(String(c)) && c !== kcRow[3]));
});

test('full week: picks, lock, freeze with a line move after the freeze, results, totals, sheet', () => {
  const env = setupEnv(SAT);
  const { ctx, p1, p2, clock, net } = env;
  // p1: all home teams, lock on KC@MIA (MIA home, KC favored by 10). p2: all away, no lock, skips one game.
  const st = ctx.apiGetState(p1.token, 3);
  st.games.filter(g => !g.frozen).forEach(g => {
    ctx.apiSetPick(p1.token, g.id, 'home');
    if (g.id !== '2026_03_PHI_CHI') ctx.apiSetPick(p2.token, g.id, 'away');
  });
  ctx.apiSetLock(p1.token, 3, '2026_03_KC_MIA');

  // Line moves after the Sunday 1 PM freeze; results arrive; clock after MNF.
  const lines = REAL_CSV.split('\n');
  const header = lines[0].split(',');
  const ci = n => header.indexOf(n);
  const scores = {};
  const moved = lines.map(l => {
    const c = l.split(',');
    if (!c[0].startsWith('2026_03_') || c[0] === '2026_03_ATL_GB') return l;
    const away = 20 + (c[0].length % 7), home = 17 + (c[0].length % 11);
    scores[c[0]] = { spread: Number(c[ci('spread_line')]), result: home - away };
    c[ci('away_score')] = away; c[ci('home_score')] = home; c[ci('result')] = home - away;
    c[ci('spread_line')] = '99';
    return c.join(',');
  }).join('\n');
  net.csv = moved;
  clock.now = Date.UTC(2026, 8, 29, 12, 0);
  ctx.sync_(true);

  const games = ctx.loadGames_();
  Object.keys(scores).forEach(id => assert.strictEqual(games[id].snap.spread, scores[id].spread, 'snapshot kept pre-freeze line for ' + id));

  // Independent recomputation of p1's total.
  let want1 = 0, want2 = 0;
  Object.entries(scores).forEach(([id, s]) => {
    const v = ctx.pointValues_(s.spread);
    const homeFav = s.spread > 0, pk = s.spread === 0;
    const homeWon = s.result > 0;
    const lock = id === '2026_03_KC_MIA' ? 2 : 1;
    if (s.result !== 0) {
      want1 += lock * (homeWon ? (homeFav || pk ? v.favWin : v.dogWin) : (homeFav || pk ? v.favLoss : v.dogLoss));
      if (id !== '2026_03_PHI_CHI') want2 += (!homeWon ? (!homeFav || pk ? v.favWin : v.dogWin) : (!homeFav || pk ? v.favLoss : v.dogLoss));
    }
  });
  const fin = ctx.apiGetState(p1.token, 3);
  assert.strictEqual(fin.complete, true);
  assert.strictEqual(fin.totals.find(t => t.id === p1.id).points, want1);
  assert.strictEqual(fin.totals.find(t => t.id === p2.id).points, want2);

  const standings = env.ss.getSheetByName('Standings').rows();
  const wk3 = standings.find(r => r && r[0] === 'Week 3');
  assert.deepStrictEqual(wk3.slice(1, 4), ['Final', want1, want2]);
  const missed = standings.find(r => r && r[0] === 'Missed picks');
  assert.deepStrictEqual(missed.slice(2, 4), [1, 2]); // p1 missed TNF; p2 missed TNF and PHI@CHI
  assert.strictEqual(env.ss.sheets[0].name, 'Standings');
});

test('historical replay (2025 regular season + playoffs) matches an independent calculation', () => {
  const csv = REAL_CSV;
  const env = load({
    now: Date.UTC(2025, 7, 1), csv,
    config: c => { c.SEASON = 2025; c.START_WEEK = 1; },
  });
  const { ctx, clock, store } = env;
  ctx.setup();
  const [p1, p2] = JSON.parse(store.get('players'));
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const games = ctx.loadGames_();
  const picks = {};
  const locks = {};
  Object.values(games).forEach(g => {
    [p1, p2].forEach(p => {
      if (rnd() < 0.05) return; // some missed picks
      const side = rnd() < 0.5 ? 'home' : 'away';
      ctx.apiSetPick(p.token, g.id, side);
      picks[p.id + g.id] = side;
    });
  });
  const weeks = [...new Set(Object.values(games).filter(g => g.type === 'REG').map(g => g.week))];
  weeks.forEach(w => [p1, p2].forEach(p => {
    const cand = Object.values(games).filter(g => g.week === w && picks[p.id + g.id]);
    const g = cand[Math.floor(rnd() * cand.length)];
    ctx.apiSetLock(p.token, w, g.id);
    locks[p.id + w] = g.id;
  }));
  assert.throws(() => ctx.apiSetLock(p1.token, 19, Object.values(games).find(g => g.week === 19).id), /not used/);

  clock.now = Date.UTC(2026, 2, 1);
  ctx.sync_(true);

  const mult = { REG: 1, WC: 2, DIV: 3, CON: 4, SB: 6 };
  const want = { [p1.id]: { REG: 0, PO: 0 }, [p2.id]: { REG: 0, PO: 0 } };
  const rows = require('./harness').parseCsv(csv);
  const h = rows[0];
  rows.slice(1).filter(r => r[h.indexOf('season')] === '2025').forEach(r => {
    const id = r[h.indexOf('game_id')], type = r[h.indexOf('game_type')], week = Number(r[h.indexOf('week')]);
    const spread = Number(r[h.indexOf('spread_line')]), result = Number(r[h.indexOf('result')]);
    const v = ctx.pointValues_(spread);
    [p1, p2].forEach(p => {
      const side = picks[p.id + id];
      if (!side || result === 0) return;
      const fav = spread > 0 ? 'home' : spread < 0 ? 'away' : side;
      const won = (result > 0 ? 'home' : 'away') === side;
      const base = won ? (side === fav ? v.favWin : v.dogWin) : (side === fav ? v.favLoss : v.dogLoss);
      const lk = type === 'REG' && locks[p.id + week] === id ? 2 : 1;
      want[p.id][type === 'REG' ? 'REG' : 'PO'] += base * lk * mult[type];
    });
  });
  const summary = ctx.seasonSummary_(ctx.loadGames_(), ctx.loadAllPicks_(), JSON.parse(store.get('players')), clock.now);
  [p1, p2].forEach(p => {
    assert.strictEqual(summary.totals[p.id].regular, want[p.id].REG, 'regular ' + p.id);
    assert.strictEqual(summary.totals[p.id].playoffs, want[p.id].PO, 'playoffs ' + p.id);
  });
  assert.strictEqual(summary.weeks.length, 22);
  assert(summary.weeks.every(w => w.complete));
  const standings = env.ss.getSheetByName('Standings').rows();
  const fullSeason = standings.find(r => r && r[0] === 'Full season');
  assert.match(fullSeason[fullSeason.length - 1], / \(champion\)$|^Tie$/);
  assert.strictEqual(env.ss.sheets.length, 23);
  // Largest stored value must stay under the per-property limit.
  const biggest = Math.max(...[...store.values()].map(v => v.length));
  assert(biggest < 9000, 'largest property ' + biggest);
  console.log('     replay totals', JSON.stringify(want), 'largest property bytes', biggest);
});

test('third player added mid-season: existing links kept, not in games frozen before joining, not a winner of earlier weeks', () => {
  const env = load({ now: Date.UTC(2025, 7, 1), csv: REAL_CSV, config: c => { c.SEASON = 2025; c.START_WEEK = 1; c.PLAYER_COUNT = 2; } });
  const { ctx, clock, store } = env;
  ctx.setup();
  const [p1, p2] = JSON.parse(store.get('players'));
  Object.values(ctx.loadGames_()).forEach(g => {
    ctx.apiSetPick(p1.token, g.id, 'home');
    ctx.apiSetPick(p2.token, g.id, 'away');
  });

  // Friday of Week 3: Weeks 1-2 final, Thursday's Week 3 game frozen, Sunday's games open.
  const joinMs = Date.UTC(2025, 8, 19, 12);
  clock.now = joinMs;
  ctx.sync_(true);
  assert.throws(() => ctx.addPlayer(), /Raise CONFIG.PLAYER_COUNT/);
  env.ctx.__exports.CONFIG.PLAYER_COUNT = 3;
  ctx.addPlayer();
  assert.throws(() => ctx.addPlayer(), /already 3 players/);
  const players = JSON.parse(store.get('players'));
  assert.deepStrictEqual(players.map(p => p.id), ['p1', 'p2', 'p3']);
  assert.deepStrictEqual(players.slice(0, 2).map(p => p.token), [p1.token, p2.token], 'existing links unchanged');
  const p3 = players[2];
  assert.strictEqual(p3.joinedAtMs, joinMs);

  const all = Object.values(ctx.loadGames_());
  const frozenBeforeJoin = all.filter(g => ctx.freezeAtMs_(g) <= joinMs);
  const openAtJoin = all.filter(g => ctx.freezeAtMs_(g) > joinMs);
  assert(frozenBeforeJoin.some(g => g.week === 3) && openAtJoin.some(g => g.week === 3), 'Week 3 is split by the join');
  openAtJoin.forEach(g => ctx.apiSetPick(p3.token, g.id, 'home'));
  assert.throws(() => ctx.apiSetPick(p3.token, frozenBeforeJoin[0].id, 'home'), /frozen/);

  clock.now = Date.UTC(2026, 2, 1);
  ctx.sync_(true);
  const summary = ctx.seasonSummary_(ctx.loadGames_(), ctx.loadAllPicks_(), players, clock.now);
  const week = n => summary.weeks.find(w => w.week === n);

  // Weeks 1-2 froze entirely before the join: p3 is not in them at all.
  [1, 2].forEach(n => {
    assert.deepStrictEqual([week(n).byPlayer.p3.played, week(n).byPlayer.p3.points, week(n).byPlayer.p3.missed], [false, 0, 0]);
    assert(!week(n).winnerIds.includes('p3'), 'p3 cannot win week ' + n);
    assert(week(n).winnerIds.length > 0);
  });
  // Week 3: p3 is in, but not in the games that froze before joining (not missed, not scored).
  assert.strictEqual(week(3).byPlayer.p3.played, true);
  assert.strictEqual(week(3).byPlayer.p3.missed, 0);
  // p3 picked the same side as p1 on every game they were in, so their points differ exactly by those games.
  const p1PointsBeforeJoin = frozenBeforeJoin.reduce((sum, g) => {
    const view = ctx.gameView_(g, ctx.loadWeekPicks_(g.week), players, clock.now, null);
    return sum + view.players.find(p => p.id === 'p1').score.points;
  }, 0);
  const totals = summary.totals;
  assert.strictEqual(totals.p3.regular + totals.p3.playoffs, totals.p1.regular + totals.p1.playoffs - p1PointsBeforeJoin);
  assert.strictEqual(totals.p3.missed, 0);

  // Sheet: blank for p3 where they were not in the game or week.
  const standings = env.ss.getSheetByName('Standings').rows();
  assert.strictEqual(standings.find(r => r && r[0] === 'Week 1')[4], '');
  const week3Rows = env.ss.getSheetByName('Week 3').rows();
  const header = week3Rows.find(r => r && r[0] === 'Kickoff (US Central)');
  const p3PickColumn = header.indexOf('Player 3 pick');
  const p1PickColumn = header.indexOf('Player 1 pick');
  const thursday = frozenBeforeJoin.find(g => g.week === 3);
  const thursdayRow = week3Rows.find(r => r && r[2] === ctx.teamName_(thursday.away) + ' (' + thursday.away + ')');
  assert.strictEqual(thursdayRow[p3PickColumn], '');
  assert.strictEqual(thursdayRow[p1PickColumn], thursday.home);
  const week1Total = env.ss.getSheetByName('Week 1').rows().find(r => r && String(r[0]).startsWith('Week total'));
  assert.strictEqual(week1Total[header.indexOf('Player 3 pts')], '');

  // Page: p3 is left out of week totals and game rows where they were not in.
  const p1Week1 = ctx.apiGetState(p1.token, 1);
  assert.deepStrictEqual(Array.from(p1Week1.totals, t => t.id), ['p1', 'p2']);
  assert(p1Week1.games.every(g => g.players.find(p => p.id === 'p3').plays === false));
  const p3Week3 = ctx.apiGetState(p3.token, 3);
  assert.deepStrictEqual(Array.from(p3Week3.totals, t => t.id), ['p1', 'p2', 'p3']);
  assert.strictEqual(p3Week3.games.find(g => g.id === thursday.id).players.find(p => p.id === 'p3').plays, false);
});

// ---------------------------------------------------------------- discord
const HOOK = 'https://discord.test/webhook';
const easternDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const dayGames = (ctx, date) => Object.values(ctx.loadGames_()).filter(g => g.kickoffMs && easternDate(g.kickoffMs) === date)
  .sort((a, b) => a.kickoffMs - b.kickoffMs);

test('discord: nothing is posted or stored while DISCORD_WEBHOOK_URL is unset', () => {
  const env = setupEnv(SAT);
  env.clock.now = Date.UTC(2026, 9, 1);
  env.ctx.sync_(true);
  assert.strictEqual(env.net.posts.length, 0);
  assert(!env.store.has('discord'));
});

test('discord reminder: 24h before a game day\'s first kickoff, names and counts only, once per day', () => {
  const env = load({ now: Date.UTC(2026, 8, 25, 12), csv: REAL_CSV });
  const { ctx, clock, store, net } = env;
  store.set('DISCORD_WEBHOOK_URL', HOOK);
  ctx.setup();
  const [p1, p2, p3] = JSON.parse(store.get('players'));
  ctx.apiSetName(p1.token, 'Al');
  ctx.apiSetName(p2.token, 'Bob');
  ctx.apiSetName(p3.token, 'Cy');
  const sunday = dayGames(ctx, '2026-09-27');
  sunday.forEach(g => ctx.apiSetPick(p1.token, g.id, 'home'));
  ctx.apiSetLock(p1.token, 3, sunday[0].id);
  ctx.apiSetPick(p2.token, sunday[0].id, 'away');
  assert.strictEqual(net.posts.length, 0, 'Thursday\'s game froze before the webhook was set up: no reminder for it');

  clock.now = sunday[0].kickoffMs - 24 * H - 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(net.posts.length, 0, 'not before 24h');

  clock.now = sunday[0].kickoffMs - 24 * H + 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(net.posts.length, 1);
  const { url, payload } = net.posts[0];
  assert.strictEqual(url, HOOK);
  assert.deepStrictEqual(payload.allowed_mentions, { parse: [] });
  const lines = payload.content.split('\n');
  assert.match(lines[0], /^Next games: first kickoff Sun Sep 27, \d+:\d\d [AP]M US Central \/ .* Central Europe\.$/);
  assert.strictEqual(lines[1], `Still to pick: Bob (${sunday.length - 1} games), Cy (${sunday.length} games)`);
  assert.strictEqual(lines[2], 'No lock this week: Bob, Cy');
  assert.strictEqual(lines.length, 3);
  const teamCodes = new Set(sunday.flatMap(g => [g.home, g.away]));
  assert(![...teamCodes].some(code => new RegExp('\\b' + code + '\\b').test(payload.content)), 'no teams, so no picks, in the post');

  clock.now += 20 * 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(net.posts.length, 1, 'one reminder per game day');

  // Monday: everyone has picked it and holds a lock, so the reminder time passes without a post.
  const monday = dayGames(ctx, '2026-09-28');
  [p2, p3].forEach(p => {
    monday.forEach(g => ctx.apiSetPick(p.token, g.id, 'away'));
    ctx.apiSetLock(p.token, 3, monday[0].id);
  });
  monday.forEach(g => ctx.apiSetPick(p1.token, g.id, 'home'));
  clock.now = monday[0].kickoffMs - 24 * H + 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(net.posts.length, 1, 'nobody missing anything: no post');
  assert(JSON.parse(store.get('discord')).remindedDays.includes('2026-09-28'));
});

test('discord results: posted when a week completes, retried after a failed post, no backlog when turned on late', () => {
  const env = load({ now: Date.UTC(2025, 7, 1), csv: REAL_CSV, config: c => { c.SEASON = 2025; c.START_WEEK = 1; } });
  const { ctx, clock, store, net } = env;
  store.set('DISCORD_WEBHOOK_URL', HOOK);
  ctx.setup();
  const [p1, p2] = JSON.parse(store.get('players'));
  Object.values(ctx.loadGames_()).forEach(g => {
    ctx.apiSetPick(p1.token, g.id, 'home');
    ctx.apiSetPick(p2.token, g.id, 'away');
  });
  const results = () => net.posts.map(p => p.payload.content).filter(text => / final: /.test(text));

  clock.now = Date.UTC(2025, 8, 10, 12); // Wednesday after Week 1
  ctx.sync_(true);
  assert.strictEqual(results().length, 1);
  const players = JSON.parse(store.get('players'));
  const summary = ctx.seasonSummary_(ctx.loadGames_(), ctx.loadAllPicks_(), players, clock.now);
  const week1 = summary.weeks.find(w => w.week === 1);
  const pts = x => (x > 0 ? '+' : '') + x;
  const [weekLine, seasonLine] = results()[0].split('\n');
  assert(weekLine.startsWith('Week 1 final: '), weekLine);
  players.forEach(p => {
    assert(weekLine.includes(`${p.name} ${pts(week1.byPlayer[p.id].points)}`), weekLine);
    assert(seasonLine.includes(`${p.name} ${pts(summary.totals[p.id].regular)}`), seasonLine);
  });
  assert(seasonLine.startsWith('Regular season: '), seasonLine);

  // Week 2 completes while Discord is failing: the sync still saves, and the post comes on the next sync.
  net.postStatus = 500;
  clock.now = Date.UTC(2025, 8, 17, 12);
  ctx.sync_(true);
  assert.strictEqual(ctx.loadSyncStatus_().ok, true);
  assert(Object.values(ctx.loadGames_()).filter(g => g.week === 2).every(g => g.snap && g.result !== null), 'Week 2 saved as final');
  assert.strictEqual(results().length, 2, 'the failed attempt was sent once');
  assert(!JSON.parse(store.get('discord')).postedWeeks.includes(2));
  net.postStatus = 204;
  clock.now += 15 * 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(results().length, 3);
  assert(results()[2].startsWith('Week 2 final: '));
  clock.now += 15 * 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(results().length, 3, 'each week posted once');

  clock.now = Date.UTC(2026, 2, 1);
  ctx.sync_(true);
  const last = results()[results().length - 1];
  assert(last.startsWith('Super Bowl final: '), last);
  assert(last.split('\n')[1].startsWith('Full season: '), last);

  // Turned on after weeks are complete: those weeks are not posted.
  const late = load({ now: Date.UTC(2025, 7, 1), csv: REAL_CSV, config: c => { c.SEASON = 2025; c.START_WEEK = 1; } });
  late.ctx.setup();
  late.clock.now = Date.UTC(2025, 10, 1);
  late.ctx.sync_(true);
  late.store.set('DISCORD_WEBHOOK_URL', HOOK);
  late.clock.now += 15 * 60 * 1000;
  late.ctx.sync_(true);
  assert.strictEqual(late.net.posts.filter(p => / final: /.test(p.payload.content)).length, 0);
  assert(JSON.parse(late.store.get('discord')).postedWeeks.includes(8));
});

// ---------------------------------------------------------------- security and input handling
test('owner-only functions refuse anonymous (web app) callers', () => {
  const env = load({ now: SAT, csv: REAL_CSV, activeUser: '' });
  assert.throws(() => env.ctx.setup(), /Owner only/);
  assert.throws(() => env.ctx.printLinks(), /Owner only/);
  assert.throws(() => env.ctx.resetP2Link(), /Owner only/);
  assert.throws(() => env.ctx.syncNow(), /Owner only/);
});

test('invalid tokens are rejected everywhere', () => {
  const env = setupEnv(SAT);
  ['', 'x', null, undefined, '00000000-0000-0000-0000-000000000000', env.p1.token + ' '].forEach(t => {
    assert.throws(() => env.ctx.apiGetState(t, 3), /not valid/);
    assert.throws(() => env.ctx.apiSetPick(t, '2026_03_KC_MIA', 'home'), /not valid/);
  });
  assert.strictEqual(env.ctx.doGet({ parameter: { t: 'nope' } }).html.includes('not valid'), true);
  assert.strictEqual(env.ctx.doGet({ parameter: { t: env.p1.token } }).template.token, env.p1.token);
});

test('names: trimmed, length-limited, unique, and formula-safe on the sheet', () => {
  const env = setupEnv(SAT);
  const { ctx, p1, p2 } = env;
  assert.strictEqual(ctx.apiSetName(p1.token, '  Runt  '), 'Runt');
  assert.throws(() => ctx.apiSetName(p2.token, 'runt'), /taken/);
  assert.throws(() => ctx.apiSetName(p2.token, '   '), /empty/);
  assert.throws(() => ctx.apiSetName(p2.token, 'x'.repeat(21)), /20 characters/);
  ctx.apiSetName(p2.token, '=IMPORTXML("x")');
  ctx.sync_(true);
  const hdr = env.ss.getSheetByName('Standings').rows().find(r => r && r[0] === 'Week');
  assert.strictEqual(hdr[3], '\'=IMPORTXML("x")');
});

test('fetch failure: games still freeze on schedule using the last line seen, and the sheet warns', () => {
  const env = setupEnv(SAT);
  const { ctx, clock, net } = env;
  net.status = 500;
  clock.now = Date.UTC(2026, 8, 27, 16, 30); // 11:30 AM CDT, after the 1 PM ET freeze
  ctx.sync_(true);
  const g = ctx.loadGames_()['2026_03_KC_MIA'];
  assert.strictEqual(g.snap.spread, -10);
  assert.strictEqual(g.snap.source, 'before-freeze');
  const top = env.ss.getSheetByName('Standings').rows()[1][0];
  assert(top.includes('WARNING'), top);
});

test('sync throttle ignores rapid repeat calls unless forced', () => {
  const env = setupEnv(SAT);
  const before = env.net.fetches;
  env.ctx.syncTrigger();
  assert.strictEqual(env.net.fetches, before);
  env.clock.now += 61 * 1000;
  env.ctx.syncTrigger();
  assert.strictEqual(env.net.fetches, before + 1);
});

// ---------------------------------------------------------------- added after code review
test('cancelled game (missing from a full download) is voided and excluded; reappearing restores it', () => {
  const env = setupEnv(SAT);
  const { ctx, p1, net, clock } = env;
  const gone = '2026_03_KC_MIA';
  ctx.apiSetPick(p1.token, gone, 'home');
  const full = REAL_CSV;
  net.csv = full.split('\n').filter(l => !l.startsWith(gone)).join('\n');
  clock.now += 2 * 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(ctx.loadGames_()[gone].void, true);
  assert(!ctx.apiGetState(p1.token, 3).games.some(g => g.id === gone));
  assert.throws(() => ctx.apiSetPick(p1.token, gone, 'away'), /Unknown game/);
  // truncated download: nothing voided
  net.csv = full.split('\n').slice(0, 50).join('\n');
  clock.now += 2 * 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(ctx.loadGames_()['2026_03_LAC_BUF'].void, false);
  net.csv = full;
  clock.now += 2 * 60 * 1000;
  ctx.sync_(true);
  assert.strictEqual(ctx.loadGames_()[gone].void, false);
  assert(ctx.apiGetState(p1.token, 3).games.some(g => g.id === gone));
});

test('standings name regular-season and full-season champions; the playoffs row never names a leader', () => {
  const env = load({ now: Date.UTC(2025, 7, 1), csv: REAL_CSV, config: c => { c.SEASON = 2025; c.START_WEEK = 1; } });
  const { ctx, clock, store } = env;
  ctx.setup();
  const [p1, p2] = JSON.parse(store.get('players'));
  Object.values(ctx.loadGames_()).forEach(g => {
    ctx.apiSetPick(p1.token, g.id, 'home');
    ctx.apiSetPick(p2.token, g.id, 'away');
  });
  const leaderCells = () => {
    const standings = env.ss.getSheetByName('Standings').rows();
    // [status, leader]: leader is the last column, after one points column per player.
    return ['Regular season', 'Playoffs', 'Full season'].map(label => {
      const row = standings.find(r => r && r[0] === label);
      return [row[1], row[row.length - 1]];
    });
  };

  clock.now = Date.UTC(2026, 0, 18, 20); // Divisional weekend: regular season final, playoffs under way
  ctx.sync_(true);
  const [regular, playoffs, full] = leaderCells();
  assert.strictEqual(regular[0], 'Final');
  assert.match(regular[1], / \(champion\)$|^Tie$/);
  assert.deepStrictEqual(playoffs, ['In progress', '']);
  assert.strictEqual(full[0], 'In progress');
  assert.match(full[1], / \(leading\)$|^Tied$/);

  clock.now = Date.UTC(2026, 2, 1);
  ctx.sync_(true);
  const [, finalPlayoffs, finalFull] = leaderCells();
  assert.deepStrictEqual(finalPlayoffs, ['Final', '']);
  assert.strictEqual(finalFull[0], 'Final');
  assert.match(finalFull[1], / \(champion\)$|^Tie$/);
});

test('a voided game does not block week completion or champions', () => {
  const env = load({ now: Date.UTC(2025, 7, 1), csv: REAL_CSV, config: c => { c.SEASON = 2025; c.START_WEEK = 1; } });
  env.ctx.setup();
  // Inject an orphan unfinished game (as if nflverse re-identified or cancelled it).
  const games = env.ctx.loadGames_();
  games.ORPHAN = Object.assign({}, games[Object.keys(games)[0]], { id: 'ORPHAN', result: null, awayScore: null, homeScore: null });
  env.ctx.saveGames_(games);
  env.clock.now = Date.UTC(2026, 2, 1);
  env.ctx.sync_(true);
  const s = env.ctx.seasonSummary_(env.ctx.loadGames_(), {}, JSON.parse(env.store.get('players')), env.clock.now);
  assert(s.weeks.every(w => w.complete));
});

test('only intended functions are publicly callable (no trailing underscore)', () => {
  const { ctx } = load();
  const pub = Object.keys(ctx).filter(k => typeof ctx[k] === 'function' && !k.endsWith('_') &&
    !['console'].includes(k) && !/^[A-Z]/.test(k)).sort();
  assert.deepStrictEqual(pub, ['addPlayer', 'apiGetState', 'apiSetLock', 'apiSetName', 'apiSetPick', 'doGet', 'printLinks',
    'resetP1Link', 'resetP2Link', 'resetP3Link', 'resetPlayerLink', 'setup', 'syncNow', 'syncTrigger'].sort());
});

test('owner-only functions also refuse a different signed-in account', () => {
  const env = load({ now: SAT, csv: REAL_CSV, activeUser: 'friend@example.com' });
  assert.throws(() => env.ctx.setup(), /Owner only/);
  assert.throws(() => env.ctx.resetP1Link(), /Owner only/);
});

test('sheet: every text cell is plain-text formatted, numbers are not; tabs ordered Standings then weeks ascending', () => {
  const env = setupEnv(SAT);
  env.ctx.apiSetName(env.p1.token, 'Runt');
  env.clock.now = Date.UTC(2026, 8, 29, 12, 0);
  env.ctx.sync_(true);
  env.ss.sheets.forEach(sh => {
    Object.entries(sh.cells).forEach(([k, v]) => {
      const f = sh.formats[k];
      if (typeof v === 'string' && v !== '') assert.strictEqual(f, '@', sh.name + ' ' + k + ' ' + v);
      else if (typeof v === 'number') assert.notStrictEqual(f, '@', sh.name + ' ' + k);
    });
  });
  const names = env.ss.sheets.map(s => s.name);
  assert.strictEqual(names[0], 'Standings');
  assert.deepStrictEqual(names.slice(1, 4), ['Week 3', 'Week 4', 'Week 5']);
  assert.strictEqual(names[names.length - 1], 'Week 18');
  const w3 = env.ss.getSheetByName('Week 3').rows();
  assert(w3.some(r => r && r.some(c => /^W \+\d/.test(String(c)))), 'point values start with a letter');
});

test('render skips unchanged tabs and never touches sheets while holding the script lock', () => {
  const env = setupEnv(SAT);
  const w5 = env.ss.getSheetByName('Week 5');
  const before = w5.paints;
  env.clock.now += 2 * 60 * 1000;
  env.ctx.sync_(true);
  assert.strictEqual(w5.paints, before, 'unchanged week not repainted');
  assert.strictEqual(env.lockState.sheetWritesWhileLocked, 0);
  assert.strictEqual(env.lockState.held, false);
});

test('throttle also applies after a failed fetch', () => {
  const env = setupEnv(SAT);
  env.net.status = 500;
  env.clock.now += 61 * 1000;
  env.ctx.syncTrigger();
  const n = env.net.fetches;
  env.clock.now += 10 * 1000;
  env.ctx.syncTrigger();
  assert.strictEqual(env.net.fetches, n);
});

test('lookups reject inherited property names as game ids', () => {
  const env = setupEnv(SAT);
  ['constructor', '__proto__', 'toString'].forEach(id => {
    assert.throws(() => env.ctx.apiSetPick(env.p1.token, id, 'home'), /Unknown game/);
    assert.throws(() => env.ctx.apiSetLock(env.p1.token, 3, id), /not in this week/);
  });
  assert.throws(() => env.ctx.apiSetLock(env.p1.token, 3, { id: 1 }), /Invalid game/);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
