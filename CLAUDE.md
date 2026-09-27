# casual-pickems

Blind NFL pick'em for a small group of friends, built on Google Sheets + Apps Script. Picks are
made on a web page served by the script; the Google Sheet is a read-only shared view. The
README covers install, operation, and the rules as implemented; read it first.

Code style: `.claude/code-style-guide.md`. Read it before writing code and again before handing
it over.

## Rules (agreed with the owner; change only when the owner asks)

- Season 2026, starting Week 3, through the Super Bowl.
- Picks are blind: no spreads or point values are shown before a game freezes.
- Each game freezes 1 hour before its own kickoff. After that its picks and lock cannot change.
- The line used is the last one seen before the freeze. No line seen before the freeze = pick'em.
- Scoring is the half-point formula in `Config.js` / `Scoring.js`. Spread 0 pays +5 / -1 either
  side. Underdog win capped at 20 **before** lock and playoff multipliers. Ties and missed picks
  score 0. Points show only once a game is final.
- Optional lock, one per regular-season week, x2 win or lose. Movable while both the current and
  the new game are unfrozen. Clearing a pick clears its lock. No locks in the playoffs.
- Playoff multipliers: Wild Card x2, Divisional x3, Conference x4, Super Bowl x6.
- A player's pick and lock are hidden from everyone else (page and sheet) until that game
  freezes. The sheet may show "picked" before freeze; the pick page does not.
- Weekly and season ties are recorded as ties; no tiebreakers.
- Champions: regular season, and full season including playoffs.
- A player added mid-season (`addPlayer`) is not in games that froze before they joined: not
  missed, not scored, and not a contender for a week that froze entirely before they joined.

## Architecture

| Concern | Where |
|---|---|
| Every tunable value | `src/Config.js` |
| Closed sets of stored values (sides, score statuses, game types, line sources) | `src/Constants.js` |
| Point values and scoring one pick | `src/Scoring.js` |
| Freeze time, pick and lock validation | `src/Rules.js` |
| Parsing nflverse, freezing, line snapshot, voiding cancelled games | `src/Schedule.js` |
| Who can see which pick (single owner of visibility) | `src/Model.js` `gameView_` |
| Who can call what | `src/WebApp.js` (`api*`, token check), `src/Setup.js` (`assertOwner_`) |
| Storage (Script Properties) | `src/Store.js` |
| 15-minute sync | `src/Sync.js` |
| Discord reminders and results | `src/Discord.js` |
| Sheet tabs | `src/Render.js` |
| Pick page | `src/Index.html` (layout), `src/Styles.html`, `src/Client.html` |

Apps Script specifics that are easy to get wrong:

- **Trailing underscore = private.** Any top-level function without one is callable from the
  browser through `google.script.run`. New server helpers must end in `_`. The public surface is
  pinned by a test ("only intended functions are publicly callable").
- All `.js` files share one global scope; load order is not guaranteed for top-level code, so keep
  top-level statements to `const` declarations and function declarations.
- The web app runs as the owner with anonymous access. The token in `?t=` is the only credential.
- Secrets live in Script Properties, never in the repo (it is public): player tokens,
  `WEB_APP_URL`, `DISCORD_WEBHOOK_URL`.
- Code changes reach the web app only after **Deploy > Manage deployments > Edit > New version**.

## Data

- nflverse `games.csv` (`https://github.com/nflverse/nfldata`). `spread_line` > 0 means the home
  team is favored; `result` is home score minus away score; `gameday`/`gametime` are US Eastern.
- Script Properties keys are documented at the top of `src/Store.js`.

## Testing

The tests read nflverse `games.csv`, which is not in this repo. From the repo root, once per
fresh checkout:

```
git clone --depth 1 https://github.com/nflverse/nfldata ../nflverse/nfldata
```

`run.js` and `ui.js` read `../nflverse/nfldata/data/games.csv` (relative to the repo root) by
default; set `GAMES_CSV` to use a different copy. `ui.js` loads Playwright from the global npm
root (`npm i -g playwright`).

```
cd test
node run.js   # unit + end-to-end on fake Google services
node ui.js    # pick page in headless Chromium
```

Both must pass before a PR. Write tests from the rules above, not from what the code currently
does. The fakes in `test/harness.js` cannot prove real Google behavior (cell formats, quotas,
`Session`, `parseCsv` speed); say so in the PR when a change depends on it.

## Workflow

- Branch and open a PR for every change; the owner reviews and deploys. Never push to `main`.
- Planned work lives in GitHub issues, not in this file or in TODO comments.
