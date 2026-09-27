# NFL Pick'em (Google Sheets + Apps Script)

Blind pick'em for a small group (`CONFIG.PLAYER_COUNT`, currently 3). Picks and lines freeze 1 hour before each kickoff; points are scored
against the frozen line with the half-point model in `src/Config.js`. The shared sheet is a
read-only view; picks live in Script Properties and only appear on the sheet once frozen.

## Files

| File | Purpose |
|---|---|
| `src/Constants.js` | Closed sets of stored values: sides, score statuses, game types, line sources |
| `src/Config.js` | Every rule value: season, start week, freeze offset, multipliers, scoring constants, timezones |
| `src/Scoring.js` | Point values from a spread; scoring one pick (pure) |
| `src/Rules.js` | Freeze time, pick and lock validation (pure) |
| `src/Schedule.js` | Parse nflverse `games.csv`, merge into stored games, take line snapshots |
| `src/Store.js` | Script Properties persistence |
| `src/Model.js` | View models; the single place pick visibility is decided |
| `src/Sync.js` | 15-minute trigger: fetch, freeze, save, render |
| `src/Render.js` | Standings tab and week tabs |
| `src/WebApp.js` | `doGet` and the `api*` functions the pick page calls |
| `src/Setup.js` | Owner-only: `setup`, `addPlayer`, `printLinks`, `resetP1Link`/`resetP2Link`/`resetP3Link`, `syncNow` |
| `src/Index.html` | Pick page layout; pulls in the two files below with `include_()` |
| `src/Styles.html` | Pick page CSS |
| `src/Client.html` | Pick page JavaScript (runs in the browser; calls the `api*` functions) |
| `test/` | Node tests with fake Google services (not deployed) |

Security model: any top-level function without a trailing `_` is callable from the browser via
`google.script.run`. Public surface is `doGet`, `api*`, `syncTrigger` (throttled to once a
minute), and the Setup.js functions, which reject any caller who is not the owner.

## Install

1. Create a Google Sheet in your Drive, e.g. "NFL Pick'em 2026".
2. In the sheet: **Extensions > Apps Script**.
3. Add the code. Either:
   - **By hand:** delete `Code.gs`. For each `src/*.js` file, add a Script file with the same
     name (the editor adds `.gs`) and paste the contents. Add HTML files named `Index`, `Styles` and
     `Client` and paste the matching `.html` files. In **Project Settings**, tick "Show appsscript.json manifest file in editor",
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
6. In the editor, select `setup` and **Run**. It creates `CONFIG.PLAYER_COUNT` players, installs
   the 15-minute trigger, runs the first sync, and prints every personal link in the execution log
   (p1 = you, p2, p3 = your friends).
7. Share the spreadsheet with your friends as **Viewer** (not Editor). Send each their own link
   privately. The link is their login: anyone with it can pick as them.
8. Each of you opens your link and uses "Change name".

The default `Sheet1` tab can be deleted.

## Operating notes

- **Code changes** only reach the pick page after **Deploy > Manage deployments > Edit > Version: New version**. The URL stays the same.
- **Lost or leaked link:** run `resetP1Link`, `resetP2Link` or `resetP3Link`; the old link stops working; the new one is printed in the log.
- **Adding a player mid-season:** make sure `CONFIG.PLAYER_COUNT` allows one more, deploy, then run
  `addPlayer`. It creates the next player (e.g. p3), syncs, and prints every link; existing links do not
  change. It refuses once `CONFIG.PLAYER_COUNT` players exist, so a second run cannot add a spare.
- **Force a refresh** of the sheet: run `syncNow`.
- **Sheet lag:** picks save instantly, but the sheet (including the "picked" markers) refreshes every 15 minutes.
- **Sheet redraws** only touch tabs whose content changed, and never reorder tabs, so hiding or
  moving tabs by hand sticks. Text cells are written as plain text so Sheets does not turn values
  like "2-1" into dates. Manual edits to a tab are overwritten the next time its content changes.
- **Sync throttle:** at most one sync per minute, counting failed attempts.
- **Stored data:** Script Properties (Project Settings) hold all picks. You can read them there; your friends cannot.

## Rules as implemented

- A game freezes 1 hour before kickoff. After that, picks and the lock cannot change.
- The line used is the last one the sync saw **before** the freeze. With a 15-minute sync and
  nflverse updating every 20-40 minutes, it can be up to about an hour older than the true line at
  the freeze. Line moves after the freeze are ignored.
- No line seen before the freeze (including games that froze before the script was installed):
  scored as a pick'em (+5 / -1 either side).
- Kickoff changes (flexed games) move the freeze only while the game is still open. Freeze is
  checked against the stored kickoff before new data is applied, so a game cannot reopen.
- A game that disappears from a complete nflverse download while unfinished (cancelled, or its
  ID changed) is voided: excluded from picks, scoring and week completion. It is restored if it
  reappears. Downloads with fewer than 250 rows for the season never void anything.
- One optional lock per regular-season week (x2 win or loss). It can be moved while both the
  current and new game are open. No locks in the playoffs.
- Playoff multipliers: Wild Card x2, Divisional x3, Conference x4, Super Bowl x6.
- Ties score 0 (locked or not). Missed picks score 0.
- Underdog win value is capped at 20 before the lock or playoff multiplier.
- Season starts at Week 3; the Thursday Week 3 game had already frozen, so it scores 0 for p1 and p2.
- Weekly and season ties are recorded as ties.
- Champions: regular season, and full season including playoffs.
- A player added mid-season is not in games that froze before they were added: those are not
  missed or scored for them, show blank on the sheet, and a week that froze entirely before they
  joined leaves them out of that week's winner. The Standings tab's Playoffs
  row shows points only.

## Tests

The tests read nflverse `games.csv`, which is not in this repo. From the repo root:

```
git clone --depth 1 https://github.com/nflverse/nfldata ../nflverse/nfldata
cd test
node run.js
node ui.js
```

Both read `../nflverse/nfldata/data/games.csv` (relative to the repo root) by default; set
`GAMES_CSV` to use a different copy.

`run.js` covers: scoring parity with an independent Python implementation for every half-point
spread 0-30; the agreed point table; monotonicity; freeze and snapshot behavior (including line
moves after the freeze, late install, missing lines, kickoff changes); pick and lock rules; a
full Week 3 on real 2026 data; pick privacy on both the page and the sheet; a full 2025
regular season + playoff replay checked against an independent calculation; owner-only
guards; token validation; name sanitizing (including formula injection); fetch failure; the
sync throttle; and kickoff and freeze times on the sheet.

`ui.js` assembles the pick page the way Apps Script does, renders it in headless Chromium against
the same fakes, and checks picking, locking, clearing a pick, the no-lock banner, the other
player's status, and the frozen view. It loads Playwright from the global npm root
(`npm i -g playwright`).
