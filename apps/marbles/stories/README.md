# Terminal UI stories

Marbles' terminal UI is developed with [Textbook](https://textbook.sh)
stories. From `apps/marbles`:

```sh
bun run stories
bun run stories:web
```

`stories` opens the story browser in the terminal; `stories:web` serves it in a
browser at `http://localhost:8008/`. Both load every `stories/**/*.stories.tsx` file. Stories render the
real views and components with deterministic data from `stories/fixtures/`
(`snapshot.ts` and `scenarios.ts`), which the tests share. They do not start
schedules, connect to models, or read persisted state.

Story files mirror the source they show: `stories/ui/`, `stories/blocks/`, and
`stories/layouts/` follow `src/components/`, and `stories/views/` follows
`src/cli/views/`. Titles use the same grouping (`UI/Tabs`, `Blocks/RunsBlock`,
`Layouts/Dashboard`, `Views/Dashboard`). Each state is its own story.
`stories/frame.tsx` gives a story a fixed-size themed frame, and
`stories/render-react-story.tsx` mounts React content for Textbook.

A view story reaches a state the way a user would, by pressing keys:
`stories/views/replay-keys.tsx` wraps the view in `ReplayKeys` with a replay,
`{ keys, shows }`. It presses `keys` in order into the view, then counts as
finished; `shows` is text that only the state the story describes puts on
screen, such as the search query, a dialog title, or an error message. Each
replayed key event carries `replay: true`, which tells Textbook's browser to
pass the key straight to the story instead of reading it as a browser
shortcut.

`test/stories-render.test.ts` loads every story file through Textbook's
registry and renders each story once, so a story that throws, draws nothing,
or leaves a key listener behind fails the test suite.
`test/stories-states.test.ts` renders every story that replays keys, waits
for the replay to finish, and fails unless the frame shows the replay's
`shows` text, so a story whose keys stop reaching its state fails too.

## Navigation

| Keys | Action |
| --- | --- |
| Shift+D / C / L / F / S | Show Overview / Catalog / Logs / Feed / Settings |
| 1 / 2 / 3 | Focus Triggers / Marbles on Catalog, or Runs on Overview |
| m | Focus Marbles |
| h / click marbles | Return to the Overview or Catalog list with focus |
| Tab / Shift+Tab | Move focus through Triggers, Marbles, and Runs, changing tab with it |
| Up / Down | Select rows; browse JSON or logs; scroll overview or plain output |
| Enter / Escape | Open details / return to the selected item's panel |
| Left / Right | Collapse / expand run branches; switch inspector tabs in Details |
| Space | Toggle the selected run branch or JSON node |
| a / e | Jump to an active step / failure within the current run filter |
| b | Return from step details to its run |
| / | Search the focused catalog or run list |
| Enter / Escape in search | Keep the query / clear it |
| f on a catalog item | Filter runs to the selected item |
| x | Clear all searches and the run filter |
| f in logs | Toggle follow; scrolling pauses follow |
| v / o / f / x on the Logs tab | Minimum level / source / follow / clear filters |
| Left / Right on the Settings tab | Change the theme (read-only when the host cannot save settings) |
| Page Up / Page Down | Scroll the whole inspector in short terminals |
| ? | Open keyboard help; Escape or ? closes it |
| q / Ctrl+C | Open the quit confirmation |
| Ctrl+C in the quit dialog | Quit immediately |
| Tab / Left / Right in the dialog | Choose Keep open or Quit |
| Enter / Escape in the dialog | Activate the choice / cancel |

## Composition

- `src/components/ui/`: adapted termcn Tabs, Key Value, JSON, Log, Dialog, themed text, and the theme singleton, plus panels, selectable rows, actions, the text input, and form focus. Nothing in `ui/` imports blocks or layouts.
- `src/components/blocks/`: kind badges, status labels, catalogs, run tree, run inspector, catalog details, activity details, overview, values, logs, help, quit confirmation, workspace header, search and prompt bars, work status, the dashboard footer, and setup intro details and actions. Blocks import no layouts.
- `src/components/layouts/`: chrome with `ReactNode` slots. `dashboard.tsx` arranges four regions: the header row, what sits above the body, the body (main, workspace rail, and docked or overlaid drawer), and what sits below it; `dashboardMain` gives the main region's width and whether it is shown at all (a drawer that cannot dock covers it), and the view builds the main model only when it is; `catalog.tsx` puts details beside the catalog; `feed.tsx` places the list and reader side by side or stacked; `setup-flow.tsx` is the centred framed screen; `splash.tsx` is the sparkle field behind a centred card.
- Components are presentational: props and callbacks in, rendering out. They import React, OpenTUI, other components, and `model/` types (feed and input types from `lib/`), never `cli/`; `test/components-imports.test.ts` enforces it and the layering above. Blocks that select take the selection type as a type parameter.
- `src/cli/views/dashboard.tsx`: fills the dashboard layout's regions, leaves out the body and the host toolbar while help is open; `dashboard-main.tsx` renders the main model as the feed, details, usage, catalog (`dashboard-catalog.tsx`), or overview (`dashboard-overview.tsx`); `dashboard-drawer.tsx` renders the workspaces, settings, or logs drawer.
- `src/cli/views/inspector.tsx`: the details panel; picks the inspector block for the resolved selection.
- `src/cli/views/splash.tsx`: fills the splash layout with the loading/ready card.
- `src/cli/state/splash-model.ts`: startup state and snapshot counts.
- `src/cli/state/dashboard-state.ts`: dashboard state (focus, selection, expansion, queries, run filter, launch form) as a pure reducer.
- `src/cli/state/dashboard-commands.ts`: the one command table behind key handling, the footer, and keyboard help.
- `src/cli/state/use-dashboard.ts`: wires the reducer and the command table to the renderer, and builds the model of the mounted main content, drawer, rail, and search.
- `src/cli/state/dashboard-views.ts`: which main content shows, the drawer's dock, and the overview, catalog, search, and logs models.
- `src/cli/state/feed-model.ts` and `src/cli/state/feed-answer.ts`: feed rows with their pending mark and metadata label and tone, the feed's model, and the answer section's state; `inputState` in `feed-answer.ts` is the one reading of whether a question is pending, answered, or cancelled.
- `src/cli/state/dashboard-rows.ts`: display rows for the catalog, run tree, latest, logs, and workspace lists, and the selected workspace's details.
- `src/cli/state/dashboard-metrics.ts`: run counts, success rate, spend, notes, and workflow rankings.
- `src/cli/state/inspector.ts`: the inspector subject for a resolved selection (titles, facts, breadcrumbs, and eligible actions), the mounted run tab's content, and the expanded trigger configuration.
- `src/cli/state/run-stream.ts` and `src/cli/hooks/use-run-stream.ts`: read, filter, and buffer a run's live stream.
- `src/cli/theme.ts`: theme names to palettes, and the settings panel's theme choices.
- `src/model/run-status.ts`: run status labels and tones, and the settled, active, and paused checks.
- `src/cli/state/dashboard-tree.ts`: run filtering and visible tree rows.
- `src/cli/state/dashboard-model.ts`: read-only presentation data and selection resolution.
- `src/model/`: plain JSON and log entry types shared by the data layer and `ui/`.

The host supplies a snapshot and a close callback. Components do not query state,
invoke workflows, or own the renderer. Runs have distinct IDs and contain observed
step instances with stable IDs and nested children. Definitions remain separate
from executions, so workflows and standalone steps appear before they have runs.
Only observed steps belong in the run tree; future dynamic steps are not inferred.

Inputs, results, and trigger configuration accept JSON values. Log entries carry
stable IDs and optional step IDs. Timestamps and elapsed times are display-ready
strings supplied by the host. The live CLI uses `src/cli` to map engine
records into the same views. Run `bun run start` or `bun run start -- run` for
real configuration, triggers, execution history, and shutdown. Story fixtures
remain isolated from that runtime.

## termcn source

Vendored from the [OpenTUI registry](https://termcn.dev/docs/registry) on 2026-09-22:

- `https://termcn.dev/r/opentui/badge.json`
- `https://termcn.dev/r/opentui/tabs.json`
- `https://termcn.dev/r/opentui/key-value.json`
- `https://termcn.dev/r/opentui/json.json`
- `https://termcn.dev/r/opentui/log.json`
- `https://termcn.dev/r/opentui/dialog.json`
- `https://termcn.dev/r/opentui/use-theme.json`
- `https://termcn.dev/r/opentui/theme-default.json`
- `https://termcn.dev/r/opentui/types.json`

Local adaptations use the repository's `~/` alias and Ultracite formatting. Tabs
are controlled by the host and never write terminal escape sequences. JSON uses
unambiguous paths for array items and object keys. Keyboard handlers honor focus;
logs retain their position when follow is paused. Dialog adds a modal backdrop,
scrollable body, mouse actions, and a default cancel choice on each open. Theme files live under
`components/ui`; unused provider and motion APIs are omitted.

The setup composition adapts termcn's [OpenTUI Setup Flow](https://www.termcn.dev/docs/templates/opentui/setup-flow)
and Select components. Form input uses OpenTUI input/textarea primitives, with
keyboard focus and mouse actions. Views receive snapshots and callbacks; the
live host creates configs and dispatches runs.
