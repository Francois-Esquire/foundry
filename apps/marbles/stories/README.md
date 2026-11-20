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

- `src/components/ui/`: adapted termcn Tabs, Key Value, JSON, Log, Dialog, themed text, and theme, plus panels, selectable rows, actions, and the text input. Nothing in `ui/` imports views or lib.
- `src/components/blocks/`: kind badges, status labels, catalogs, run tree, inspector, overview, values, logs, help, quit confirmation, workspace header.
- `src/cli/views/dashboard.tsx`: layout and host toolbar slot.
- `src/cli/views/splash.tsx`: centered loading/ready screen.
- `src/cli/state/splash-model.ts`: startup state and snapshot counts.
- `src/cli/state/dashboard-state.ts`: dashboard state (focus, selection, expansion, queries, run filter, launch form) as a pure reducer.
- `src/cli/state/dashboard-commands.ts`: the one command table behind key handling, the footer, and keyboard help.
- `src/cli/state/use-dashboard.ts`: wires the reducer and the command table to the renderer.
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
