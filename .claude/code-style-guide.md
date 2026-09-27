# Code style guide (casual-pickems)

Adapted from the owner's Kotlin style guide for this JavaScript / Apps Script project. The
principles govern; the examples do not bound them. Code that breaks a principle in a way no
example shows still breaks it.

## Change the right thing

1. **Change the existing code; do not route around it.** No wrappers, mirror types, or side
   channels added beside code that should just be changed. Report the cost of changing the
   existing thing instead of quietly adding a new one.
2. **Every piece of code earns its existence.** Delete unused parameters, no-op calls, one-call
   wrappers, knobs nothing sets, and safeguards against problems nobody has seen. Before deleting,
   find what the code protects (read the callers and the history).
3. **Tests never shape production code.** If production code has a shape only a test wants,
   change the test.
4. **One owner per piece of logic.** A rule lives in one place and every caller uses it. Example:
   pick visibility is decided only in `gameView_`; the sheet and the page both use it.
5. **One name for a value used in more than one place.** Tunables go in `Config.js`. Closed sets
   of values (sides, score statuses, game types) get a frozen constants object, not raw strings.
   These must match the server's stored values; say so where they are declared.

## Write it to be read

6. **One thing per line.** At most two boolean terms in one condition; guards one per line,
   returning early; no calls nested inside calls on one line (name the intermediate). Hard wrap at
   160 characters.
7. **Functions short and single-focused.** A longer function is fine where the logic is coupled;
   then split it into phases with blank lines and named intermediates. Do not extract a helper only
   to shorten a function.
8. **Helpers as close to their use as possible.** Inside the function that needs it first; widen to
   file level, then a shared file, only as usage widens.
9. **Show the finished output above code that builds it.** A function that builds text for a person
   has an example of the result in its comment, and builds it from named parts.
10. **Modern JavaScript.** Arrow functions, `const`/`let`, template strings, `find`, destructuring,
    `Object.freeze` for constant sets. Apps Script V8 supports these.
11. **Names say what the thing is in the domain.** No one-letter names outside trivial indexes.
    Plain words over textbook ones. Units in names where they matter (`kickoffMs`).
12. **Types are documented.** Stored and returned data shapes are described with JSDoc
    `@typedef`s; functions document parameters a caller could get wrong.

## Tests and failure

13. **Tests assert what the code should do**, written from the rules in `CLAUDE.md`, not from the
    current code. Fixtures go through the real path (the `api*` functions and `sync_`), not by
    writing stored state directly, unless the case cannot be reached otherwise.
14. **Fail fast on bad input.** Unknown values throw with a message naming the value; no silent
    defaults where absence is a defect.

## Hygiene

15. **No TODOs or commented-out code.** Open a GitHub issue; delete code instead of commenting it
    out.
16. **No noise logging.** Log what someone debugging would need.
17. **Comments explain why**, especially for non-obvious rules (why freeze is checked before new
    data, why cells are forced to plain text, why a function name ends in `_`).
