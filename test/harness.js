// Loads the Apps Script sources into a Node vm context with in-memory fakes of the
// Google services they use. Test-only; not deployed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['Config.js', 'Scoring.js', 'Rules.js', 'Schedule.js', 'Store.js', 'Teams.js', 'Model.js',
  'Sync.js', 'Render.js', 'WebApp.js', 'Setup.js'];

function tzOffsetMs(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = t => Number(parts.find(p => p.type === t).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ms;
}

function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz);
  return ms;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  setValues(v) {
    if (v.length !== this.nr || v.some(row => row.length !== this.nc)) throw new Error('setValues dimension mismatch');
    v.forEach((row, i) => row.forEach((val, j) => { this.sheet.cells[(this.r + i) + ':' + (this.c + j)] = val; }));
    return this;
  }
}
['setFontSize', 'setFontWeight', 'setBackground', 'setWrap', 'setNumberFormat'].forEach(m => {
  FakeRange.prototype[m] = function () { return this; };
});

class FakeSheet {
  constructor(name) { this.name = name; this.cells = {}; }
  getName() { return this.name; }
  clear() { this.cells = {}; return this; }
  getRange(r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error('bad range ' + [r, c, nr, nc]);
    return new FakeRange(this, r, c, nr || 1, nc || 1);
  }
  setFrozenRows() { return this; }
  autoResizeColumns() { return this; }
  rows() {
    const out = [];
    Object.entries(this.cells).forEach(([k, v]) => {
      const [r, c] = k.split(':').map(Number);
      (out[r - 1] = out[r - 1] || [])[c - 1] = v;
    });
    return out;
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; this.active = null; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  setActiveSheet(s) { this.active = s; return s; }
  moveActiveSheet(i) {
    this.sheets.splice(this.sheets.indexOf(this.active), 1);
    this.sheets.splice(i - 1, 0, this.active);
  }
}

function load(opts) {
  opts = opts || {};
  const store = new Map();
  const ss = new FakeSpreadsheet();
  const logs = [];
  const clock = { now: opts.now || Date.now() };
  const session = { active: opts.activeUser === undefined ? 'owner@example.com' : opts.activeUser, effective: 'owner@example.com' };
  const net = { csv: opts.csv || '', status: 200, fetches: 0 };

  const props = {
    getProperty: k => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => { if (typeof v !== 'string') throw new Error('non-string'); store.set(k, v); },
    getProperties: () => Object.fromEntries(store),
    setProperties: (o) => { Object.entries(o).forEach(([k, v]) => store.set(k, v)); },
  };

  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: () => { net.fetches++; return { getResponseCode: () => net.status, getContentText: () => net.csv }; },
    },
    Utilities: {
      parseCsv,
      parseDate: (s, tz, fmt) => {
        if (fmt !== 'yyyy-MM-dd HH:mm') throw new Error('unexpected format ' + fmt);
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
        if (!m) throw new Error('unparseable ' + s);
        return new Date(zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz));
      },
      formatDate: (d, tz) => new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(d),
      getUuid: () => crypto.randomUUID(),
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Session: {
      getActiveUser: () => ({ getEmail: () => session.active }),
      getEffectiveUser: () => ({ getEmail: () => session.effective }),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
    },
    HtmlService: {
      createHtmlOutput: (h) => ({ html: h, setTitle() { return this; } }),
      createTemplateFromFile: (f) => ({ file: f, evaluate() { return { template: this, setTitle() { return this; }, addMetaTag() { return this; } }; } }),
    },
    Logger: { log: (...a) => logs.push(a) },
  };
  vm.createContext(ctx);
  const code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n') +
    '\n;globalThis.__exports = { CONFIG };';
  vm.runInContext(code, ctx, { filename: 'bundle.js' });
  if (opts.config) opts.config(ctx.__exports.CONFIG);
  vm.runInContext('now_ = function () { return __clock.now; };', Object.assign(ctx, { __clock: clock }));
  return { ctx, store, ss, logs, clock, session, net };
}

module.exports = { load, zonedToUtc, parseCsv };
