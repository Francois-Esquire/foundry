# Spyglass developer experience

Maintainer note, excluded from the Blume site. Dated 2026-10-19. The plan for
the `feat/spyglass-dx` branch: what a person sees while Spyglass works, in
the terminal first. The first portion, the CLI's live display, landed on
2026-10-19; "What landed" records it and the decisions that shaped it.

## Where it stands

Measured on 2026-10-19 against this repository, from
`.worktrees/feat-spyglass-dx/apps/spyglass`:

- A cold `spyglass scan` of Foundry ran for more than five minutes and was
  stopped; its progress output was not captured. The warm run below shows
  what it would have printed: at most a line or two in that time.
- The warm rerun took 41 seconds and printed 25 lines: nine phase names, including
  `lenses` last, and one `internals: <package>` line per package. Nothing
  moved between lines; `analyze: 0 of 16 local reports` is the only count.
- The library already emits more than the CLI shows. `ScanProgressEvent`
  (`src/lib/scan.ts`) carries `phase` events with a detail, a `plan` event
  with the invalidations once fingerprints are known, `unit` events with
  `status`, `durationMs`, `done` and `total` per package, `internals`
  events with `index` and `total`, and `history` events. `printProgress`
  in `src/cli/spyglass.ts` prints the phase and internals kinds and drops
  the rest.
- `--format terminal` reports (`report`, `lens`, `check`, `plan`, `apply`)
  go through `src/lib/render`, which already has a theme, a width model,
  and a `text` fallback when piped. That part of the output is in good
  shape and is not the subject here.

## Direction

Spyglass should show what it is doing, at the granularity the library
already knows: which phase, which package, how many of how many, how long
each took, what was reused and what was analyzed. The vehicle is OpenTUI,
which Marbles already uses (`@opentui/core` and `@opentui/react` at
`0.5.11`, `apps/marbles/src/dashboard/terminal.tsx`).

## Ground rules

These come from [`_api.md`](./_api.md) and `reference/cli.md`, and from how
the package is built. They are not optional.

1. **The CLI is the library with formatting.** The loader renders
   `ScanProgressEvent`; it adds no event kind until the renderer has used
   every one that exists. If a count is missing, the library grows it and
   the CLI reads it.
2. **A terminal gets the loader; a pipe gets the lines.** The rich view
   appears only when stderr and stdin are both TTYs and `--quiet` is not
   given (OpenTUI guards raw mode on `setRawMode` existing, not on
   `isTTY`, and reads whatever stdin is; a piped stdin is left alone). When piped,
   the output stays exactly `discover`, then one line per phase, then
   `internals: <package>`: `test/spyglass.test.ts` asserts those lines and
   `reference/cli.md` documents them. `NO_COLOR` is respected as the
   reports respect it. stdout is untouched, so `--json` and the exit codes
   do not change.
3. **Never `process.exit()` while a renderer is live.** The loader is
   destroyed before the command's result prints or the process exits, so
   the terminal is restored on success, on failure, and on SIGINT and
   SIGTERM, whose exit codes `apply` already defines. Checked against
   `@opentui/core@0.5.11` on 2026-10-19: `destroy()` returns control and
   calls `process.exit` nowhere, so the result lines print after it and
   the existing exit codes stand. Raw mode swallows the terminal's Ctrl-C,
   and OpenTUI's own `exitOnCtrlC` only destroys the renderer, which would
   leave the scan running headless; so the loader reads the key itself,
   destroys, and raises SIGINT on the process, and does the same for a
   SIGTERM it catches. Verified under a pty: Ctrl-C exits 130 with the
   terminal reset.
4. **Pinned, matching versions.** `@opentui/*` at `0.5.11`, as Marbles has
   it; `lint:deps` fails on a drift.
5. **The published package must still install and run.** `@opentui/core`
   ships native bindings, so it is a runtime `dependency`, and
   `scripts/build.ts` externalizes it with the others; Marbles, published
   the same way, lists both OpenTUI packages and `react` under
   `dependencies`. The loader uses the Core API, so only `@opentui/core`
   was added; the viewer's React stays a `devDependency`. The build splits
   `src/cli/loader.ts` into its own chunk behind a dynamic import, so a
   piped run never loads the native bindings.
6. **One JSX runtime per file.** `tsconfig.json` sets `jsx: react-jsx` for
   the web viewer. The loader has no JSX, so nothing changed. If a later
   view uses `@opentui/react`, it carries `/** @jsxImportSource
   @opentui/react */` per file or gets its own `tsconfig` reference.
7. **The renderer draws on stderr, in the footer, and takes no input.**
   `stdout: process.stderr` works: frames went to stderr under a pty and
   stdout carried only `Dataset saved to ...`. `"main-screen"` turned out
   to render the whole terminal height, so the loader uses `screenMode:
   "split-footer"` with `footerHeight` of 8 rows (2 compact), which keeps
   the scrollback above it and scrolls it as a footer does;
   `externalOutputMode: "passthrough"` leaves stdout alone;
   `clearOnShutdown: false`, because the default teardown also cleared the
   whole screen. `useMouse: false`, `exitOnCtrlC: false`, `exitSignals:
   []`; signals are the CLI's, per rule 3.

## What landed

Each step left the tests green and the piped output unchanged; the pinned
stderr assertions in `test/spyglass.test.ts` pass as they were.

1. **`src/cli/progress.ts`**: `ScanProgress` folds `ScanProgressEvent` and
   `CollectionProgressEvent` into a snapshot (phases with durations, the
   plan's reuse and recompute counts, units active and done with each
   one's status and duration, internals index of total, history phases
   and checkpoints, the current workspace). `fold` returns the plain lines
   an event always printed, so the piped printer is a reader of the model.
   `summaryLine` writes the one line left in the scrollback. Tested in
   `test/cli/progress.test.ts` under vitest, with no OpenTUI import.
2. **A `started` unit status** in `semantics.ts`, emitted when a package's
   worker begins. The only way to say "this package is being analyzed":
   `unit` events fired on completion only. A status on an existing kind,
   inside rule 1. Nothing consumed the status exhaustively.
3. **`src/cli/loader.ts`** with the Core API: `layout` turns a snapshot
   into rows of styled segments (headline with spinner, phase and elapsed;
   phase trail with durations; a bar for packages or internals; one row
   per active package, then the latest finished; a history row); `mountLoader`
   draws rows onto any renderer; `createLoader` owns the terminal's. Tested
   in `test/loader.test.ts` under `bun test` with `createTestRenderer`, added
   to the `test` script as Marbles runs its TUI tests.
4. **Wiring in `spyglass.ts`**: `reporter` picks silent, lines, or loader;
   `reported` tears the display down before anything else prints, on
   success or failure. `scan` and `apply` get the full panel; `open` gets
   two rows (compact), since the browser is its result. `serve` scans
   nothing, so it has no progress to show; "lightweight while serving" is
   therefore `open`'s compact panel.
5. **`reference/cli.md`** describes the live display next to the piped
   lines, `--quiet`, `NO_COLOR`, and Ctrl-C.

Verified under a Python pty, replayed through a terminal emulator: the
panel draws in the bottom eight rows and updates in place; at the end it
clears and `Scanned 4 packages in 2.3s: 4 analyzed, 0 reused.` then
`Dataset saved to ...` follow. Not yet seen in a real terminal.

## Next

- Try it on this repository's cold scan and watch which packages hold the
  time; the per-unit durations now show on screen.
- Collections: the headline names the workspace, the counts accumulate;
  a header row per root may still read better.
- Later, and only if the loader earns it: the reports as live views rather
  than printed text, a `spyglass` with no arguments that stays open. Those
  belong to a separate note once rules and the viewer have moved.

## Decisions

1. **Core, not React, for the loader.** Decided 2026-10-19. The imperative
   Core API renders the loader with no JSX and no runtime `react`; versions
   stay pinned to Marbles's `0.5.11` so nothing shared drifts. React stays
   available when a view needs state and composition; the model is
   framework-free either way.
2. **"The library" here means the progress events.** `_api.md` keeps the
   export map at `.` on purpose. The branch grows what `scan` reports (the
   `started` status) and does not widen `exports`.
3. **Cold scans are shown, not yet made faster.** The loader makes the time
   visible per package and per phase; where it goes belongs to its own
   note.
