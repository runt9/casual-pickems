# NFL Pick'em (Google Sheets + Apps Script)

Two-player blind pick'em. Picks and lines freeze 1 hour before each kickoff; points are scored
against the frozen line with the half-point model in `src/Config.js`. The shared sheet is a
read-only view; picks live in Script Properties and only appear on the sheet once frozen.

## Files

| File | Purpose |
|---|---|
| `src/Config.js` | Every rule value: season, start week, freeze offset, multipliers, scoring constants, timezones |
| `src/Scoring.js` | Point values from a spread; scoring one pick (pure) |
| `src/Rules.js` | Freeze time, pick and lock validation (pure) |
| `src/Schedule.js` | Parse nflverse `games.csv`, merge into stored games, take line snapshots |
| `src/Store.js` | Script Properties persistence |
| `src/Model.js` | View models; the single place pick visibility is decided |
| `src/Sync.js` | 15-minute trigger: fetch, freeze, save, render |
| `src/Render.js` | Standings tab and week tabs |
| `src/WebApp.js` | `doGet` and the `api*` functions the pick page calls |
| `src/Setup.js` | Owner-only: `setup`, `printLinks`, `resetP1Link`/`resetP2Link`, `syncNow` |
| `src/Index.html` | Pick page |
| `test/` | Node tests with fake Google services (not deployed) |

Security model: any top-level function without a trailing `_` is callable from the browser via
`google.script.run`. Public surface is `doGet`, `api*`, `syncTrigger` (throttled to once a
minute), and the Setup.js functions, which reject any caller who is not the owner.

## Install

1. Create a Google Sheet in your Drive, e.g. "NFL Pick'em 2026".
2. In the sheet: **Extensions > Apps Script**.
3. Add the code. Either:
   - **By hand:** delete `Code.gs`. For each `src/*.js` file, add a Script file with the same
     name (the editor adds `.gs`) and paste the contents. Add an HTML file named `Index` and paste
     `Index.html`. In **Project Settings**, tick "Show appsscript.json manifest file in editor",
     then replace `appsscript.json` with `src/appsscript.json`.
   - **With clasp:** enable the Apps Script API at https://script.google.com/home/usersettings,
     copy the Script ID from **Project Settings**, then:
     ```
     npm i -g @google/clasp && clasp login
     mkdir pickem-clasp && cd pickem-clasp
     clasp clone <SCRIPT_ID> --rootDir .
     cp ../src/* .    # overwrite
     clasp push -f
     ```
4. **Deploy > New deployment > Web app.** Execute as: **Me**. Who has access: **Anyone**.
   Authorize when asked. Google will warn that the app is unverified; this is expected for a
   personal script (Advanced > Go to project). Copy the web app URL ending in `/exec`.
5. **Project Settings > Script Properties > Add:** `WEB_APP_URL` = that URL.
6. In the editor, select `setup` and **Run**. It creates both players, installs the 15-minute
   trigger, runs the first sync, and prints both personal links in the execution log
   (p1 = you, p2 = your friend).
7. Share the spreadsheet with your friend as **Viewer** (not Editor). Send them the p2 link
   privately. The link is their login: anyone with it can pick as them.
8. Each of you opens your link and uses "Change name".

The default `Sheet1` tab can be deleted.

## Operating notes

- **Code changes** only reach the pick page after **Deploy > Manage deployments > Edit > Version: New version**. The URL stays the same.
- **Lost or leaked link:** run `resetP2Link` (or `resetP1Link`); the old link stops working; the new one is printed in the log.
- **Force a refresh** of the sheet: run `syncNow`.
- **Sheet lag:** picks save instantly, but the sheet (including the "picked" markers) refreshes every 15 minutes.
- **Stored data:** Script Properties (Project Settings) hold all picks. You can read them there; your friend cannot.

## Rules as implemented

- A game freezes 1 hour before kickoff. After that, picks and the lock cannot change.
- The line used is the last one the sync saw **before** the freeze. With a 15-minute sync and
  nflverse updating every 20-40 minutes, it can be up to about an hour older than the true line at
  the freeze. Line moves after the freeze are ignored.
- No line available at freeze: scored as a pick'em (+5 / -1 either side).
- Kickoff changes (flexed games) move the freeze only while the game is still open.
- One optional lock per regular-season week (x2 win or loss). It can be moved while both the
  current and new game are open. No locks in the playoffs.
- Playoff multipliers: Wild Card x2, Divisional x3, Conference x4, Super Bowl x6.
- Ties score 0 (locked or not). Missed picks score 0.
- Underdog win value is capped at 20 before the lock or playoff multiplier.
- Season starts at Week 3; the Thursday Week 3 game had already frozen, so it scores 0 for both.
- Weekly and season ties are recorded as ties.
- A game that is never played (cancelled) never goes final, so its week stays "In progress".

## Tests

```
cd test
GAMES_CSV=/path/to/nflverse/games.csv node run.js
```

`run.js` covers: scoring parity with an independent Python implementation for every half-point
spread 0-30; the agreed point table; monotonicity; freeze and snapshot behavior (including line
moves after the freeze, late install, missing lines, kickoff changes); pick and lock rules; a
full Week 3 on real 2026 data; pick privacy on both the page and the sheet; a full 2025
regular season + playoff replay checked against an independent calculation; owner-only
guards; token validation; name sanitizing (including formula injection); fetch failure; and the
sync throttle. `ui.js` renders the pick page in headless Chromium against the same fakes.

Get `games.csv` from https://github.com/nflverse/nfldata/blob/master/data/games.csv
