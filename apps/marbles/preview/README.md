# Dashboard preview

From the repository root:

```sh
bun run --cwd apps/marbles preview:ui
```

The preview uses deterministic snapshots. It does not start schedules, connect to
models, or read persisted state. The existing `marbles run` command is unchanged.

## Startup

The preview opens a centered Marbles splash. It simulates loading for 900 ms,
then shows config totals and waits for Enter or a click on "Press Enter to enter".
Counts come from the same snapshot used by the initial dashboard. This delay
belongs to `preview/startup.tsx`; `SplashView` receives loading/ready state from
its host and does not load config or start runs.

The title uses OpenTUI's ASCII font, with a compact font on narrow terminals.
Quit confirmation works on the splash too. Clicking `marbles` in the dashboard
header, or pressing `h`, returns from details or help to the dashboard while
preserving selection and filters.

## Scenarios and playback

- `[` / `]`: previous / next scenario.
- `p`: play or pause the Running scenario.
- `n`: advance one frame.
- `r`: reset to the first frame.
- Toolbar labels also respond to clicks.

Scenarios include Running, Idle, Failed, Completed, Long history, Long output,
Deep steps, and Narrow terminal. Running advances through queued, starting,
working, and completed snapshots every 1.2 seconds and stops at the last frame.
Playback starts paused. Switching scenarios resets playback and navigation;
advancing frames preserves selection and expansion.

The dashboard keeps three full-width panels visible: Triggers, Marbles, and a
larger Runs panel at the bottom. Triggers combines schedules and monitors, with
badges identifying each kind. Triggers and Marbles receive equal space; Runs
receives three shares of flexible vertical space. Panel headings show focus
shortcuts, not page tabs.

Enter or clicking a row opens a full-height details view. Escape returns to the
same selection in its dashboard panel. Marbles contains workflow and step
definitions and supports the same search, details, and run filtering controls.

The header shows the workspace and preview/live label. Scenario controls sit at
the bottom. Narrow terminal constrains the preview to 70 columns without changing
the layout. Edit `snapshot.ts` and `scenarios.ts` to explore other data and states.

## Navigation

| Keys | Action |
| --- | --- |
| 1 / 2 / 3 | Focus Triggers / Marbles / Runs |
| m | Focus Marbles |
| h / click marbles | Return to the dashboard |
| Tab / Shift+Tab | Move focus through the three dashboard panels |
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
| Page Up / Page Down | Scroll the whole inspector in short terminals |
| ? | Open keyboard help; Escape or ? closes it |
| q / Ctrl+C | Open the quit confirmation |
| Ctrl+C in the quit dialog | Quit immediately |
| Tab / Left / Right in the dialog | Choose Keep open or Quit |
| Enter / Escape in the dialog | Activate the choice / cancel |

Clicking schedule, monitor, catalog, run, or step rows opens their details.
Inspector tabs and breadcrumbs also respond to clicks. Click branch arrows to
expand independently of selection. Mouse wheel scrolling is available in panels
and the JSON viewer.

Details has Overview, Input, Output, and Logs tabs for runs and steps. JSON arrays
and objects have individually expandable nodes. Step logs include that step and
its descendants. Missing values, empty logs, and missing items have explicit
states. Errors appear in Overview and Output.

The quit dialog defaults to Keep open and supports mouse clicks. It blocks
background controls and restores the previous selection, search, and help view
when cancelled. Its warning distinguishes saved results and successful monitor
checkpoints from interrupted runs, which cannot resume. The preview closes only
the renderer. The existing live CLI still drains active runs during graceful
shutdown; immediate interruption is not wired to this UI yet.

The default palette is [Gruvbox Dark](https://github.com/morhetz/gruvbox), using
the original medium background, warm foreground, and bright accent colors.

## Composition

- `src/components/ui/`: adapted termcn Badge, Tabs, Key Value, JSON, Log, Dialog, themed text, and theme.
- `src/components/`: panels, kind badges, status labels, selectable rows, actions.
- `src/components/blocks/`: catalogs, run tree, inspector, overview, values, logs, help, quit confirmation, workspace header.
- `src/views/dashboard.tsx`: layout and host toolbar slot.
- `src/views/splash.tsx`: centered loading/ready screen.
- `src/views/splash-model.ts`: startup state and snapshot counts.
- `preview/startup.tsx`: simulated loading and explicit entry into the preview.
- `src/views/use-dashboard.ts`: focus, selection, expansion, queries, and run scope.
- `src/views/dashboard-tree.ts`: run filtering and visible tree rows.
- `src/views/dashboard-model.ts`: read-only presentation data.
- `preview/app.tsx`: scenario switching and the playback clock.

The host supplies a snapshot and a close callback. Components do not query state,
invoke workflows, or own the renderer. Runs have distinct IDs and contain observed
step instances with stable IDs and nested children. Definitions remain separate
from executions, so workflows and standalone steps appear before they have runs.
Only observed steps belong in the run tree; future dynamic steps are not inferred.

Inputs, results, and trigger configuration accept JSON values. Log entries carry
stable IDs and optional step IDs. Timestamps and elapsed times are display-ready
strings supplied by the host. The live CLI uses `src/dashboard` to map engine
records into the same views. Run `bun run start` or `bun run start -- run` for
real configuration, triggers, execution history, and shutdown. Preview scenarios
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

## Setup and manual launches

Run `bun run preview:ui --setup` to try the setup flow without writing files.
Use `--setup-error` to preview an existing-config write failure and `--load-error`
to preview a newly created config that cannot load. Use `--config-error` for the
existing-config error screen. The default preview's `]`
key cycles through empty config, steps without triggers, no run history, launch
arguments, and launch failure scenarios. Press `2`, select a definition, then
`l` to launch a simulated run. No preview action calls a model or starts a real
schedule. Search any panel with `/` to preview no matching results; `x` or the
Clear filters action restores the list.

The setup composition adapts termcn's [OpenTUI Setup Flow](https://www.termcn.dev/docs/templates/opentui/setup-flow)
and Select components. Form input uses OpenTUI input/textarea primitives, with
Gruvbox colors, keyboard focus, and mouse actions. Views receive snapshots and
callbacks; the live host creates configs and dispatches runs.
